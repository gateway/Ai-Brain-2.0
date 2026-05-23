import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import { expandEntityLookupCandidates, normalizeEntityLookupName, normalizeWhitespace } from "./canonicalization.js";

function normalizeName(value: string): string {
  return normalizeEntityLookupName(value);
}

function deriveSelfAliases(canonicalName: string, explicitAliases?: readonly string[]): readonly string[] {
  const values = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = normalizeWhitespace(value ?? "");
    if (normalized) {
      values.add(normalized);
    }
  };

  push(canonicalName);
  for (const alias of explicitAliases ?? []) {
    push(alias);
  }

  const parts = normalizeWhitespace(canonicalName).split(/\s+/u).filter(Boolean);
  if (parts.length > 0 && parts[0] && parts[0].length >= 3) {
    push(parts[0]);
  }

  return [...values];
}

async function ensureSelfAliases(
  client: PoolClient,
  entityId: string,
  canonicalName: string,
  explicitAliases?: readonly string[]
): Promise<void> {
  for (const alias of deriveSelfAliases(canonicalName, explicitAliases)) {
    await upsertAlias(client, entityId, alias, alias === canonicalName ? "manual" : "derived", {
      source: "self_alias_ensure"
    });
  }
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: "self",
  canonicalName: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [namespaceId, entityType, canonicalName, normalizeName(canonicalName), JSON.stringify(metadata)]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to upsert namespace self entity.");
  }

  return row.id;
}

async function upsertAlias(
  client: PoolClient,
  entityId: string,
  alias: string,
  aliasType: "manual" | "derived" | "observed",
  metadata: Record<string, unknown>
): Promise<void> {
  await client.query(
    `
      INSERT INTO entity_aliases (
        entity_id,
        alias,
        normalized_alias,
        alias_type,
        is_user_verified,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (entity_id, normalized_alias)
      DO UPDATE SET
        alias_type = EXCLUDED.alias_type,
        is_user_verified = entity_aliases.is_user_verified OR EXCLUDED.is_user_verified,
        metadata = entity_aliases.metadata || EXCLUDED.metadata
    `,
    [entityId, alias, normalizeName(alias), aliasType, aliasType === "manual", JSON.stringify(metadata)]
  );
}

export interface NamespaceSelfProfile {
  readonly namespaceId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly identityProfileId: string;
  readonly entityId: string;
  readonly metadata: Record<string, unknown>;
}

export type NamespaceSelfBindingSource =
  | "narrative_identity_claim"
  | "typed_scalar_truth"
  | "event_truth"
  | "structured_truth_binding"
  | "ops_profile";

export interface NamespaceSelfBindingMetadataInput {
  readonly note?: string;
  readonly source?: NamespaceSelfBindingSource;
  readonly confidence?: number;
  readonly evidenceCount?: number;
  readonly provenanceSummary?: string;
}

export interface ResolvedEntityReference {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly matchedVia: "canonical" | "alias" | "canonicalized";
  readonly matchedText: string;
}

function aliasTypePriority(aliasType: string | null): number {
  switch ((aliasType ?? "").toLowerCase()) {
    case "manual":
      return 0;
    case "derived":
      return 1;
    case "observed":
      return 2;
    default:
      return 3;
  }
}

async function resolveLiveEntityReferenceById(
  entityId: string
): Promise<Pick<ResolvedEntityReference, "entityId" | "canonicalName" | "entityType"> | null> {
  const rows = await queryRows<{
    readonly entity_id: string;
    readonly canonical_name: string;
    readonly entity_type: string;
  }>(
    `
      WITH RECURSIVE lineage AS (
        SELECT
          e.id,
          e.canonical_name,
          e.entity_type,
          e.merged_into_entity_id,
          0 AS depth
        FROM entities e
        WHERE e.id = $1::uuid

        UNION ALL

        SELECT
          e.id,
          e.canonical_name,
          e.entity_type,
          e.merged_into_entity_id,
          lineage.depth + 1
        FROM entities e
        JOIN lineage ON e.id = lineage.merged_into_entity_id
        WHERE lineage.merged_into_entity_id IS NOT NULL
          AND lineage.depth < 12
      )
      SELECT
        id::text AS entity_id,
        canonical_name,
        entity_type
      FROM lineage
      ORDER BY depth DESC
      LIMIT 1
    `,
    [entityId]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    entityId: row.entity_id,
    canonicalName: row.canonical_name,
    entityType: row.entity_type
  };
}

