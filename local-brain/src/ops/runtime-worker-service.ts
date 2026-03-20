import { randomUUID } from "node:crypto";
import { processBrainOutboxEvents, type BrainOutboxProcessResult } from "../clarifications/service.js";
import { queryRows } from "../db/client.js";
import {
  runSemanticTemporalSummaryOverlay,
  runTemporalSummaryScaffold,
  type TemporalLayer,
  type TemporalSummaryRunSummary
} from "../jobs/temporal-summary.js";
import {
  getBootstrapState,
  processScheduledMonitoredSources,
  resolveRuntimeOperationsSettings,
  type OpsRuntimeOperationsSettings,
  type ProcessScheduledMonitoredSourcesResult
} from "./source-service.js";

export type WorkerKey = "source_monitor" | "outbox" | "temporal_summary";
type WorkerRunStatus = "running" | "succeeded" | "partial" | "failed" | "skipped";
type WorkerTriggerType = "manual" | "scheduled" | "loop" | "onboarding" | "repair";

interface WorkerRunRow {
  readonly id: string;
  readonly worker_key: WorkerKey;
  readonly trigger_type: WorkerTriggerType;
  readonly namespace_id: string | null;
  readonly source_id: string | null;
  readonly worker_id: string | null;
  readonly status: WorkerRunStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  readonly next_due_at: string | null;
  readonly attempted_count: number;
  readonly processed_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
  readonly error_class: string | null;
  readonly error_message: string | null;
  readonly summary_json: Record<string, unknown>;
}

export interface OpsWorkerRun {
  readonly id: string;
  readonly workerKey: WorkerKey;
  readonly triggerType: WorkerTriggerType;
  readonly namespaceId?: string | null;
  readonly sourceId?: string | null;
  readonly workerId?: string | null;
  readonly status: WorkerRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly durationMs?: number | null;
  readonly nextDueAt?: string | null;
  readonly attemptedCount: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly errorClass?: string | null;
  readonly errorMessage?: string | null;
  readonly summary: Record<string, unknown>;
}

export interface OpsWorkerHealth {
  readonly workerKey: WorkerKey;
  readonly enabled: boolean;
  readonly intervalSeconds?: number;
  readonly state: "disabled" | "never" | "running" | "healthy" | "degraded" | "failed" | "stale";
  readonly nextDueAt?: string;
  readonly latestRun?: OpsWorkerRun;
  readonly recentFailures: readonly OpsWorkerRun[];
}

export interface OpsRuntimeWorkerStatus {
  readonly checkedAt: string;
  readonly namespaceId: string;
  readonly workers: readonly OpsWorkerHealth[];
}

interface FinishWorkerRunInput {
  readonly status: WorkerRunStatus;
  readonly attemptedCount?: number;
  readonly processedCount?: number;
  readonly failedCount?: number;
  readonly skippedCount?: number;
  readonly nextDueAt?: string | null;
  readonly errorClass?: string | null;
  readonly errorMessage?: string | null;
  readonly summary?: Record<string, unknown>;
}

function classifyWorkerFailure(error: unknown): {
  readonly errorClass: string;
  readonly category: string;
  readonly retryGuidance: string;
  readonly message: string;
} {
  const errorClass = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("auth") || normalized.includes("api key") || normalized.includes("bearer")) {
    return {
      errorClass,
      category: "provider_auth",
      retryGuidance: "Check the provider API key or auth header configuration, then retry the worker.",
      message
    };
  }
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("econnreset")) {
    return {
      errorClass,
      category: "provider_timeout",
      retryGuidance: "The provider or runtime was slow or unavailable. Retry once the model/runtime is responsive again.",
      message
    };
  }
  if (normalized.includes("dimension") || normalized.includes("pgvector") || normalized.includes("schema mismatch")) {
    return {
      errorClass,
      category: "schema_mismatch",
      retryGuidance: "The selected model does not match the current schema or vector dimensions. Fix the model/schema pairing, then rerun.",
      message
    };
  }
  if (normalized.includes("no such file") || normalized.includes("enoent") || normalized.includes("eacces") || normalized.includes("permission denied")) {
    return {
      errorClass,
      category: "source_access",
      retryGuidance: "Verify the watched folder still exists and the runtime can read it, then rescan or rerun the worker.",
      message
    };
  }
  if (normalized.includes("connect") || normalized.includes("econnrefused") || normalized.includes("database") || normalized.includes("sql")) {
    return {
      errorClass,
      category: "runtime_dependency",
      retryGuidance: "Check database/runtime dependencies and connectivity, then retry the worker after the service is healthy.",
      message
    };
  }
  return {
    errorClass,
    category: "unknown",
    retryGuidance: "Inspect the latest failure details and retry after correcting the underlying runtime issue.",
    message
  };
}

