import { queryRows, withTransaction } from "../db/client.js";

export type SourcePrivacyActionType = "logical_delete" | "redact" | "access_label" | "retention_policy";

export interface ApplySourcePrivacyInput {
  readonly namespaceId: string;
  readonly actionType: SourcePrivacyActionType;
  readonly targetArtifactId?: string | null;
  readonly targetSourceUri?: string | null;
  readonly targetChunkId?: string | null;
  readonly redactionText?: string | null;
  readonly accessLabel?: string | null;
  readonly retentionPolicy?: string | null;
  readonly reason?: string | null;
  readonly actor?: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface SourcePrivacyOverlay {
  readonly id: string;
  readonly namespaceId: string;
  readonly actionType: SourcePrivacyActionType;
  readonly targetArtifactId: string | null;
  readonly targetSourceUri: string | null;
  readonly targetChunkId: string | null;
  readonly redactionText: string | null;
  readonly accessLabel: string | null;
  readonly retentionPolicy: string | null;
  readonly status: "active" | "reverted";
  readonly reason: string | null;
  readonly actor: string | null;
  readonly createdAt: string;
  readonly revertedAt: string | null;
}

interface SourcePrivacyOverlayRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly action_type: SourcePrivacyActionType;
  readonly target_artifact_id: string | null;
  readonly target_source_uri: string | null;
  readonly target_chunk_id: string | null;
  readonly redaction_text: string | null;
  readonly access_label: string | null;
  readonly retention_policy: string | null;
  readonly status: "active" | "reverted";
  readonly reason: string | null;
  readonly actor: string | null;
  readonly created_at: string;
  readonly reverted_at: string | null;
}

export interface SourcePrivacyStatus {
  readonly namespaceId: string;
  readonly overlays: readonly SourcePrivacyOverlay[];
  readonly auditTrail: readonly Record<string, unknown>[];
  readonly sourceTruthPolicy: string;
}

export interface SourcePrivacyEnforcementResult {
  readonly blocked: boolean;
  readonly reason: string | null;
  readonly overlays: readonly SourcePrivacyOverlay[];
}

function normalizeOverlay(row: SourcePrivacyOverlayRow): SourcePrivacyOverlay {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    actionType: row.action_type,
    targetArtifactId: row.target_artifact_id,
    targetSourceUri: row.target_source_uri,
    targetChunkId: row.target_chunk_id,
    redactionText: row.redaction_text,
    accessLabel: row.access_label,
    retentionPolicy: row.retention_policy,
    status: row.status,
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
    revertedAt: row.reverted_at
  };
}