export async function resolveCanonicalEntityReference(
  namespaceId: string,
  rawName: string,
  options?: {
    readonly entityTypes?: readonly string[];
  }
): Promise<ResolvedEntityReference | null> {
  const normalizedRawName = normalizeEntityLookupName(rawName);
  const candidates = expandEntityLookupCandidates(rawName);
  if (!normalizedRawName || candidates.length === 0) {
    return null;
  }

  const entityTypes = options?.entityTypes?.length ? options.entityTypes : null;
  const rows = await queryRows<{
    readonly entity_id: string;
    readonly canonical_name: string;
    readonly entity_type: string;
    readonly normalized_name: string;
    readonly matched_alias: string | null;
    readonly match_rank: number;
    readonly alias_verified: boolean | null;
    readonly alias_type: string | null;
  }>(
    `
      WITH candidate_names AS (
        SELECT unnest($2::text[]) AS normalized_value
      )
      SELECT
        resolved.id::text AS entity_id,
        resolved.canonical_name,
        resolved.entity_type,
        resolved.normalized_name,
        matched.matched_alias,
        matched.match_rank,
        matched.alias_verified,
        matched.alias_type
      FROM (
        SELECT
          e.id AS entity_id,
          NULL::text AS matched_alias,
          0 AS match_rank,
          NULL::boolean AS alias_verified,
          NULL::text AS alias_type
        FROM entities e
        JOIN candidate_names c ON c.normalized_value = e.normalized_name
        WHERE e.namespace_id = $1
          AND ($3::text[] IS NULL OR e.entity_type = ANY($3::text[]))

        UNION ALL

        SELECT
          e.id AS entity_id,
          ea.alias AS matched_alias,
          CASE WHEN ea.normalized_alias = $4 THEN 1 ELSE 2 END AS match_rank,
          ea.is_user_verified AS alias_verified
          ,
          ea.alias_type AS alias_type
        FROM entity_aliases ea
        JOIN entities e ON e.id = ea.entity_id
        JOIN candidate_names c ON c.normalized_value = ea.normalized_alias
        WHERE e.namespace_id = $1
          AND ($3::text[] IS NULL OR e.entity_type = ANY($3::text[]))
      ) matched
      JOIN entities resolved ON resolved.id = matched.entity_id
      ORDER BY
        matched.match_rank ASC,
        CASE WHEN matched.alias_verified IS TRUE THEN 0 ELSE 1 END ASC,
        CASE
          WHEN matched.alias_type = 'manual' THEN 0
          WHEN matched.alias_type = 'derived' THEN 1
          WHEN matched.alias_type = 'observed' THEN 2
          ELSE 3
        END ASC,
        CASE WHEN resolved.normalized_name = $4 THEN 0 ELSE 1 END ASC,
        resolved.last_seen_at DESC,
        resolved.created_at ASC
      LIMIT 8
    `,
    [namespaceId, candidates, entityTypes, normalizedRawName]
  );

  const rankedRows = rows.filter((row, index, all) => all.findIndex((candidate) => candidate.entity_id === row.entity_id) === index);
  const row = rankedRows[0];
  if (!row) {
    return null;
  }

  const topAliasPriority = aliasTypePriority(row.alias_type);
  const topCanonicalExact = row.normalized_name === normalizedRawName ? 0 : 1;
  const ambiguousTopMatch = rankedRows.slice(1).some((candidate) => {
    if (candidate.entity_id === row.entity_id) {
      return false;
    }
    return (
      candidate.match_rank === row.match_rank &&
      (candidate.alias_verified === true) === (row.alias_verified === true) &&
      aliasTypePriority(candidate.alias_type) === topAliasPriority &&
      (candidate.normalized_name === normalizedRawName ? 0 : 1) === topCanonicalExact
    );
  });
  if (ambiguousTopMatch) {
    return null;
  }

  const live = await resolveLiveEntityReferenceById(row.entity_id);
  if (!live) {
    return null;
  }

  const matchedVia: ResolvedEntityReference["matchedVia"] =
    row.matched_alias === null ? (row.match_rank === 0 ? "canonical" : "canonicalized") : "alias";

  return {
    entityId: live.entityId,
    canonicalName: live.canonicalName,
    entityType: live.entityType,
    matchedVia,
    matchedText: row.matched_alias ?? row.canonical_name
  };
}

