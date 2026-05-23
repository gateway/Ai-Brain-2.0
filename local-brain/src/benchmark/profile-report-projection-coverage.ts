import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { searchMemory } from "../retrieval/service.js";

interface ProjectionDbStats {
  readonly headCount: number;
  readonly entryCount: number;
  readonly entriesMissingSourceQuote: number;
  readonly entriesMissingSourceRowId: number;
  readonly mixedOwnerEntryCount: number;
}

interface ProfileReportProjectionQueryResult {
  readonly query: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly projectionTried: boolean;
  readonly projectionSucceeded: boolean;
  readonly projectionEntryCount: number;
  readonly projectionEvidenceCount: number;
  readonly supportBundleFamily: string | null;
  readonly dominantStage: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly claim: string;
}

interface ProfileReportProjectionCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "profile_report_projection_coverage";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly thresholds: {
    readonly projectionCoverageRate: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly metrics: {
    readonly projectionCoverageRate: number;
    readonly sourceEvidenceViolationCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly unknownOwnerCount: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly dbStats: ProjectionDbStats;
  readonly rebuildCounts: {
    readonly heads: number;
    readonly entries: number;
  };
  readonly failures: readonly string[];
  readonly queries: readonly ProfileReportProjectionQueryResult[];
}

const PROFILE_REPORT_QUERIES: readonly string[] = [
  "Can you query all the information about Lauren and I?",
  "Give me all the info about Lauren and me.",
  "What is the full picture with Lauren and I?",
  "What is the whole story about Lauren and me?",
  "Summarize all information about Lauren and I.",
  "Give me a recap of Lauren and me.",
  "What is my history with Lauren?",
  "What is Steve's history with Lauren?",
  "What is the relationship history with Lauren?",
  "What is everything you know about Lauren and I?",
  "Pull together the full picture about Lauren and me.",
  "What is the summary of my relationship with Lauren?",
  "What is all the relationship info about Lauren and I?",
  "Tell me the history with Lauren.",
  "What is the recap of Lauren and I?",
  "What is the full relationship picture with Lauren?",
  "What do we know about my history with Lauren?",
  "What is the whole relationship story about Lauren and me?",
  "Can you summarize my history with Lauren?",
  "What is all the info about Lauren and me?"
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

async function loadProjectionDbStats(namespaceId: string): Promise<ProjectionDbStats> {
  const rows = await queryRows<{
    readonly head_count: string;
    readonly entry_count: string;
    readonly entries_missing_source_quote: string;
    readonly entries_missing_source_row_id: string;
    readonly mixed_owner_entry_count: string;
  }>(
    `
      WITH heads AS (
        SELECT id
        FROM contract_projection_heads
        WHERE namespace_id = $1
          AND contract_name = 'relationship_profile'
          AND projection_kind = 'report'
          AND projection_version = 'profile_report_projection_v1'
          AND truth_status = 'active'
      ),
      entries AS (
        SELECT entry.*
        FROM contract_projection_entries entry
        JOIN heads ON heads.id = entry.projection_head_id
        WHERE entry.truth_status = 'active'
      )
      SELECT
        (SELECT count(*) FROM heads)::text AS head_count,
        (SELECT count(*) FROM entries)::text AS entry_count,
        (SELECT count(*) FROM entries WHERE NULLIF(metadata->>'source_quote', '') IS NULL)::text AS entries_missing_source_quote,
        (SELECT count(*) FROM entries WHERE source_row_id IS NULL)::text AS entries_missing_source_row_id,
        (SELECT count(*) FROM entries WHERE owner_binding_status IS DISTINCT FROM 'subject_pair_bound')::text AS mixed_owner_entry_count
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    headCount: Number(row?.head_count ?? 0),
    entryCount: Number(row?.entry_count ?? 0),
    entriesMissingSourceQuote: Number(row?.entries_missing_source_quote ?? 0),
    entriesMissingSourceRowId: Number(row?.entries_missing_source_row_id ?? 0),
    mixedOwnerEntryCount: Number(row?.mixed_owner_entry_count ?? 0)
  };
}

async function runProjectionQuery(namespaceId: string, query: string): Promise<ProfileReportProjectionQueryResult> {
  const startedAt = Date.now();
  const response = await searchMemory({ namespaceId, query, limit: 6 });
  const latencyMs = Date.now() - startedAt;
  const evidenceCount = response.evidence.length;
  const projectionTried = response.meta.profileReportProjectionTried === true;
  const projectionSucceeded = response.meta.profileReportProjectionSucceeded === true;
  const projectionEvidenceCount = response.meta.profileReportProjectionEvidenceCount ?? 0;
  const projectionEntryCount = response.meta.profileReportProjectionEntryCount ?? 0;
  const queryTimeModelCalls = response.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0;
  const failures: string[] = [];
  if (!projectionTried) failures.push("projection_not_tried");
  if (!projectionSucceeded) failures.push(response.meta.profileReportProjectionBlockedReason ?? "projection_not_succeeded");
  if (projectionEvidenceCount <= 0 || evidenceCount <= 0) failures.push("projection_evidence_missing");
  if (response.meta.supportBundleFamily !== "profile_report") failures.push("not_profile_report");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_call");
  if (!/\bLauren\b/iu.test(`${response.duality.claim.text} ${response.evidence.map((entry) => entry.snippet).join(" ")}`)) {
    failures.push("pair_binding_missing");
  }
  return {
    query,
    passed: failures.length === 0,
    failures,
    latencyMs,
    projectionTried,
    projectionSucceeded,
    projectionEntryCount,
    projectionEvidenceCount,
    supportBundleFamily: response.meta.supportBundleFamily ?? null,
    dominantStage: response.meta.dominantStage ?? null,
    evidenceCount,
    queryTimeModelCalls,
    claim: response.duality.claim.text
  };
}

export async function runProfileReportProjectionCoverageBenchmark(
  namespaceId = process.env.BRAIN_PROFILE_REPORT_PROJECTION_NAMESPACE ?? "personal"
): Promise<ProfileReportProjectionCoverageReport> {
  const previousFlag = process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION;
  process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION = "1";
  try {
    const rebuild = await rebuildContractProjectionsNamespace(namespaceId);
    const dbStats = await loadProjectionDbStats(namespaceId);
    const queries: ProfileReportProjectionQueryResult[] = [];
    for (const query of PROFILE_REPORT_QUERIES) {
      queries.push(await runProjectionQuery(namespaceId, query));
    }

    const thresholds = {
      projectionCoverageRate: 0.95,
      p95LatencyMs: 5000,
      maxLatencyMs: 10000
    };
    const latencies = queries.map((entry) => entry.latencyMs);
    const sourceEvidenceViolationCount =
      dbStats.entriesMissingSourceQuote + dbStats.entriesMissingSourceRowId + dbStats.mixedOwnerEntryCount;
    const unsupportedNoEvidenceSuccessCount = queries.filter(
      (entry) => entry.projectionSucceeded && entry.evidenceCount === 0
    ).length;
    const metrics = {
      projectionCoverageRate: rate(queries.filter((entry) => entry.projectionSucceeded).length, queries.length),
      sourceEvidenceViolationCount,
      unsupportedNoEvidenceSuccessCount,
      unknownOwnerCount: queries.filter((entry) => entry.failures.includes("projection_not_succeeded")).length,
      queryTimeModelCalls: queries.reduce((sum, entry) => sum + entry.queryTimeModelCalls, 0),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2))
    };
    const failures: string[] = [];
    if (dbStats.headCount === 0) failures.push("projection_heads_missing");
    if (dbStats.entryCount === 0) failures.push("projection_entries_missing");
    if (metrics.projectionCoverageRate < thresholds.projectionCoverageRate) failures.push("projection_coverage_below_threshold");
    if (metrics.sourceEvidenceViolationCount > 0) failures.push("projection_source_evidence_violation");
    if (metrics.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
    if (metrics.queryTimeModelCalls > 0) failures.push("query_time_model_calls");
    if (metrics.p95LatencyMs > thresholds.p95LatencyMs) failures.push("profile_report_projection_p95_latency_exceeded");
    if (metrics.maxLatencyMs > thresholds.maxLatencyMs) failures.push("profile_report_projection_max_latency_exceeded");
    if (queries.some((entry) => !entry.passed)) failures.push("query_failures");

    return {
      generatedAt: new Date().toISOString(),
      benchmark: "profile_report_projection_coverage",
      namespaceId,
      passed: failures.length === 0,
      thresholds,
      metrics,
      dbStats,
      rebuildCounts: rebuild.counts,
      failures,
      queries
    };
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION;
    } else {
      process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION = previousFlag;
    }
  }
}

function markdownReport(report: ProfileReportProjectionCoverageReport): string {
  const queryLines = report.queries
    .map(
      (entry) =>
        `| ${entry.passed ? "PASS" : "FAIL"} | ${entry.latencyMs} | ${entry.projectionSucceeded ? "yes" : "no"} | ${entry.evidenceCount} | ${entry.failures.join(", ") || "-"} | ${entry.query.replace(/\|/gu, "\\|")} |`
    )
    .join("\n");
  return `# Profile Report Projection Coverage

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- passed: ${report.passed}
- projectionCoverageRate: ${report.metrics.projectionCoverageRate}
- p95LatencyMs: ${report.metrics.p95LatencyMs}
- maxLatencyMs: ${report.metrics.maxLatencyMs}
- sourceEvidenceViolationCount: ${report.metrics.sourceEvidenceViolationCount}
- unsupportedNoEvidenceSuccessCount: ${report.metrics.unsupportedNoEvidenceSuccessCount}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- projectionHeads: ${report.dbStats.headCount}
- projectionEntries: ${report.dbStats.entryCount}

| status | latencyMs | projection | evidence | failures | query |
| --- | ---: | --- | ---: | --- | --- |
${queryLines}
`;
}

export async function runProfileReportProjectionCoverageCli(): Promise<void> {
  try {
    const namespaceArgIndex = process.argv.indexOf("--namespace");
    const namespaceId = namespaceArgIndex >= 0 ? process.argv[namespaceArgIndex + 1] : undefined;
    const report = await runProfileReportProjectionCoverageBenchmark(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `profile-report-projection-coverage-${stamp}.json`);
    const markdownPath = path.join(dir, `profile-report-projection-coverage-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, markdownReport(report));
    console.log(JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures }, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
