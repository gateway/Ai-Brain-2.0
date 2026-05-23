import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";
import { withBenchmarkNamespaceLock, type BenchmarkNamespaceMutationSummary } from "./benchmark-namespace.js";
import { runRelationshipMapProjectionCoverageBenchmark } from "./relationship-map-projection-coverage.js";

interface ProjectionSentinelSnapshot {
  readonly label: "first" | "second";
  readonly passed: boolean;
  readonly coverageRate: number;
  readonly mapCoverageRate: number;
  readonly chronologyCoverageRate: number;
  readonly p95LatencyMs: number;
  readonly maxLatencyMs: number;
  readonly queryTimeModelCalls: number;
  readonly unsupportedNoEvidenceSuccessCount: number;
  readonly sourceEvidenceViolationCount: number;
  readonly mixedOwnerEntryCount: number;
  readonly mapHeadCount: number;
  readonly mapEntryCount: number;
  readonly chronologyHeadCount: number;
  readonly chronologyEntryCount: number;
  readonly finalClaimSources: Readonly<Record<string, string | null>>;
  readonly failures: readonly string[];
}

interface ProjectionStateSentinelReport {
  readonly generatedAt: string;
  readonly benchmark: "projection_state_sentinel";
  readonly artifactSchemaVersion: "projection_state_sentinel_v1";
  readonly namespaceId: string;
  readonly namespacePolicy: "shared_locked";
  readonly passed: boolean;
  readonly mutationSummary: BenchmarkNamespaceMutationSummary;
  readonly readOnlyProbe: {
    readonly query: string;
    readonly finalClaimSource: string | null;
    readonly evidenceCount: number;
    readonly queryTimeModelCalls: number;
  };
  readonly snapshots: readonly [ProjectionSentinelSnapshot, ProjectionSentinelSnapshot];
  readonly deterministicDelta: Readonly<Record<string, { readonly first: unknown; readonly second: unknown }>>;
  readonly metrics: {
    readonly projectionDeterministicDeltaCount: number;
    readonly relationshipMapCoverageRate: number;
    readonly relationshipChronologyCoverageRate: number;
    readonly sourceEvidenceViolationCount: number;
    readonly queryTimeModelCalls: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
  };
  readonly failures: readonly string[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function snapshot(label: "first" | "second", report: Awaited<ReturnType<typeof runRelationshipMapProjectionCoverageBenchmark>>): ProjectionSentinelSnapshot {
  return {
    label,
    passed: report.passed,
    coverageRate: report.metrics.coverageRate,
    mapCoverageRate: report.metrics.mapCoverageRate,
    chronologyCoverageRate: report.metrics.chronologyCoverageRate,
    p95LatencyMs: report.metrics.p95LatencyMs,
    maxLatencyMs: report.metrics.maxLatencyMs,
    queryTimeModelCalls: report.metrics.queryTimeModelCalls,
    unsupportedNoEvidenceSuccessCount: report.metrics.unsupportedNoEvidenceSuccessCount,
    sourceEvidenceViolationCount: report.metrics.sourceEvidenceViolationCount,
    mixedOwnerEntryCount: report.metrics.mixedOwnerEntryCount,
    mapHeadCount: report.dbStats.mapHeadCount,
    mapEntryCount: report.dbStats.mapEntryCount,
    chronologyHeadCount: report.dbStats.chronologyHeadCount,
    chronologyEntryCount: report.dbStats.chronologyEntryCount,
    finalClaimSources: Object.fromEntries(report.cases.map((entry) => [entry.id, entry.finalClaimSource])),
    failures: report.failures
  };
}

function deterministicDelta(
  first: ProjectionSentinelSnapshot,
  second: ProjectionSentinelSnapshot
): Readonly<Record<string, { readonly first: unknown; readonly second: unknown }>> {
  const delta: Record<string, { readonly first: unknown; readonly second: unknown }> = {};
  const keys: readonly (keyof ProjectionSentinelSnapshot)[] = [
    "coverageRate",
    "mapCoverageRate",
    "chronologyCoverageRate",
    "queryTimeModelCalls",
    "unsupportedNoEvidenceSuccessCount",
    "sourceEvidenceViolationCount",
    "mixedOwnerEntryCount",
    "mapHeadCount",
    "mapEntryCount",
    "chronologyHeadCount",
    "chronologyEntryCount"
  ];
  for (const key of keys) {
    if (first[key] !== second[key]) {
      delta[String(key)] = { first: first[key], second: second[key] };
    }
  }
  if (JSON.stringify(first.finalClaimSources) !== JSON.stringify(second.finalClaimSources)) {
    delta.finalClaimSources = { first: first.finalClaimSources, second: second.finalClaimSources };
  }
  return delta;
}

function markdownReport(report: ProjectionStateSentinelReport): string {
  return `# Projection State Sentinel

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- namespacePolicy: ${report.namespacePolicy}
- passed: ${report.passed}
- projectionDeterministicDeltaCount: ${report.metrics.projectionDeterministicDeltaCount}
- relationshipMapCoverageRate: ${report.metrics.relationshipMapCoverageRate}
- relationshipChronologyCoverageRate: ${report.metrics.relationshipChronologyCoverageRate}
- sourceEvidenceViolationCount: ${report.metrics.sourceEvidenceViolationCount}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- unsupportedNoEvidenceSuccessCount: ${report.metrics.unsupportedNoEvidenceSuccessCount}
- changedTables: ${report.mutationSummary.changedTables.join(", ") || "none"}

## Failures

${report.failures.map((failure) => `- ${failure}`).join("\n") || "- none"}

## Delta

\`\`\`json
${JSON.stringify(report.deterministicDelta, null, 2)}
\`\`\`
`;
}

export async function runProjectionStateSentinel(
  namespaceId = process.env.BRAIN_PROJECTION_SENTINEL_NAMESPACE ?? "benchmark_relationship_map_projection_fixture"
): Promise<ProjectionStateSentinelReport> {
  const previousProjectionFlag = process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  const locked = await withBenchmarkNamespaceLock(namespaceId, "projection_state_sentinel", async () => {
    const firstReport = await runRelationshipMapProjectionCoverageBenchmark(namespaceId, { skipNamespaceLock: true });
    const readOnlyProbeResponse = await searchMemory({
      namespaceId,
      query: "what happened between Lauren and me?",
      limit: 6
    });
    const secondReport = await runRelationshipMapProjectionCoverageBenchmark(namespaceId, { skipNamespaceLock: true });
    return {
      first: snapshot("first", firstReport),
      second: snapshot("second", secondReport),
      readOnlyProbe: {
        query: "what happened between Lauren and me?",
        finalClaimSource: readOnlyProbeResponse.meta.finalClaimSource ?? null,
        evidenceCount: readOnlyProbeResponse.evidence.length,
        queryTimeModelCalls: readOnlyProbeResponse.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0
      }
    };
  }).finally(() => {
    if (previousProjectionFlag === undefined) delete process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
    else process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = previousProjectionFlag;
  });
  const delta = deterministicDelta(locked.result.first, locked.result.second);
  const deltaCount = Object.keys(delta).length;
  const metrics = {
    projectionDeterministicDeltaCount: deltaCount,
    relationshipMapCoverageRate: locked.result.second.mapCoverageRate,
    relationshipChronologyCoverageRate: locked.result.second.chronologyCoverageRate,
    sourceEvidenceViolationCount: locked.result.second.sourceEvidenceViolationCount,
    queryTimeModelCalls: locked.result.first.queryTimeModelCalls + locked.result.second.queryTimeModelCalls + locked.result.readOnlyProbe.queryTimeModelCalls,
    unsupportedNoEvidenceSuccessCount:
      locked.result.first.unsupportedNoEvidenceSuccessCount + locked.result.second.unsupportedNoEvidenceSuccessCount
  };
  const failures: string[] = [];
  if (metrics.projectionDeterministicDeltaCount > 0) failures.push("projection_deterministic_delta");
  if (metrics.relationshipMapCoverageRate < 1) failures.push("relationship_map_coverage_below_1");
  if (metrics.relationshipChronologyCoverageRate < 1) failures.push("relationship_chronology_coverage_below_1");
  if (metrics.sourceEvidenceViolationCount > 0) failures.push("source_evidence_violation");
  if (metrics.queryTimeModelCalls > 0) failures.push("query_time_model_calls");
  if (metrics.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
  if (locked.result.readOnlyProbe.finalClaimSource !== "relationship_chronology_projection") {
    failures.push("natural_relationship_probe_not_projection");
  }
  if (locked.result.readOnlyProbe.evidenceCount <= 0) {
    failures.push("natural_relationship_probe_missing_evidence");
  }
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "projection_state_sentinel",
    artifactSchemaVersion: "projection_state_sentinel_v1",
    namespaceId,
    namespacePolicy: "shared_locked",
    passed: failures.length === 0,
    mutationSummary: locked.mutationSummary,
    readOnlyProbe: locked.result.readOnlyProbe,
    snapshots: [locked.result.first, locked.result.second],
    deterministicDelta: delta,
    metrics,
    failures
  };
}

export async function runProjectionStateSentinelCli(): Promise<void> {
  try {
    const namespaceIndex = process.argv.indexOf("--namespace");
    const namespaceId = namespaceIndex >= 0 ? process.argv[namespaceIndex + 1] : undefined;
    const report = await runProjectionStateSentinel(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `projection-state-sentinel-${stamp}.json`);
    const markdownPath = path.join(dir, `projection-state-sentinel-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, markdownReport(report), "utf8");
    process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