export async function loadNamespaceSelfProfileForClient(
  client: PoolClient,
  namespaceId: string
): Promise<NamespaceSelfProfile | null> {
  const profileResult = await client.query<{
    namespace_id: string;
    display_name: string;
    identity_profile_id: string;
    entity_id: string | null;
    binding_metadata: Record<string, unknown>;
    entity_metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        nsb.namespace_id,
        nsb.display_name,
        nsb.identity_profile_id::text,
        nsb.entity_id::text,
        nsb.metadata AS binding_metadata,
        e.metadata AS entity_metadata
      FROM namespace_self_bindings nsb
      LEFT JOIN entities e ON e.id = nsb.entity_id
      WHERE nsb.namespace_id = $1
      LIMIT 1
    `,
    [namespaceId]
  );

  const row = profileResult.rows[0];
  if (row) {
    let entityId = row.entity_id;
    if (!entityId) {
      entityId = await upsertEntity(client, namespaceId, "self", row.display_name, {
        source: "namespace_self_binding",
        identity_profile_id: row.identity_profile_id
      });
      await client.query(
        `
          UPDATE namespace_self_bindings
          SET entity_id = $2::uuid, updated_at = now()
          WHERE namespace_id = $1
        `,
        [namespaceId, entityId]
      );
      await client.query(
        `
          UPDATE entities
          SET identity_profile_id = $2::uuid
          WHERE id = $1::uuid
        `,
        [entityId, row.identity_profile_id]
      );
      await upsertAlias(client, entityId, row.display_name, "manual", {
        source: "namespace_self_binding"
      });
    }

    await ensureSelfAliases(client, entityId, row.display_name);

    const aliasRows = await client.query<{ alias: string }>(
      `
        SELECT alias
        FROM entity_aliases
        WHERE entity_id = $1::uuid
        ORDER BY alias
      `,
      [entityId]
    );

    return {
      namespaceId,
      canonicalName: row.display_name,
      aliases: aliasRows.rows.map((aliasRow) => aliasRow.alias),
      identityProfileId: row.identity_profile_id,
      entityId,
      metadata: {
        ...(row.binding_metadata ?? {}),
        ...(row.entity_metadata ?? {})
      }
    };
  }

  const entityResult = await client.query<{ id: string; canonical_name: string; metadata: Record<string, unknown> }>(
    `
      SELECT id::text, canonical_name, metadata
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
        AND merged_into_entity_id IS NULL
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
    [namespaceId]
  );

  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    return null;
  }

  const aliasRows = await client.query<{ alias: string }>(
    `
      SELECT alias
      FROM entity_aliases
      WHERE entity_id = $1::uuid
      ORDER BY alias
    `,
    [entityRow.id]
  );

  return {
    namespaceId,
    canonicalName: entityRow.canonical_name,
    aliases: aliasRows.rows.map((aliasRow) => aliasRow.alias),
    identityProfileId: "",
    entityId: entityRow.id,
    metadata: entityRow.metadata ?? {}
  };
}

