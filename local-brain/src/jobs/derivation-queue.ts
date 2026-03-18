import type { PoolClient } from "pg";
import { withClient, withTransaction } from "../db/client.js";
import { deriveArtifactViaProvider } from "../derivations/service.js";
import { ProviderError } from "../providers/types.js";
import type { ProviderModality } from "../providers/types.js";

export type DerivationJobKind = "ocr" | "transcription" | "caption" | "summary" | "derive_text" | "embed";
export type DerivationJobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

export interface DerivationJobRequest {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly artifactObservationId?: string;
  readonly sourceChunkId?: string;
  readonly jobKind?: DerivationJobKind;
  readonly modality?: ProviderModality;
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface DerivationJobResult {
  readonly jobId: string;
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly artifactObservationId: string;
  readonly sourceChunkId?: string;
  readonly jobKind: DerivationJobKind;
  readonly modality: ProviderModality;
  readonly provider?: string;
  readonly model?: string;
  readonly status: DerivationJobStatus;
}

export interface ProcessDerivationJobsOptions {
  readonly namespaceId?: string;
  readonly provider?: string;
  readonly limit?: number;
  readonly workerId?: string;
}

export interface ProcessDerivationJobsResult {
  readonly workerId: string;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly retried: number;
}

interface ArtifactContextRow {
  readonly artifact_id: string;
  readonly observation_id: string;
  readonly artifact_type: string;
  readonly mime_type: string | null;
  readonly namespace_id: string;
}

interface ClaimedDerivationJobRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly artifact_id: string;
  readonly artifact_observation_id: string;
  readonly source_chunk_id: string | null;
  readonly job_kind: DerivationJobKind;
  readonly modality: ProviderModality;
  readonly provider: string | null;
  readonly model: string | null;
  readonly retry_count: number;
  readonly max_retries: number;
  readonly output_dimensionality: number | null;
  readonly max_output_tokens: number | null;
  readonly metadata: Record<string, unknown> | null;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) {
    return 50;
  }

  return Math.max(1, Math.min(limit, 500));
}

function retryDelayMs(retryCount: number): number {
  const minutes = Math.min(60, 2 ** Math.max(0, retryCount));
  return minutes * 60_000;
}

function inferJobKind(artifactType: string, mimeType?: string | null): DerivationJobKind {
  if (artifactType === "image" || mimeType?.startsWith("image/")) {
    return "ocr";
  }

  if (artifactType === "pdf" || mimeType === "application/pdf") {
    return "ocr";
  }

  if (artifactType === "audio" || mimeType?.startsWith("audio/")) {
    return "transcription";
  }

  if (artifactType === "chat_turn" || artifactType === "markdown_session") {
    return "summary";
  }

  return "derive_text";
}

function inferModality(artifactType: string, mimeType?: string | null): ProviderModality {
  if (artifactType === "image" || mimeType?.startsWith("image/")) {
    return "image";
  }

  if (artifactType === "pdf" || mimeType === "application/pdf") {
    return "pdf";
  }

  if (artifactType === "audio" || mimeType?.startsWith("audio/")) {
    return "audio";
  }

  if (mimeType?.startsWith("video/")) {
    return "video";
  }

  return "text";
}

async function resolveArtifactContext(
  client: PoolClient,
  namespaceId: string,
  artifactId: string,
  artifactObservationId?: string
): Promise<ArtifactContextRow> {
  const result = artifactObservationId
    ? await client.query<ArtifactContextRow>(
        `
          SELECT
            a.id AS artifact_id,
            ao.id AS observation_id,
            a.artifact_type,
            a.mime_type,
            a.namespace_id
          FROM artifacts a
          JOIN artifact_observations ao ON ao.artifact_id = a.id
          WHERE a.id = $1
            AND a.namespace_id = $2
            AND ao.id = $3
          LIMIT 1
        `,
        [artifactId, namespaceId, artifactObservationId]
      )
    : await client.query<ArtifactContextRow>(
        `
          SELECT
            a.id AS artifact_id,
            ao.id AS observation_id,
            a.artifact_type,
            a.mime_type,
            a.namespace_id
          FROM artifacts a
          JOIN artifact_observations ao ON ao.artifact_id = a.id
          WHERE a.id = $1
            AND a.namespace_id = $2
          ORDER BY ao.version DESC
          LIMIT 1
        `,
        [artifactId, namespaceId]
      );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`No artifact context found for artifact ${artifactId}`);
  }

  return row;
}

