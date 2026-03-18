import { withClient, withTransaction } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";
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

export interface EnqueueTargetVectorSyncOptions {
  readonly namespaceId: string;
  readonly targetTable: "semantic_memory" | "artifact_derivations";
  readonly targetId: string;
  readonly contentColumn: "content_abstract" | "content_text";
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProcessVectorSyncOptions {
  readonly namespaceId?: string;
  readonly provider?: string;
  readonly limit?: number;
  readonly workerId?: string;
}

export interface ProcessVectorSyncResult {
  readonly workerId: string;
  readonly claimed: number;
  readonly synced: number;
  readonly failed: number;
  readonly retried: number;
}

interface ClaimedVectorSyncRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly target_table: "semantic_memory" | "artifact_derivations";
  readonly target_id: string;
  readonly content_column: "content_abstract" | "content_text";
  readonly embedding_column: string;
  readonly provider: string;
  readonly model: string;
  readonly output_dimensionality: number | null;
  readonly retry_count: number;
  readonly max_retries: number;
  readonly metadata: Record<string, unknown> | null;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) {
    return 500;
  }

  return Math.max(1, Math.min(limit, 5000));
}

function retryDelayMs(retryCount: number): number {
  const minutes = Math.min(60, 2 ** Math.max(0, retryCount));
  return minutes * 60_000;
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

export async function enqueueTargetVectorSync(
  options: EnqueueTargetVectorSyncOptions
): Promise<{ readonly jobId: string; readonly status: string }> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
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
        VALUES ($1, $2, $3, $4, 'embedding', $5, $6, $7, $8::jsonb)
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
        RETURNING id, status
      `,
      [
        options.namespaceId,
        options.targetTable,
        options.targetId,
        options.contentColumn,
        options.provider,
        options.model,
        options.outputDimensionality ?? null,
        JSON.stringify(options.metadata ?? {})
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to enqueue vector sync job");
    }

    return {
      jobId: row.id,
      status: row.status
    };
  });
}

async function claimVectorSyncJobs(
  namespaceId: string | undefined,
  provider: string | undefined,
  limit: number,
  workerId: string
): Promise<ClaimedVectorSyncRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedVectorSyncRow>(
      `
        WITH candidates AS (
          SELECT vsj.id
          FROM vector_sync_jobs vsj
          WHERE vsj.status = 'pending'
            AND vsj.next_attempt_at <= now()
            AND ($1::text IS NULL OR vsj.namespace_id = $1)
            AND ($2::text IS NULL OR vsj.provider = $2)
          ORDER BY vsj.created_at ASC
          LIMIT $3::integer
          FOR UPDATE SKIP LOCKED
        )
        UPDATE vector_sync_jobs vsj
        SET status = 'processing',
            locked_at = now(),
            locked_by = $4,
            updated_at = now()
        FROM candidates c
        WHERE vsj.id = c.id
        RETURNING
          vsj.id,
          vsj.namespace_id,
          vsj.target_table,
          vsj.target_id,
          vsj.content_column,
          vsj.embedding_column,
          vsj.provider,
          vsj.model,
          vsj.output_dimensionality,
          vsj.retry_count,
          vsj.max_retries,
          vsj.metadata
      `,
      [namespaceId ?? null, provider ?? null, limit, workerId]
    );

    return result.rows;
  });
}

async function resolveVectorSyncContent(job: ClaimedVectorSyncRow): Promise<string> {
  if (job.target_table === "semantic_memory") {
    const rows = await withClient((client) =>
      client.query<{ content_value: string | null }>(
        `
          SELECT content_abstract AS content_value
          FROM semantic_memory
          WHERE id = $1
            AND namespace_id = $2
          LIMIT 1
        `,
        [job.target_id, job.namespace_id]
      )
    );
    const value = rows.rows[0]?.content_value?.trim();
    if (!value) {
      throw new Error(`No semantic content found for vector sync target ${job.target_id}`);
    }
    return value;
  }

  if (job.target_table === "artifact_derivations") {
    const rows = await withClient((client) =>
      client.query<{ content_value: string | null }>(
        `
          SELECT ad.content_text AS content_value
          FROM artifact_derivations ad
          JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
          JOIN artifacts a ON a.id = ao.artifact_id
          WHERE ad.id = $1
            AND a.namespace_id = $2
          LIMIT 1
        `,
        [job.target_id, job.namespace_id]
      )
    );
    const value = rows.rows[0]?.content_value?.trim();
    if (!value) {
      throw new Error(`No derivation content found for vector sync target ${job.target_id}`);
    }
    return value;
  }

  throw new Error(`Unsupported vector sync target table ${job.target_table}`);
}

async function writeVectorSyncEmbedding(job: ClaimedVectorSyncRow, embedding: readonly number[]): Promise<void> {
  const vectorLiteral = `[${embedding.join(",")}]`;

  if (job.target_table === "semantic_memory") {
    await withClient((client) =>
      client.query(
        `
          UPDATE semantic_memory
          SET embedding = $2::vector,
              embedding_model = $3
          WHERE id = $1
            AND namespace_id = $4
        `,
        [job.target_id, vectorLiteral, job.model, job.namespace_id]
      )
    );
    return;
  }

  if (job.target_table === "artifact_derivations") {
    await withClient((client) =>
      client.query(
        `
          UPDATE artifact_derivations
          SET embedding = $2::vector,
              provider = COALESCE(provider, $3),
              model = COALESCE(model, $4),
              output_dimensionality = $5
          WHERE id = $1
        `,
        [job.target_id, vectorLiteral, job.provider, job.model, job.output_dimensionality ?? embedding.length]
      )
    );
    return;
  }

  throw new Error(`Unsupported vector sync target table ${job.target_table}`);
}

export async function processVectorSyncJobs(
  options: ProcessVectorSyncOptions = {}
): Promise<ProcessVectorSyncResult> {
  const workerId = options.workerId ?? `vector-sync:${crypto.randomUUID()}`;
  const jobs = await claimVectorSyncJobs(options.namespaceId, options.provider, normalizeLimit(options.limit), workerId);

  let synced = 0;
  let failed = 0;
  let retried = 0;

  for (const job of jobs) {
    try {
      const content = await resolveVectorSyncContent(job);
      const adapter = getProviderAdapter(job.provider);
      const embeddingResult = await adapter.embedText({
        text: content,
        model: job.model,
        outputDimensionality: job.output_dimensionality ?? undefined,
        metadata: {
          ...(job.metadata ?? {}),
          vector_sync_job_id: job.id,
          vector_sync_worker_id: workerId
        }
      });

      await writeVectorSyncEmbedding(job, embeddingResult.embedding);
      await withClient((client) =>
        client.query(
          `
            UPDATE vector_sync_jobs
            SET status = 'synced',
                locked_at = NULL,
                locked_by = NULL,
                updated_at = now(),
                last_error = NULL,
                last_error_at = NULL
            WHERE id = $1
          `,
          [job.id]
        )
      );
      synced += 1;
    } catch (error) {
      const nextRetryCount = job.retry_count + 1;
      const terminal = nextRetryCount >= job.max_retries || (error instanceof ProviderError && !error.retryable);
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(nextRetryCount)).toISOString();

      await withClient((client) =>
        client.query(
          `
            UPDATE vector_sync_jobs
            SET status = $2,
                retry_count = $3,
                next_attempt_at = $4,
                last_error = $5,
                last_error_at = now(),
                locked_at = NULL,
                locked_by = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [job.id, terminal ? "failed" : "pending", nextRetryCount, nextAttemptAt, error instanceof Error ? error.message : String(error)]
        )
      );

      if (terminal) {
        failed += 1;
      } else {
        retried += 1;
      }
    }
  }

  return {
    workerId,
    claimed: jobs.length,
    synced,
    failed,
    retried
  };
}