function intervalSecondsForWorker(workerKey: WorkerKey, settings: OpsRuntimeOperationsSettings): number | undefined {
  if (workerKey === "source_monitor") {
    return settings.sourceMonitor.workerIntervalSeconds;
  }
  if (workerKey === "outbox") {
    return settings.outbox.workerIntervalSeconds;
  }
  return settings.temporalSummary.workerIntervalSeconds;
}

function enabledForWorker(workerKey: WorkerKey, settings: OpsRuntimeOperationsSettings): boolean {
  if (workerKey === "source_monitor") {
    return settings.sourceMonitor.enabled;
  }
  if (workerKey === "temporal_summary") {
    return settings.temporalSummary.enabled;
  }
  return true;
}

function mapWorkerRun(row: WorkerRunRow): OpsWorkerRun {
  return {
    id: row.id,
    workerKey: row.worker_key,
    triggerType: row.trigger_type,
    namespaceId: row.namespace_id,
    sourceId: row.source_id,
    workerId: row.worker_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    nextDueAt: row.next_due_at,
    attemptedCount: row.attempted_count,
    processedCount: row.processed_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    summary: row.summary_json ?? {}
  };
}

async function createWorkerRun(input: {
  readonly workerKey: WorkerKey;
  readonly triggerType: WorkerTriggerType;
  readonly namespaceId?: string;
  readonly sourceId?: string;
  readonly workerId?: string;
}): Promise<string> {
  const rows = await queryRows<{ readonly id: string }>(
    `
      INSERT INTO ops.worker_runs (
        worker_key,
        trigger_type,
        namespace_id,
        source_id,
        worker_id,
        status,
        summary_json
      )
      VALUES ($1, $2, $3, $4::uuid, $5, 'running', '{}'::jsonb)
      RETURNING id::text
    `,
    [
      input.workerKey,
      input.triggerType,
      input.namespaceId ?? null,
      input.sourceId ?? null,
      input.workerId ?? null
    ]
  );

  return rows[0]!.id;
}

async function finishWorkerRun(runId: string, input: FinishWorkerRunInput): Promise<void> {
  await queryRows(
    `
      UPDATE ops.worker_runs
      SET
        status = $2,
        finished_at = now(),
        duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::int,
        next_due_at = $3::timestamptz,
        attempted_count = $4,
        processed_count = $5,
        failed_count = $6,
        skipped_count = $7,
        error_class = $8,
        error_message = $9,
        summary_json = $10::jsonb,
        updated_at = now()
      WHERE id = $1::uuid
    `,
    [
      runId,
      input.status,
      input.nextDueAt ?? null,
      input.attemptedCount ?? 0,
      input.processedCount ?? 0,
      input.failedCount ?? 0,
      input.skippedCount ?? 0,
      input.errorClass ?? null,
      input.errorMessage?.slice(0, 1500) ?? null,
      JSON.stringify(input.summary ?? {})
    ]
  );
}

function computeNextDueAt(intervalSeconds?: number): string | undefined {
  if (!intervalSeconds || intervalSeconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + intervalSeconds * 1000).toISOString();
}

export async function executeSourceMonitorWorker(input?: {
  readonly sourceId?: string;
  readonly scanOnly?: boolean;
  readonly limit?: number;
  readonly importAfterScan?: boolean;
  readonly triggerType?: WorkerTriggerType;
  readonly workerId?: string;
}): Promise<ProcessScheduledMonitoredSourcesResult> {
  const bootstrap = await getBootstrapState();
  const settings = resolveRuntimeOperationsSettings(bootstrap.metadata);
  const runId = await createWorkerRun({
    workerKey: "source_monitor",
    triggerType: input?.triggerType ?? "manual",
    namespaceId: typeof bootstrap.metadata.defaultNamespaceId === "string" ? bootstrap.metadata.defaultNamespaceId : undefined,
    sourceId: input?.sourceId,
    workerId: input?.workerId
  });

  try {
    const result = await processScheduledMonitoredSources({
      sourceId: input?.sourceId,
      importAfterScan: input?.importAfterScan ?? (input?.scanOnly ? false : settings.sourceMonitor.autoImportOnScan),
      limit: input?.limit
    });
    const failedCount = result.results.filter((item) => item.action === "failed").length;
    const skippedCount = result.results.filter((item) => item.action === "skipped").length;
    await finishWorkerRun(runId, {
      status: failedCount > 0 ? "partial" : "succeeded",
      attemptedCount: result.dueSourceCount,
      processedCount: result.processedCount,
      failedCount,
      skippedCount: result.skippedCount + skippedCount,
      nextDueAt: settings.sourceMonitor.enabled ? computeNextDueAt(settings.sourceMonitor.workerIntervalSeconds) : null,
      summary: result as unknown as Record<string, unknown>
    });
    return result;
  } catch (error) {
    await finishWorkerRun(runId, {
      status: "failed",
      nextDueAt: settings.sourceMonitor.enabled ? computeNextDueAt(settings.sourceMonitor.workerIntervalSeconds) : null,
      errorClass: classifyWorkerFailure(error).errorClass,
      errorMessage: classifyWorkerFailure(error).message,
      summary: {
        failure_category: classifyWorkerFailure(error).category,
        retry_guidance: classifyWorkerFailure(error).retryGuidance
      }
    });
    throw error;
  }
}