export async function getNamespaceSelfProfile(namespaceId: string): Promise<NamespaceSelfProfile | null> {
  return withTransaction(async (client) => loadNamespaceSelfProfileForClient(client, namespaceId));
}

function buildNamespaceSelfBindingMetadata(input: NamespaceSelfBindingMetadataInput): Record<string, unknown> {
  return {
    source: input.source ?? "structured_truth_binding",
    note: input.note ?? null,
    confidence: typeof input.confidence === "number" ? input.confidence : null,
    evidence_count: Number.isFinite(input.evidenceCount) ? Math.max(0, Math.trunc(input.evidenceCount ?? 0)) : null,
    provenance_summary: input.provenanceSummary ?? null
  };
}

export async function ensureNamespaceSelfBindingForEntityId(
  namespaceId: string,
  entityId: string,
  metadata: NamespaceSelfBindingMetadataInput = {}
): Promise<NamespaceSelfProfile | null> {
  return withTransaction(async (client) => {
    const live = await resolveLiveEntityReferenceById(entityId);
    if (!live) {
      return null;
    }

    const identityProfileRows = await client.query<{ identity_profile_id: string | null }>(
      `
        SELECT identity_profile_id::text
        FROM entities
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [live.entityId]
    );

    let identityProfileId = identityProfileRows.rows[0]?.identity_profile_id ?? null;
    if (!identityProfileId) {
      const profileResult = await client.query<{ id: string }>(
        `
          INSERT INTO identity_profiles (
            profile_type,
            canonical_name,
            normalized_name,
            metadata
          )
          VALUES ('self', $1, $2, $3::jsonb)
          ON CONFLICT (profile_type, normalized_name)
          DO UPDATE SET
            canonical_name = EXCLUDED.canonical_name,
            metadata = identity_profiles.metadata || EXCLUDED.metadata,
            updated_at = now()
          RETURNING id
        `,
        [
          live.canonicalName,
          normalizeName(live.canonicalName),
          JSON.stringify(buildNamespaceSelfBindingMetadata(metadata))
        ]
      );
      identityProfileId = profileResult.rows[0]?.id ?? null;
      if (identityProfileId) {
        await client.query(
          `
            UPDATE entities
            SET identity_profile_id = $2::uuid
            WHERE id = $1::uuid
          `,
          [live.entityId, identityProfileId]
        );
      }
    }

    await client.query(
      `
        INSERT INTO namespace_self_bindings (
          namespace_id,
          identity_profile_id,
          entity_id,
          display_name,
          metadata
        )
        VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb)
        ON CONFLICT (namespace_id)
        DO UPDATE SET
          identity_profile_id = EXCLUDED.identity_profile_id,
          entity_id = EXCLUDED.entity_id,
          display_name = EXCLUDED.display_name,
          metadata = namespace_self_bindings.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        namespaceId,
        identityProfileId,
        live.entityId,
        live.canonicalName,
        JSON.stringify(buildNamespaceSelfBindingMetadata(metadata))
      ]
    );

    await ensureSelfAliases(client, live.entityId, live.canonicalName);
    return loadNamespaceSelfProfileForClient(client, namespaceId);
  });
}

