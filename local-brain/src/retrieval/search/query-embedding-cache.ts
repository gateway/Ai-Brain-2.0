import { createHash } from "node:crypto";
import { queryRows } from "../../db/client.js";

export const QUERY_EMBEDDING_NORMALIZATION_VERSION = "query_embedding_cache_v1";

interface CachedQueryEmbeddingRow {
  readonly embedding_json: unknown;
  readonly embedding_dimensions: number;
  readonly provider: string;
  readonly model: string;
  readonly output_dimensionality: number | null;
  readonly token_usage: Record<string, unknown> | null;
  readonly provider_metadata: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface CachedQueryEmbedding {
  readonly embedding: number[];
  readonly dimensions: number;
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly tokenUsage?: Record<string, unknown>;
  readonly providerMetadata?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface QueryEmbeddingCacheIdentity {
  readonly queryHash: string;
  readonly normalizationVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
}

function normalizeEmbeddingValue(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const normalized = value
    .map((item) => (typeof item === "number" && Number.isFinite(item) ? item : null))
    .filter((item): item is number => typeof item === "number");
  return normalized.length > 0 ? normalized : null;
}

function normalizeQueryText(queryText: string): string {
  return queryText
    .normalize("NFKC")
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .replace(/[?!.]+$/u, "")
    .trim()
    .toLowerCase();
}

export function buildQueryEmbeddingCacheIdentity(params: {
  readonly queryText: string;
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
}): QueryEmbeddingCacheIdentity {
  const normalizedQuery = normalizeQueryText(params.queryText);
  return {
    queryHash: createHash("sha256").update(normalizedQuery).digest("hex"),
    normalizationVersion: QUERY_EMBEDDING_NORMALIZATION_VERSION,
    provider: params.provider,
    model: params.model,
    outputDimensionality: params.outputDimensionality
  };
}

export function runtimeQueryEmbeddingCacheKey(identity: QueryEmbeddingCacheIdentity): string {
  return [
    identity.queryHash,
    identity.normalizationVersion,
    identity.provider,
    identity.model,
    identity.outputDimensionality ?? "default"
  ].join("::");
}

export async function loadCachedQueryEmbedding(identity: QueryEmbeddingCacheIdentity): Promise<CachedQueryEmbedding | null> {
  const rows = await queryRows<CachedQueryEmbeddingRow>(
    `
      WITH updated AS (
        UPDATE query_embedding_cache
        SET
          hit_count = hit_count + 1,
          last_used_at = now(),
          updated_at = now()
        WHERE query_hash = $1
          AND normalization_version = $2
          AND provider = $3
          AND model = $4
          AND output_dimensionality IS NOT DISTINCT FROM $5::integer
        RETURNING
          embedding_json,
          embedding_dimensions,
          provider,
          model,
          output_dimensionality,
          token_usage,
          provider_metadata,
          metadata
      )
      SELECT
        embedding_json,
        embedding_dimensions,
        provider,
        model,
        output_dimensionality,
        token_usage,
        provider_metadata,
        metadata
      FROM updated
    `,
    [
      identity.queryHash,
      identity.normalizationVersion,
      identity.provider,
      identity.model,
      identity.outputDimensionality ?? null
    ]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const embedding = normalizeEmbeddingValue(row.embedding_json);
  if (!embedding) {
    return null;
  }
  return {
    embedding,
    dimensions: Number.isFinite(row.embedding_dimensions) ? row.embedding_dimensions : embedding.length,
    provider: row.provider,
    model: row.model,
    outputDimensionality: typeof row.output_dimensionality === "number" ? row.output_dimensionality : undefined,
    tokenUsage: row.token_usage ?? undefined,
    providerMetadata: row.provider_metadata ?? undefined,
    metadata: row.metadata ?? undefined
  };
}

export async function storeCachedQueryEmbedding(params: {
  readonly identity: QueryEmbeddingCacheIdentity;
  readonly embedding: readonly number[];
  readonly dimensions: number;
  readonly tokenUsage?: Record<string, unknown>;
  readonly providerMetadata?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}): Promise<void> {
  await queryRows(
    `
      INSERT INTO query_embedding_cache (
        query_hash,
        normalization_version,
        provider,
        model,
        output_dimensionality,
        embedding_dimensions,
        embedding_json,
        token_usage,
        provider_metadata,
        metadata,
        last_used_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::integer,
        $6::integer,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        now()
      )
      ON CONFLICT (query_hash, normalization_version, provider, model, output_dimensionality)
      DO UPDATE SET
        embedding_dimensions = EXCLUDED.embedding_dimensions,
        embedding_json = EXCLUDED.embedding_json,
        token_usage = EXCLUDED.token_usage,
        provider_metadata = EXCLUDED.provider_metadata,
        metadata = query_embedding_cache.metadata || EXCLUDED.metadata,
        updated_at = now(),
        last_used_at = now()
    `,
    [
      params.identity.queryHash,
      params.identity.normalizationVersion,
      params.identity.provider,
      params.identity.model,
      params.identity.outputDimensionality ?? null,
      params.dimensions,
      JSON.stringify([...params.embedding]),
      JSON.stringify(params.tokenUsage ?? {}),
      JSON.stringify(params.providerMetadata ?? {}),
      JSON.stringify(params.metadata ?? {})
    ]
  );
}