export async function executeOutboxWorker(input?: {
  readonly namespaceId?: string;
  readonly limit?: number;
  readonly triggerType?: WorkerTriggerType;
  readonly workerId?: string;
}): Promise<BrainOutboxProcessResult> {
  const bootstrap = await getBootstrapState();
  const settings = resolveRuntimeOperationsSettings(bootstrap.metadata);
  const namespaceId =
    input?.namespaceId ??
    (typeof bootstrap.metadata.defaultNamespaceId === "string" ? bootstrap.metadata.defaultNamespaceId : "personal");
  const runId = await createWorkerRun({
    workerKey: "outbox",
    triggerType: input?.triggerType ?? "manual",
    namespaceId,
    workerId: input?.workerId
  });

  try {
    const result = await processBrainOutboxEvents({
      namespaceId,
      limit: input?.limit ?? settings.outbox.batchLimit,
      workerId: input?.workerId
    });
    await finishWorkerRun(runId, {
      status: result.failed > 0 ? "partial" : "succeeded",
      attemptedCount: result.scanned,
      processedCount: result.processed,
      failedCount: result.failed,
      nextDueAt: computeNextDueAt(settings.outbox.workerIntervalSeconds),
      summary: result as unknown as Record<string, unknown>
    });
    return result;
  } catch (error) {
    await finishWorkerRun(runId, {
      status: "failed",
      nextDueAt: computeNextDueAt(settings.outbox.workerIntervalSeconds),
      errorClass: classifyWorkerFailure(error).errorClass,
      errorMessage: classifyWorkerFailure(error).message,
      summary: {
        failure_category: classifyWorkerFailure(error).category,
        retry_guidance: classifyWorkerFailure(error).retryGuidance
      }
    });
    throw error;
  }
}

export async function executeTemporalSummaryWorker(input: {
  readonly namespaceId: string;
  readonly lookbackDays?: number;
  readonly layers?: readonly TemporalLayer[];
  readonly strategy?: "deterministic" | "deterministic_plus_llm";
  readonly provider?: "external" | "openrouter" | "gemini";
  readonly model?: string;
  readonly presetId?: string;
  readonly systemPrompt?: string;
  readonly triggerType?: WorkerTriggerType;
  readonly workerId?: string;
}): Promise<{
  readonly summaries: readonly TemporalSummaryRunSummary[];
  readonly semanticOverlayUpdatedNodes: number;
}> {
  const bootstrap = await getBootstrapState();
  const settings = resolveRuntimeOperationsSettings(bootstrap.metadata);
  const runId = await createWorkerRun({
    workerKey: "temporal_summary",
    triggerType: input.triggerType ?? "manual",
    namespaceId: input.namespaceId,
    workerId: input.workerId
  });
  const layers: readonly TemporalLayer[] =
    input.layers && input.layers.length > 0 ? input.layers : ["day", "week", "month", "year"];
  const lookbackDays = input.lookbackDays ?? settings.temporalSummary.lookbackDays;
  const strategy = input.strategy ?? settings.temporalSummary.strategy;
  const provider = input.provider ?? settings.temporalSummary.summarizerProvider;
  const model = input.model ?? settings.temporalSummary.summarizerModel;
  const presetId = input.presetId ?? settings.temporalSummary.summarizerPreset;
  const systemPrompt = input.systemPrompt ?? settings.temporalSummary.systemPrompt;

  try {
    const summaries: TemporalSummaryRunSummary[] = [];
    let semanticOverlayUpdatedNodes = 0;
    for (const layer of layers) {
      summaries.push(
        await runTemporalSummaryScaffold(input.namespaceId, {
          layer,
          lookbackDays
        })
      );
      if (strategy === "deterministic_plus_llm") {
        const overlay = await runSemanticTemporalSummaryOverlay(input.namespaceId, {
          layer,
          lookbackDays,
          provider,
          model,
          presetId,
          systemPrompt
        });
        semanticOverlayUpdatedNodes += overlay.updatedNodes;
      }
    }
    await finishWorkerRun(runId, {
      status: "succeeded",
      attemptedCount: layers.length,
      processedCount: summaries.reduce((sum, item) => sum + item.upsertedNodes, 0),
      nextDueAt: settings.temporalSummary.enabled ? computeNextDueAt(settings.temporalSummary.workerIntervalSeconds) : null,
      summary: {
        namespaceId: input.namespaceId,
        strategy,
        provider,
        model: model ?? null,
        presetId: presetId ?? null,
        lookbackDays,
        layers,
        semanticOverlayUpdatedNodes,
        summaries
      }
    });
    return {
      summaries,
      semanticOverlayUpdatedNodes
    };
  } catch (error) {
    await finishWorkerRun(runId, {
      status: "failed",
      nextDueAt: settings.temporalSummary.enabled ? computeNextDueAt(settings.temporalSummary.workerIntervalSeconds) : null,
      errorClass: classifyWorkerFailure(error).errorClass,
      errorMessage: classifyWorkerFailure(error).message,
      summary: {
        failure_category: classifyWorkerFailure(error).category,
        retry_guidance: classifyWorkerFailure(error).retryGuidance
      }
    });
    throw error;
  }
}