export async function upsertNamespaceSelfProfileForClient(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly canonicalName: string;
    readonly aliases?: readonly string[];
    readonly note?: string;
    readonly source?: NamespaceSelfBindingSource;
    readonly confidence?: number;
    readonly evidenceCount?: number;
    readonly provenanceSummary?: string;
  }
): Promise<NamespaceSelfProfile> {
  const canonicalName = normalizeWhitespace(input.canonicalName);
  if (!canonicalName) {
    throw new Error("canonicalName is required.");
  }

  const existingBinding = await loadNamespaceSelfProfileForClient(client, input.namespaceId);
  let identityProfileId = existingBinding?.identityProfileId || "";

  if (!identityProfileId) {
    const profileResult = await client.query<{ id: string }>(
      `
        INSERT INTO identity_profiles (
          profile_type,
          canonical_name,
          normalized_name,
          metadata
        )
        VALUES ('self', $1, $2, $3::jsonb)
        ON CONFLICT (profile_type, normalized_name)
        DO UPDATE SET
          canonical_name = EXCLUDED.canonical_name,
          metadata = identity_profiles.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING id
      `,
      [
        canonicalName,
        normalizeName(canonicalName),
        JSON.stringify(
          buildNamespaceSelfBindingMetadata({
            source: input.source ?? "ops_profile",
            note: input.note,
            confidence: input.confidence,
            evidenceCount: input.evidenceCount,
            provenanceSummary: input.provenanceSummary
          })
        )
      ]
    );
    identityProfileId = profileResult.rows[0]?.id ?? "";
  }

  const exactSelfEntityResult = await client.query<{ id: string }>(
    `
      SELECT id::text
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
        AND normalized_name = $2
        AND merged_into_entity_id IS NULL
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
    [input.namespaceId, normalizeName(canonicalName)]
  );
  const exactSelfEntityId = exactSelfEntityResult.rows[0]?.id ?? null;

  const entityId =
    exactSelfEntityId ??
    existingBinding?.entityId ??
    (await upsertEntity(client, input.namespaceId, "self", canonicalName, {
      source: "ops_profile",
      identity_profile_id: identityProfileId
    }));

  await client.query(
    `
      UPDATE entities
      SET
        canonical_name = $2,
        normalized_name = $3,
        identity_profile_id = $4::uuid,
        metadata = entities.metadata || $5::jsonb,
        last_seen_at = now()
      WHERE id = $1::uuid
    `,
    [
      entityId,
      canonicalName,
      normalizeName(canonicalName),
      identityProfileId || null,
      JSON.stringify({
        self_profile_source: input.source ?? "ops_profile",
        self_profile_note: input.note ?? null,
        self_profile_confidence: typeof input.confidence === "number" ? input.confidence : null,
        self_profile_evidence_count: Number.isFinite(input.evidenceCount)
          ? Math.max(0, Math.trunc(input.evidenceCount ?? 0))
          : null,
        self_profile_provenance_summary: input.provenanceSummary ?? null
      })
    ]
  );

  await client.query(
    `
      INSERT INTO namespace_self_bindings (
        namespace_id,
        identity_profile_id,
        entity_id,
        display_name,
        metadata
      )
      VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb)
      ON CONFLICT (namespace_id)
      DO UPDATE SET
        identity_profile_id = EXCLUDED.identity_profile_id,
        entity_id = EXCLUDED.entity_id,
        display_name = EXCLUDED.display_name,
        metadata = namespace_self_bindings.metadata || EXCLUDED.metadata,
        updated_at = now()
    `,
    [
      input.namespaceId,
      identityProfileId || null,
      entityId,
      canonicalName,
      JSON.stringify(
        buildNamespaceSelfBindingMetadata({
          source: input.source ?? "ops_profile",
          note: input.note,
          confidence: input.confidence,
          evidenceCount: input.evidenceCount,
          provenanceSummary: input.provenanceSummary
        })
      )
    ]
  );

  const aliases = [...new Set([canonicalName, ...(input.aliases ?? [])].map((value) => normalizeWhitespace(value)).filter(Boolean))];
  await ensureSelfAliases(client, entityId, canonicalName, aliases);

  const profile = await loadNamespaceSelfProfileForClient(client, input.namespaceId);
  if (!profile) {
    throw new Error("Failed to load namespace self profile after upsert.");
  }

  return profile;
}

export async function upsertNamespaceSelfProfile(input: {
  readonly namespaceId: string;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly note?: string;
  readonly source?: NamespaceSelfBindingSource;
  readonly confidence?: number;
  readonly evidenceCount?: number;
  readonly provenanceSummary?: string;
}): Promise<NamespaceSelfProfile> {
  return withTransaction(async (client) => upsertNamespaceSelfProfileForClient(client, input));
}
