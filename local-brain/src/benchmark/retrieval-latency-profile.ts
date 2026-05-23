import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runPersonalOmiReview } from "./personal-omi-review.js";

interface LatencyProfileRow {
  readonly queryId: string;
  readonly queryText: string;
  readonly family: string | null;
  readonly supportBundleFamily: string | null;
  readonly finalClaimSource: string | null;
  readonly latencyMs: number;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly stageTimedTotalMs: number | null;
  readonly latencyUnaccountedMs: number | null;
  readonly latencyTelemetryMismatch: boolean;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly candidateCountsByStage: Readonly<Record<string, number>> | null;
  readonly rowsScannedByStage: Readonly<Record<string, number>> | null;
  readonly compiledLookupTried: boolean;
  readonly proceduralLookupTried: boolean;
  readonly relationshipFastPathTried: boolean;
  readonly semanticFallbackUsed: boolean;
  readonly sqlHybridUsed: boolean;
  readonly typedLaneDescentTriggered: boolean;
  readonly plannerBackfillTriggered: boolean;
  readonly graphExpansionTriggered: boolean;
  readonly earlyStopReason: string | null;
  readonly fallbackReason: string | null;
  readonly abstentionReason: string | null;
  readonly status: string;
}

interface LatencyBucket {
  readonly count: number;
  readonly p50Ms: number;
  readonly p75Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

interface RetrievalLatencyProfileReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly budgets: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly missingTelemetryRows: number;
    readonly slowRowsMissingDominantStage: number;
  };
  readonly latency: LatencyBucket;
  readonly byFamily: Readonly<Record<string, LatencyBucket>>;
  readonly byDominantStage: Readonly<Record<string, LatencyBucket>>;
  readonly counts: {
    readonly totalRows: number;
    readonly missingTelemetryRows: number;
    readonly slowRowsMissingDominantStage: number;
    readonly latencyTelemetryMismatchRows: number;
    readonly broadRetrievalDespiteTypedSupportRows: number;
    readonly semanticFallbackRows: number;
    readonly sqlHybridRows: number;
    readonly typedLaneDescentRows: number;
    readonly plannerBackfillRows: number;
    readonly graphExpansionRows: number;
  };
  readonly topSlowRows: readonly LatencyProfileRow[];
  readonly rows: readonly LatencyProfileRow[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function bucket(rows: readonly LatencyProfileRow[]): LatencyBucket {
  const values = rows.map((row) => row.latencyMs);
  return {
    count: rows.length,
    p50Ms: percentile(values, 50),
    p75Ms: percentile(values, 75),
    p90Ms: percentile(values, 90),
    p95Ms: percentile(values, 95),
    maxMs: Number((Math.max(0, ...values)).toFixed(2))
  };
}

function groupBuckets(
  rows: readonly LatencyProfileRow[],
  keyFor: (row: LatencyProfileRow) => string
): Readonly<Record<string, LatencyBucket>> {
  const groups = new Map<string, LatencyProfileRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, bucket(value)]));
}

function rowFamily(row: LatencyProfileRow): string {
  return row.supportBundleFamily ?? row.family ?? "unknown";
}

function isBroadRetrievalDespiteTypedSupport(row: LatencyProfileRow): boolean {
  const typedFamily = ["current_state", "exact_detail", "temporal_detail", "profile_report", "typed_list_set", "commonality"].includes(rowFamily(row));
  return typedFamily && (row.sqlHybridUsed || row.semanticFallbackUsed || row.typedLaneDescentTriggered || row.plannerBackfillTriggered) && Boolean(row.compiledLookupTried || row.proceduralLookupTried || row.relationshipFastPathTried);
}

function stageTimedTotalMs(scenario: any): number | null {
  const explicitTotal = scenario.stageTimingsMs?.total;
  if (typeof explicitTotal === "number" && Number.isFinite(explicitTotal)) {
    return Number(explicitTotal.toFixed(2));
  }
  const topStageMs = scenario.topStageMs;
  if (typeof topStageMs === "number" && Number.isFinite(topStageMs)) {
    return Number(topStageMs.toFixed(2));
  }
  return null;
}

function latencyUnaccountedMs(latencyMs: number, timedTotalMs: number | null): number | null {
  if (timedTotalMs === null) {
    return null;
  }
  return Number(Math.max(0, latencyMs - timedTotalMs).toFixed(2));
}

function hasLatencyTelemetryMismatch(latencyMs: number, timedTotalMs: number | null): boolean {
  if (timedTotalMs === null) {
    return false;
  }
  const unaccountedMs = latencyMs - timedTotalMs;
  return latencyMs > 1000 && unaccountedMs > 500 && timedTotalMs < latencyMs * 0.8;
}