export async function enqueueDerivationJob(request: DerivationJobRequest): Promise<DerivationJobResult> {
  return withTransaction(async (client) => {
    const context = await resolveArtifactContext(client, request.namespaceId, request.artifactId, request.artifactObservationId);
    const jobKind = request.jobKind ?? inferJobKind(context.artifact_type, context.mime_type);
    const modality = request.modality ?? inferModality(context.artifact_type, context.mime_type);

    const result = await client.query<{ id: string; status: DerivationJobStatus }>(
      `
        INSERT INTO derivation_jobs (
          namespace_id,
          artifact_id,
          artifact_observation_id,
          source_chunk_id,
          job_kind,
          modality,
          provider,
          model,
          output_dimensionality,
          max_output_tokens,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::text, $8::text, $9::integer, $10::integer, $11::jsonb)
        ON CONFLICT (
          artifact_observation_id,
          job_kind,
          (COALESCE(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid)),
          (COALESCE(provider, '')),
          (COALESCE(model, '')),
          (COALESCE(output_dimensionality, -1))
        )
        DO UPDATE SET
          status = CASE
            WHEN derivation_jobs.status IN ('failed', 'cancelled') THEN 'pending'
            ELSE derivation_jobs.status
          END,
          retry_count = CASE
            WHEN derivation_jobs.status IN ('failed', 'cancelled') THEN 0
            ELSE derivation_jobs.retry_count
          END,
          next_attempt_at = CASE
            WHEN derivation_jobs.status IN ('failed', 'cancelled') THEN now()
            ELSE derivation_jobs.next_attempt_at
          END,
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          last_error_at = NULL,
          updated_at = now(),
          metadata = derivation_jobs.metadata || EXCLUDED.metadata
        RETURNING id, status
      `,
      [
        context.namespace_id,
        context.artifact_id,
        context.observation_id,
        request.sourceChunkId ?? null,
        jobKind,
        modality,
        request.provider ?? null,
        request.model ?? null,
        request.outputDimensionality ?? null,
        request.maxOutputTokens ?? null,
        JSON.stringify({
          ...(request.metadata ?? {}),
          source_kind: context.artifact_type,
          source_mime_type: context.mime_type
        })
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to enqueue derivation job");
    }

    return {
      jobId: row.id,
      namespaceId: context.namespace_id,
      artifactId: context.artifact_id,
      artifactObservationId: context.observation_id,
      sourceChunkId: request.sourceChunkId,
      jobKind,
      modality,
      provider: request.provider,
      model: request.model,
      status: row.status
    };
  });
}

async function claimDerivationJobs(
  namespaceId: string | undefined,
  provider: string | undefined,
  limit: number,
  workerId: string
): Promise<ClaimedDerivationJobRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedDerivationJobRow>(
      `
        WITH candidates AS (
          SELECT dj.id
          FROM derivation_jobs dj
          WHERE dj.status = 'pending'
            AND dj.next_attempt_at <= now()
            AND ($1::text IS NULL OR dj.namespace_id = $1)
            AND ($2::text IS NULL OR dj.provider = $2)
          ORDER BY dj.created_at ASC
          LIMIT $3::integer
          FOR UPDATE SKIP LOCKED
        )
        UPDATE derivation_jobs dj
        SET status = 'processing',
            locked_at = now(),
            locked_by = $4,
            updated_at = now()
        FROM candidates c
        WHERE dj.id = c.id
        RETURNING
          dj.id,
          dj.namespace_id,
          dj.artifact_id,
          dj.artifact_observation_id,
          dj.source_chunk_id,
          dj.job_kind,
          dj.modality,
          dj.provider,
          dj.model,
          dj.retry_count,
          dj.max_retries,
          dj.output_dimensionality,
          dj.max_output_tokens,
          dj.metadata
      `,
      [namespaceId ?? null, provider ?? null, limit, workerId]
    );

    return result.rows;
  });
}

export async function processDerivationJobs(
  options: ProcessDerivationJobsOptions = {}
): Promise<ProcessDerivationJobsResult> {
  const workerId = options.workerId ?? `derive-worker:${crypto.randomUUID()}`;
  const jobs = await claimDerivationJobs(options.namespaceId, options.provider, normalizeLimit(options.limit), workerId);

  let completed = 0;
  let failed = 0;
  let retried = 0;

  for (const job of jobs) {
    try {
      const result = await deriveArtifactViaProvider({
        artifactId: job.artifact_id,
        artifactObservationId: job.artifact_observation_id,
        provider: job.provider ?? "external",
        model: job.model ?? undefined,
        derivationType: job.job_kind,
        modality: job.modality,
        maxOutputTokens: job.max_output_tokens ?? undefined,
        outputDimensionality: job.output_dimensionality ?? undefined,
        embed: job.job_kind === "embed",
        metadata: {
          ...(job.metadata ?? {}),
          derivation_job_id: job.id,
          derivation_worker_id: workerId
        }
      });

      await withClient(async (client) => {
        await client.query(
          `
            UPDATE derivation_jobs
            SET status = 'completed',
                target_derivation_id = $2,
                locked_at = NULL,
                locked_by = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [job.id, result.derivationId]
        );
      });
      completed += 1;
    } catch (error) {
      const nextRetryCount = job.retry_count + 1;
      const terminal = nextRetryCount >= job.max_retries || (error instanceof ProviderError && !error.retryable);
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(nextRetryCount)).toISOString();

      await withClient(async (client) => {
        await client.query(
          `
            UPDATE derivation_jobs
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
        );
      });

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
    completed,
    failed,
    retried
  };
}
