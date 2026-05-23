import { readConfig } from "../config.js";
import { queryRows } from "../db/client.js";
import { enqueueVectorSyncBackfill, processVectorSyncJobs } from "./vector-sync.js";

export type VectorActivationMode = "off" | "queue_only" | "bounded" | "full";
export type VectorActivationScope = "runtime" | "benchmark";

export interface NamespaceVectorCoverage {
  readonly semanticEmbedded: number;
  readonly semanticTotal: number;
  readonly derivationEmbedded: number;
  readonly derivationTotal: number;
}

export interface RunNamespaceVectorActivationOptions {
  readonly namespaceId: string;
  readonly scope?: VectorActivationScope;
  readonly mode?: VectorActivationMode;
  readonly limit?: number;
  readonly maxPasses?: number;
  readonly processPending?: boolean;
  readonly reason?: string;
}

export interface RunNamespaceVectorActivationResult {
  readonly namespaceId: string;
  readonly available: boolean;
  readonly scope: VectorActivationScope;
  readonly mode: VectorActivationMode;
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly semanticQueued: number;
  readonly derivationQueued: number;
  readonly synced: number;
  readonly failed: number;
  readonly retried: number;
  readonly remainingPending: number;
  readonly coverage: NamespaceVectorCoverage;
  readonly unavailableReason?: string;
  readonly reason?: string;
}

interface CountRow {
  readonly count: string;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (!limit || Number.isNaN(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(limit), 5000));
}

function resolveVectorSyncDefaults(scope: VectorActivationScope): {
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly mode: VectorActivationMode;
  readonly limit: number;
  readonly maxPasses: number;
} {
  const config = readConfig();
  return {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    outputDimensionality: config.embeddingDimensions,
    mode: scope === "benchmark" ? config.benchmarkVectorActivationMode : config.runtimeVectorActivationMode,
    limit: scope === "benchmark" ? config.benchmarkVectorActivationLimit : config.runtimeVectorActivationLimit,
    maxPasses: scope === "benchmark" ? config.benchmarkVectorActivationMaxPasses : config.runtimeVectorActivationMaxPasses
  };
}

function toCount(row: CountRow | undefined): number {
  const parsed = Number(row?.count ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadNamespaceVectorCoverage(namespaceId: string): Promise<NamespaceVectorCoverage> {
  const [semanticRows, derivationRows] = await Promise.all([
    queryRows<CountRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS count
        FROM semantic_memory
        WHERE namespace_id = $1
          AND status = 'active'
          AND valid_until IS NULL
      `,
      [namespaceId]
    ),
    queryRows<CountRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE ad.embedding IS NOT NULL)::text AS count
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND COALESCE(ad.content_text, '') <> ''
      `,
      [namespaceId]
    )
  ]);

  const [semanticTotalRows, derivationTotalRows] = await Promise.all([
    queryRows<CountRow>(
      `
        SELECT COUNT(*)::text AS count
        FROM semantic_memory
        WHERE namespace_id = $1
          AND status = 'active'
          AND valid_until IS NULL
      `,
      [namespaceId]
    ),
    queryRows<CountRow>(
      `
        SELECT COUNT(*)::text AS count
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND COALESCE(ad.content_text, '') <> ''
      `,
      [namespaceId]
    )
  ]);

  return {
    semanticEmbedded: toCount(semanticRows[0]),
    semanticTotal: toCount(semanticTotalRows[0]),
    derivationEmbedded: toCount(derivationRows[0]),
    derivationTotal: toCount(derivationTotalRows[0])
  };
}

export async function loadPendingNamespaceVectorSyncCount(namespaceId: string): Promise<number> {
  const rows = await queryRows<CountRow>(
    `
      SELECT COUNT(*)::text AS count
      FROM vector_sync_jobs
      WHERE namespace_id = $1
        AND status IN ('pending', 'processing')
    `,
    [namespaceId]
  );
  return toCount(rows[0]);
}

export async function runNamespaceVectorActivation(
  options: RunNamespaceVectorActivationOptions
): Promise<RunNamespaceVectorActivationResult> {
  const scope = options.scope ?? "runtime";
  const settings = resolveVectorSyncDefaults(scope);
  const mode = options.mode ?? settings.mode;
  const limit = normalizeLimit(options.limit, settings.limit);
  const maxPasses = normalizeLimit(options.maxPasses, settings.maxPasses);

  try {
    const baseline = await Promise.all([
      loadNamespaceVectorCoverage(options.namespaceId),
      loadPendingNamespaceVectorSyncCount(options.namespaceId)
    ]);

    if (mode === "off") {
      return {
        namespaceId: options.namespaceId,
        available: true,
        scope,
        mode,
        provider: settings.provider,
        model: settings.model,
        outputDimensionality: settings.outputDimensionality,
        semanticQueued: 0,
        derivationQueued: 0,
        synced: 0,
        failed: 0,
        retried: 0,
        remainingPending: baseline[1],
        coverage: baseline[0],
        reason: options.reason
      };
    }

    const backfill = await enqueueVectorSyncBackfill({
      namespaceId: options.namespaceId,
      provider: settings.provider,
      model: settings.model,
      outputDimensionality: settings.outputDimensionality,
      limit
    });

    let synced = 0;
    let failed = 0;
    let retried = 0;

    const processPending = options.processPending ?? (mode === "bounded" || mode === "full");

    if (processPending) {
      for (let pass = 0; pass < maxPasses; pass += 1) {
        const result = await processVectorSyncJobs({
          namespaceId: options.namespaceId,
          provider: settings.provider,
          limit
        });
        synced += result.synced;
        failed += result.failed;
        retried += result.retried;
        if (result.claimed < limit) {
          break;
        }
      }
    }

    const [coverage, remainingPending] = await Promise.all([
      loadNamespaceVectorCoverage(options.namespaceId),
      loadPendingNamespaceVectorSyncCount(options.namespaceId)
    ]);

    return {
      namespaceId: options.namespaceId,
      available: true,
      scope,
      mode,
      provider: settings.provider,
      model: settings.model,
      outputDimensionality: settings.outputDimensionality,
      semanticQueued: backfill.semanticQueued,
      derivationQueued: backfill.derivationQueued,
      synced,
      failed,
      retried,
      remainingPending,
      coverage,
      reason: options.reason
    };
  } catch (error) {
    let coverage: NamespaceVectorCoverage = {
      semanticEmbedded: 0,
      semanticTotal: 0,
      derivationEmbedded: 0,
      derivationTotal: 0
    };

    try {
      coverage = await loadNamespaceVectorCoverage(options.namespaceId);
    } catch {
      // Preserve the vector-activation failure as metadata only.
    }

    return {
      namespaceId: options.namespaceId,
      available: false,
      scope,
      mode,
      provider: settings.provider,
      model: settings.model,
      outputDimensionality: settings.outputDimensionality,
      semanticQueued: 0,
      derivationQueued: 0,
      synced: 0,
      failed: 0,
      retried: 0,
      remainingPending: 0,
      coverage,
      unavailableReason: error instanceof Error ? error.message : String(error),
      reason: options.reason
    };
  }
}