export async function runRetrievalLatencyProfile(namespaceId = "personal"): Promise<RetrievalLatencyProfileReport> {
  const personal = await runPersonalOmiReview(namespaceId);
  const rows: LatencyProfileRow[] = personal.scenarios.map((scenario: any) => {
    const timedTotalMs = stageTimedTotalMs(scenario);
    const latencyMs = scenario.latencyMs;
    return {
      queryId: scenario.name,
      queryText: scenario.query,
      family: scenario.category ?? null,
      supportBundleFamily: scenario.supportBundleFamily ?? null,
      finalClaimSource: scenario.finalClaimSource ?? null,
      latencyMs,
      dominantStage: scenario.dominantStage ?? null,
      topStageMs: scenario.topStageMs ?? null,
      stageTimedTotalMs: timedTotalMs,
      latencyUnaccountedMs: latencyUnaccountedMs(latencyMs, timedTotalMs),
      latencyTelemetryMismatch: hasLatencyTelemetryMismatch(latencyMs, timedTotalMs),
      stageTimingsMs: scenario.stageTimingsMs ?? null,
      candidateCountsByStage: scenario.candidateCountsByStage ?? null,
      rowsScannedByStage: scenario.rowsScannedByStage ?? null,
      compiledLookupTried: scenario.compiledLookupTried === true,
      proceduralLookupTried: scenario.proceduralLookupTried === true,
      relationshipFastPathTried: scenario.relationshipFastPathTried === true,
      semanticFallbackUsed: scenario.semanticFallbackUsed === true,
      sqlHybridUsed: scenario.sqlHybridUsed === true,
      typedLaneDescentTriggered: scenario.typedLaneDescentTriggered === true,
      plannerBackfillTriggered: scenario.plannerBackfillTriggered === true,
      graphExpansionTriggered: scenario.graphExpansionTriggered === true,
      earlyStopReason: scenario.earlyStopReason ?? null,
      fallbackReason: scenario.fallbackSuppressedReason ?? null,
      abstentionReason: scenario.abstentionReason ?? null,
      status: scenario.status
    };
  });
  const missingTelemetryRows = rows.filter((row) => !row.stageTimingsMs).length;
  const slowRowsMissingDominantStage = rows.filter((row) => row.latencyMs > 5000 && !row.dominantStage).length;
  const latencyTelemetryMismatchRows = rows.filter((row) => row.latencyTelemetryMismatch).length;
  const latency = bucket(rows);
  const budgets = {
    p50Ms: 3000,
    p95Ms: 10000,
    maxMs: 20000,
    missingTelemetryRows: 0,
    slowRowsMissingDominantStage: 0
  };
  return {
    generatedAt: new Date().toISOString(),
    namespaceId,
    passed:
      personal.summary.pass === 29 &&
      personal.summary.warning === 0 &&
      personal.summary.fail === 0 &&
      latency.p50Ms <= budgets.p50Ms &&
      latency.p95Ms <= budgets.p95Ms &&
      latency.maxMs <= budgets.maxMs &&
      missingTelemetryRows === 0 &&
      slowRowsMissingDominantStage === 0,
    budgets,
    latency,
    byFamily: groupBuckets(rows, rowFamily),
    byDominantStage: groupBuckets(rows, (row) => row.dominantStage ?? "missing"),
    counts: {
      totalRows: rows.length,
      missingTelemetryRows,
      slowRowsMissingDominantStage,
      latencyTelemetryMismatchRows,
      broadRetrievalDespiteTypedSupportRows: rows.filter(isBroadRetrievalDespiteTypedSupport).length,
      semanticFallbackRows: rows.filter((row) => row.semanticFallbackUsed).length,
      sqlHybridRows: rows.filter((row) => row.sqlHybridUsed).length,
      typedLaneDescentRows: rows.filter((row) => row.typedLaneDescentTriggered).length,
      plannerBackfillRows: rows.filter((row) => row.plannerBackfillTriggered).length,
      graphExpansionRows: rows.filter((row) => row.graphExpansionTriggered).length
    },
    topSlowRows: [...rows].sort((left, right) => right.latencyMs - left.latencyMs).slice(0, 10),
    rows
  };
}

export async function runAndWriteRetrievalLatencyProfile(namespaceId = "personal"): Promise<{
  readonly report: RetrievalLatencyProfileReport;
  readonly jsonPath: string;
}> {
  const report = await runRetrievalLatencyProfile(namespaceId);
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `retrieval-latency-profile-${timestamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, jsonPath };
}

export async function runRetrievalLatencyProfileCli(): Promise<void> {
  try {
    const namespaceId = process.argv[2] || "personal";
    const result = await runAndWriteRetrievalLatencyProfile(namespaceId);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
