import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
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

export async function upsertNamespaceSelfProfileForClient(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly canonicalName: string;
    readonly aliases?: readonly string[];
    readonly note?: string;
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
        JSON.stringify({
          source: "ops_profile",
          note: input.note ?? null
        })
      ]
    );
    identityProfileId = profileResult.rows[0]?.id ?? "";
  }

  const entityId =
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
        self_profile_source: "ops_profile",
        self_profile_note: input.note ?? null
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
      JSON.stringify({
        note: input.note ?? null
      })
    ]
  );

  const aliases = [...new Set([canonicalName, ...(input.aliases ?? [])].map((value) => normalizeWhitespace(value)).filter(Boolean))];
  for (const alias of aliases) {
    await upsertAlias(client, entityId, alias, "manual", {
      source: "ops_profile"
    });
  }

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
}): Promise<NamespaceSelfProfile> {
  return withTransaction(async (client) => upsertNamespaceSelfProfileForClient(client, input));
}