function uniqueStrings(values: readonly (string | null | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function normalizeUri(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function applySourcePrivacyOverlay(input: ApplySourcePrivacyInput): Promise<SourcePrivacyOverlay> {
  if (!input.targetArtifactId && !input.targetSourceUri && !input.targetChunkId) {
    throw new Error("A source privacy overlay requires target_artifact_id, target_source_uri, or target_chunk_id.");
  }

  return withTransaction(async (client) => {
    const sourceUri = normalizeUri(input.targetSourceUri);
    let catalogId: string | null = null;
    if (sourceUri) {
      const catalog = await client.query<{ id: string }>(
        `
          INSERT INTO source_truth_catalog (
            namespace_id,
            artifact_id,
            source_uri,
            source_kind,
            metadata
          )
          VALUES ($1, $2::uuid, $3, 'operator_cataloged', $4::jsonb)
          ON CONFLICT (namespace_id, source_uri)
          DO UPDATE SET
            artifact_id = COALESCE(source_truth_catalog.artifact_id, EXCLUDED.artifact_id),
            updated_at = now()
          RETURNING id
        `,
        [
          input.namespaceId,
          input.targetArtifactId ?? null,
          sourceUri,
          JSON.stringify({ created_from: "source_privacy_overlay" })
        ]
      );
      catalogId = catalog.rows[0]?.id ?? null;
    }

    const overlay = await client.query<SourcePrivacyOverlayRow>(
      `
        INSERT INTO source_privacy_overlays (
          namespace_id,
          action_type,
          target_artifact_id,
          target_source_uri,
          target_chunk_id,
          redaction_text,
          access_label,
          retention_policy,
          reason,
          actor,
          source_truth_catalog_id,
          payload
        )
        VALUES ($1, $2, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10, $11::uuid, $12::jsonb)
        RETURNING
          id::text,
          namespace_id,
          action_type,
          target_artifact_id::text,
          target_source_uri,
          target_chunk_id::text,
          redaction_text,
          access_label,
          retention_policy,
          status,
          reason,
          actor,
          created_at::text,
          reverted_at::text
      `,
      [
        input.namespaceId,
        input.actionType,
        input.targetArtifactId ?? null,
        sourceUri,
        input.targetChunkId ?? null,
        input.redactionText ?? null,
        input.accessLabel ?? null,
        input.retentionPolicy ?? null,
        input.reason ?? null,
        input.actor ?? "mcp_operator",
        catalogId,
        JSON.stringify(input.payload ?? {})
      ]
    );
    const row = overlay.rows[0]!;
    await client.query(
      `
        INSERT INTO source_privacy_audit_log (
          namespace_id,
          overlay_id,
          event_type,
          actor,
          reason,
          affected_artifact_ids,
          affected_source_uris,
          affected_chunk_ids,
          payload
        )
        VALUES ($1, $2::uuid, 'created', $3, $4, $5::text[], $6::text[], $7::text[], $8::jsonb)
      `,
      [
        input.namespaceId,
        row.id,
        input.actor ?? "mcp_operator",
        input.reason ?? null,
        uniqueStrings([input.targetArtifactId]),
        uniqueStrings([sourceUri]),
        uniqueStrings([input.targetChunkId]),
        JSON.stringify({ actionType: input.actionType, rawSourcePolicy: "retain_immutable" })
      ]
    );
    return normalizeOverlay(row);
  });
}

export async function revertSourcePrivacyOverlay(params: {
  readonly namespaceId: string;
  readonly overlayId: string;
  readonly actor?: string | null;
  readonly reason?: string | null;
}): Promise<SourcePrivacyOverlay | null> {
  return withTransaction(async (client) => {
    const updated = await client.query<SourcePrivacyOverlayRow>(
      `
        UPDATE source_privacy_overlays
        SET status = 'reverted',
            reverted_at = now(),
            reverted_by = $3,
            revert_reason = $4
        WHERE namespace_id = $1
          AND id = $2::uuid
        RETURNING
          id::text,
          namespace_id,
          action_type,
          target_artifact_id::text,
          target_source_uri,
          target_chunk_id::text,
          redaction_text,
          access_label,
          retention_policy,
          status,
          reason,
          actor,
          created_at::text,
          reverted_at::text
      `,
      [params.namespaceId, params.overlayId, params.actor ?? "mcp_operator", params.reason ?? null]
    );
    const row = updated.rows[0];
    if (!row) return null;
    await client.query(
      `
        INSERT INTO source_privacy_audit_log (
          namespace_id,
          overlay_id,
          event_type,
          actor,
          reason,
          affected_artifact_ids,
          affected_source_uris,
          affected_chunk_ids,
          payload
        )
        VALUES ($1, $2::uuid, 'reverted', $3, $4, $5::text[], $6::text[], $7::text[], $8::jsonb)
      `,
      [
        params.namespaceId,
        params.overlayId,
        params.actor ?? "mcp_operator",
        params.reason ?? null,
        uniqueStrings([row.target_artifact_id]),
        uniqueStrings([row.target_source_uri]),
        uniqueStrings([row.target_chunk_id]),
        JSON.stringify({ rawSourcePolicy: "retain_immutable" })
      ]
    );
    return normalizeOverlay(row);
  });
}

export async function getSourcePrivacyStatus(params: {
  readonly namespaceId: string;
  readonly targetArtifactId?: string | null;
  readonly targetSourceUri?: string | null;
  readonly limit?: number;
}): Promise<SourcePrivacyStatus> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const overlays = await queryRows<SourcePrivacyOverlayRow>(
    `
      SELECT
        id::text,
        namespace_id,
        action_type,
        target_artifact_id::text,
        target_source_uri,
        target_chunk_id::text,
        redaction_text,
        access_label,
        retention_policy,
        status,
        reason,
        actor,
        created_at::text,
        reverted_at::text
      FROM source_privacy_overlays
      WHERE namespace_id = $1
        AND ($2::uuid IS NULL OR target_artifact_id = $2::uuid)
        AND ($3::text IS NULL OR lower(target_source_uri) = lower($3))
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [params.namespaceId, params.targetArtifactId ?? null, params.targetSourceUri ?? null, limit]
  );
  const auditTrail = await queryRows<Record<string, unknown>>(
    `
      SELECT
        id::text,
        overlay_id::text,
        event_type,
        actor,
        reason,
        query_text,
        affected_artifact_ids,
        affected_source_uris,
        affected_chunk_ids,
        payload,
        created_at::text
      FROM source_privacy_audit_log
      WHERE namespace_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [params.namespaceId, limit]
  );
  return {
    namespaceId: params.namespaceId,
    overlays: overlays.map(normalizeOverlay),
    auditTrail,
    sourceTruthPolicy: "Raw source truth is retained; privacy/delete/redaction operations are active overlays with audit and rollback visibility."
  };
}

function collectTrailRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectTrailRecords);
  const record = value as Record<string, unknown>;
  const records: Record<string, unknown>[] = [];
  if (Array.isArray(record.sourceTrail)) {
    records.push(...record.sourceTrail.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object"));
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") records.push(...collectTrailRecords(value));
  }
  return records;
}

function collectPayloadText(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

function idsFromTrail(payload: Record<string, unknown>): {
  readonly artifactIds: readonly string[];
  readonly sourceUris: readonly string[];
  readonly chunkIds: readonly string[];
} {
  const trail = collectTrailRecords(payload);
  return {
    artifactIds: uniqueStrings(trail.map((entry) => typeof entry.artifactId === "string" ? entry.artifactId : null)),
    sourceUris: uniqueStrings(trail.map((entry) => typeof entry.sourceUri === "string" ? entry.sourceUri : null)),
    chunkIds: uniqueStrings(
      trail.flatMap((entry) => Array.isArray(entry.sourceChunkIds) ? entry.sourceChunkIds : [])
        .map((value) => typeof value === "string" ? value : null)
    )
  };
}

export async function evaluateSourcePrivacyEnforcement(params: {
  readonly namespaceId: string;
  readonly queryText?: string | null;
  readonly payload: Record<string, unknown>;
}): Promise<SourcePrivacyEnforcementResult> {
  const { artifactIds, sourceUris, chunkIds } = idsFromTrail(params.payload);
  if (artifactIds.length === 0 && sourceUris.length === 0 && chunkIds.length === 0) {
    return { blocked: false, reason: null, overlays: [] };
  }

  const rows = await queryRows<SourcePrivacyOverlayRow>(
    `
      SELECT
        id::text,
        namespace_id,
        action_type,
        target_artifact_id::text,
        target_source_uri,
        target_chunk_id::text,
        redaction_text,
        access_label,
        retention_policy,
        status,
        reason,
        actor,
        created_at::text,
        reverted_at::text
      FROM source_privacy_overlays
      WHERE namespace_id = $1
        AND status = 'active'
        AND (
          (cardinality($2::uuid[]) > 0 AND target_artifact_id = ANY($2::uuid[]))
          OR (cardinality($3::text[]) > 0 AND lower(target_source_uri) IN (SELECT lower(unnest($3::text[]))))
          OR (cardinality($4::uuid[]) > 0 AND target_chunk_id = ANY($4::uuid[]))
        )
      ORDER BY created_at DESC
    `,
    [params.namespaceId, artifactIds, sourceUris, chunkIds]
  );
  const overlays = rows.map(normalizeOverlay);
  const text = collectPayloadText(params.payload);
  const blocking = overlays.filter((overlay) => {
    if (overlay.actionType === "logical_delete") return true;
    if (overlay.actionType === "access_label") return overlay.accessLabel === "private" || overlay.accessLabel === "restricted";
    if (overlay.actionType === "redact") {
      return !overlay.redactionText || text.includes(overlay.redactionText.toLowerCase());
    }
    return false;
  });
  if (blocking.length === 0) {
    return { blocked: false, reason: null, overlays };
  }
  await queryRows(
    `
      INSERT INTO source_privacy_audit_log (
        namespace_id,
        overlay_id,
        event_type,
        query_text,
        affected_artifact_ids,
        affected_source_uris,
        affected_chunk_ids,
        payload
      )
      VALUES ($1, $2::uuid, 'enforced', $3, $4::text[], $5::text[], $6::text[], $7::jsonb)
    `,
    [
      params.namespaceId,
      blocking[0]!.id,
      params.queryText ?? null,
      artifactIds,
      sourceUris,
      chunkIds,
      JSON.stringify({ blockedOverlayCount: blocking.length })
    ]
  );
  return {
    blocked: true,
    reason: `source_privacy_${blocking[0]!.actionType}`,
    overlays: blocking
  };
}
