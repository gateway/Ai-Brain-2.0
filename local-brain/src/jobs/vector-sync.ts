import { withTransaction } from "../db/client.js";
import type { JobRunContext } from "./types.js";

export interface EnqueueVectorSyncOptions {
  readonly namespaceId: string;
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly limit?: number;
}

export interface EnqueueVectorSyncSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly provider: string;
  readonly model: string;
  readonly semanticQueued: number;
  readonly derivationQueued: number;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) {
    return 500;
  }

  return Math.max(1, Math.min(limit, 5000));
}

export async function enqueueVectorSyncBackfill(
  options: EnqueueVectorSyncOptions
): Promise<EnqueueVectorSyncSummary> {
  const context: JobRunContext = {
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString()
  };
  const limit = normalizeLimit(options.limit);

  return withTransaction(async (client) => {
    const semanticResult = await client.query(
      `
        INSERT INTO vector_sync_jobs (
          namespace_id,
          target_table,
          target_id,
          content_column,
          embedding_column,
          provider,
          model,
          output_dimensionality,
          metadata
        )
        SELECT
          sm.namespace_id,
          'semantic_memory',
          sm.id,
          'content_abstract',
          'embedding',
          $2::text,
          $3::text,
          $4::integer,
          jsonb_build_object(
            'source_kind', 'semantic_memory',
            'memory_kind', sm.memory_kind,
            'canonical_key', sm.canonical_key,
            'enqueue_run_id', $5::text,
            'enqueue_started_at', $6::timestamptz
          )
        FROM semantic_memory sm
        WHERE sm.namespace_id = $1
          AND sm.embedding IS NULL
          AND sm.status = 'active'
          AND sm.valid_until IS NULL
        ORDER BY sm.valid_from DESC
        LIMIT $7::int
        ON CONFLICT (target_table, target_id, provider, model, output_dimensionality)
        DO UPDATE SET
          status = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN 'pending'
            ELSE vector_sync_jobs.status
          END,
          retry_count = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN 0
            ELSE vector_sync_jobs.retry_count
          END,
          next_attempt_at = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN now()
            ELSE vector_sync_jobs.next_attempt_at
          END,
          last_error = NULL,
          last_error_at = NULL,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now(),
          metadata = vector_sync_jobs.metadata || EXCLUDED.metadata
      `,
      [
        options.namespaceId,
        options.provider,
        options.model,
        options.outputDimensionality ?? null,
        context.runId,
        context.startedAt,
        limit
      ]
    );

    const derivationResult = await client.query(
      `
        INSERT INTO vector_sync_jobs (
          namespace_id,
          target_table,
          target_id,
          content_column,
          embedding_column,
          provider,
          model,
          output_dimensionality,
          metadata
        )
        SELECT
          a.namespace_id,
          'artifact_derivations',
          ad.id,
          'content_text',
          'embedding',
          $2::text,
          $3::text,
          $4::integer,
          jsonb_build_object(
            'source_kind', 'artifact_derivation',
            'derivation_type', ad.derivation_type,
            'artifact_observation_id', ad.artifact_observation_id,
            'enqueue_run_id', $5::text,
            'enqueue_started_at', $6::timestamptz
          )
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND ad.embedding IS NULL
          AND coalesce(ad.content_text, '') <> ''
        ORDER BY ad.created_at DESC
        LIMIT $7::int
        ON CONFLICT (target_table, target_id, provider, model, output_dimensionality)
        DO UPDATE SET
          status = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN 'pending'
            ELSE vector_sync_jobs.status
          END,
          retry_count = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN 0
            ELSE vector_sync_jobs.retry_count
          END,
          next_attempt_at = CASE
            WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN now()
            ELSE vector_sync_jobs.next_attempt_at
          END,
          last_error = NULL,
          last_error_at = NULL,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now(),
          metadata = vector_sync_jobs.metadata || EXCLUDED.metadata
      `,
      [
        options.namespaceId,
        options.provider,
        options.model,
        options.outputDimensionality ?? null,
        context.runId,
        context.startedAt,
        limit
      ]
    );

    return {
      context,
      namespaceId: options.namespaceId,
      provider: options.provider,
      model: options.model,
      semanticQueued: semanticResult.rowCount ?? 0,
      derivationQueued: derivationResult.rowCount ?? 0
    };
  });
}