export async function getRuntimeWorkerStatus(): Promise<OpsRuntimeWorkerStatus> {
  const bootstrap = await getBootstrapState();
  const settings = resolveRuntimeOperationsSettings(bootstrap.metadata);
  const namespaceId =
    typeof bootstrap.metadata.defaultNamespaceId === "string" && bootstrap.metadata.defaultNamespaceId.trim()
      ? bootstrap.metadata.defaultNamespaceId
      : "personal";
  const latestRows = await queryRows<WorkerRunRow>(
    `
      SELECT DISTINCT ON (worker_key)
        id::text,
        worker_key,
        trigger_type,
        namespace_id,
        source_id::text,
        worker_id,
        status,
        started_at::text,
        finished_at::text,
        duration_ms,
        next_due_at::text,
        attempted_count,
        processed_count,
        failed_count,
        skipped_count,
        error_class,
        error_message,
        summary_json
      FROM ops.worker_runs
      ORDER BY worker_key, started_at DESC
    `
  );
  const failureRows = await queryRows<WorkerRunRow>(
    `
      SELECT
        id::text,
        worker_key,
        trigger_type,
        namespace_id,
        source_id::text,
        worker_id,
        status,
        started_at::text,
        finished_at::text,
        duration_ms,
        next_due_at::text,
        attempted_count,
        processed_count,
        failed_count,
        skipped_count,
        error_class,
        error_message,
        summary_json
      FROM ops.worker_runs
      WHERE status IN ('failed', 'partial')
      ORDER BY started_at DESC
      LIMIT 12
    `
  );

  const latestByKey = new Map(latestRows.map((row) => [row.worker_key, mapWorkerRun(row)]));
  const failuresByKey = new Map<WorkerKey, OpsWorkerRun[]>();
  for (const row of failureRows) {
    const list = failuresByKey.get(row.worker_key) ?? [];
    if (list.length < 3) {
      list.push(mapWorkerRun(row));
    }
    failuresByKey.set(row.worker_key, list);
  }

  const nowMs = Date.now();
  const workers: OpsWorkerHealth[] = (["source_monitor", "outbox", "temporal_summary"] as const).map((workerKey) => {
    const enabled = enabledForWorker(workerKey, settings);
    const intervalSeconds = intervalSecondsForWorker(workerKey, settings);
    const latestRun = latestByKey.get(workerKey);
    const nextDueAt = latestRun?.nextDueAt ?? (enabled ? computeNextDueAt(intervalSeconds) : undefined);
    const nextDueMs = nextDueAt ? Date.parse(nextDueAt) : Number.NaN;
    const stale = enabled && latestRun?.status !== "running" && Number.isFinite(nextDueMs) && nextDueMs < nowMs;

    let state: OpsWorkerHealth["state"];
    if (!enabled) {
      state = "disabled";
    } else if (!latestRun) {
      state = "never";
    } else if (latestRun.status === "running") {
      state = "running";
    } else if (latestRun.status === "failed") {
      state = "failed";
    } else if (stale) {
      state = "stale";
    } else if (latestRun.status === "partial") {
      state = "degraded";
    } else {
      state = "healthy";
    }

    return {
      workerKey,
      enabled,
      intervalSeconds,
      state,
      nextDueAt,
      latestRun,
      recentFailures: failuresByKey.get(workerKey) ?? []
    };
  });

  return {
    checkedAt: new Date().toISOString(),
    namespaceId,
    workers
  };
}

export function buildRuntimeLoopWorkerId(prefix: string): string {
  return `${prefix}:${randomUUID().slice(0, 8)}`;
}
