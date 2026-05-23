import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { queryRows } from "../db/client.js";

type JsonRecord = Record<string, unknown>;

export interface CompilerCacheIdentity {
  readonly cacheScope: "relation_ie_scene" | "taxonomy_temporal_unit";
  readonly namespaceId?: string | null;
  readonly sourceText: string;
  readonly sourceType?: string | null;
  readonly relationIeMode?: string | null;
  readonly extractorSignature: string;
  readonly taxonomyVersion?: string | null;
  readonly temporalVersion?: string | null;
  readonly assistantModelId?: string | null;
  readonly gliner2ModelId?: string | null;
  readonly schemaVersion: string;
  readonly promptVersion?: string | null;
}

export interface CompilerCacheWriteInput extends CompilerCacheIdentity {
  readonly status?: "success" | "rejected" | "ambiguous" | "failed";
  readonly requestPayload?: JsonRecord;
  readonly responsePayload: JsonRecord;
  readonly metrics?: JsonRecord;
}

export interface CompilerCacheEntry {
  readonly cacheKey: string;
  readonly sourceHash: string;
  readonly responsePayload: JsonRecord;
  readonly metrics: JsonRecord;
  readonly hitCount: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compilerCacheKey(identity: CompilerCacheIdentity): { readonly cacheKey: string; readonly sourceHash: string } {
  const sourceHash = sha256Text(identity.sourceText.replace(/\s+/gu, " ").trim());
  const versionPayload = {
    cacheScope: identity.cacheScope,
    sourceHash,
    sourceType: identity.sourceType ?? null,
    relationIeMode: identity.relationIeMode ?? null,
    extractorSignature: identity.extractorSignature,
    taxonomyVersion: identity.taxonomyVersion ?? null,
    temporalVersion: identity.temporalVersion ?? null,
    assistantModelId: identity.assistantModelId ?? null,
    gliner2ModelId: identity.gliner2ModelId ?? null,
    schemaVersion: identity.schemaVersion,
    promptVersion: identity.promptVersion ?? null
  };
  return {
    cacheKey: sha256Text(stableStringify(versionPayload)),
    sourceHash
  };
}

async function queryCacheRows<T extends QueryResultRow>(
  client: PoolClient | null | undefined,
  sql: string,
  values: readonly unknown[]
): Promise<readonly T[]> {
  if (client) {
    const result = await client.query<T>(sql, values as unknown[]);
    return result.rows;
  }
  return queryRows<T>(sql, values as unknown[]);
}

export async function loadCompilerCacheEntry(
  client: PoolClient | null | undefined,
  identity: CompilerCacheIdentity,
  options?: {
    readonly trackHit?: boolean;
  }
): Promise<CompilerCacheEntry | null> {
  const { cacheKey, sourceHash } = compilerCacheKey(identity);
  const trackHit = options?.trackHit ?? !client;
  const rows = await queryCacheRows<{
    readonly response_payload: JsonRecord;
    readonly metrics: JsonRecord;
    readonly hit_count: number;
  }>(
    client,
    trackHit
      ? `
          UPDATE compiler_extraction_cache
          SET hit_count = hit_count + 1,
              last_used_at = now(),
              updated_at = now()
          WHERE cache_key = $1
            AND status = 'success'
          RETURNING response_payload, metrics, hit_count
        `
      : `
          SELECT response_payload, metrics, hit_count
          FROM compiler_extraction_cache
          WHERE cache_key = $1
            AND status = 'success'
          LIMIT 1
        `,
    [cacheKey]
  );
  const row = rows[0];
  return row
    ? {
        cacheKey,
        sourceHash,
        responsePayload: row.response_payload,
        metrics: row.metrics,
        hitCount: row.hit_count
      }
    : null;
}

export async function upsertCompilerCacheEntry(
  client: PoolClient | null | undefined,
  input: CompilerCacheWriteInput
): Promise<{ readonly cacheKey: string; readonly sourceHash: string }> {
  const { cacheKey, sourceHash } = compilerCacheKey(input);
  await queryCacheRows(
    client,
    `
      INSERT INTO compiler_extraction_cache (
        cache_key, cache_scope, namespace_id, source_hash, source_type, relation_ie_mode,
        extractor_signature, taxonomy_version, temporal_version, assistant_model_id, gliner2_model_id,
        schema_version, prompt_version, status, request_payload, response_payload, metrics
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb)
      ON CONFLICT (cache_key)
      DO UPDATE SET
        namespace_id = COALESCE(EXCLUDED.namespace_id, compiler_extraction_cache.namespace_id),
        status = EXCLUDED.status,
        request_payload = EXCLUDED.request_payload,
        response_payload = EXCLUDED.response_payload,
        metrics = compiler_extraction_cache.metrics || EXCLUDED.metrics,
        updated_at = now()
    `,
    [
      cacheKey,
      input.cacheScope,
      input.namespaceId ?? null,
      sourceHash,
      input.sourceType ?? null,
      input.relationIeMode ?? null,
      input.extractorSignature,
      input.taxonomyVersion ?? null,
      input.temporalVersion ?? null,
      input.assistantModelId ?? null,
      input.gliner2ModelId ?? null,
      input.schemaVersion,
      input.promptVersion ?? null,
      input.status ?? "success",
      JSON.stringify(input.requestPayload ?? {}),
      JSON.stringify(input.responsePayload),
      JSON.stringify(input.metrics ?? {})
    ]
  );
  return { cacheKey, sourceHash };
}
