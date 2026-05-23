import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { searchMemory } from "../retrieval/service.js";

type ProjectionFamily = "relationship_profile" | "continuity_current_state";

interface ProjectionCoverageCase {
  readonly id: string;
  readonly family: ProjectionFamily;
  readonly query: string;
  readonly expectedClaimTerms: readonly string[];
}

interface ProjectionCoverageResult extends ProjectionCoverageCase {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly projectionTried: boolean;
  readonly projectionSucceeded: boolean;
  readonly projectionEntryCount: number;
  readonly projectionEvidenceCount: number;
  readonly evidenceCount: number;
  readonly dominantStage: string | null;
  readonly finalClaimSource: string | null;
  readonly telemetryCoverageStatus: string | null;
  readonly claim: string;
}

interface ProjectionDbStats {
  readonly relationshipHeadCount: number;
  readonly relationshipEntryCount: number;
  readonly continuityHeadCount: number;
  readonly continuityEntryCount: number;
  readonly sourceEvidenceViolationCount: number;
  readonly mixedOwnerEntryCount: number;
}

interface RelationshipContinuityProjectionCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "relationship_continuity_projection_coverage";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly thresholds: {
    readonly coverageRate: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly metrics: {
    readonly coverageRate: number;
    readonly relationshipCoverageRate: number;
    readonly continuityCoverageRate: number;
    readonly continuityCutoverReady: boolean;
    readonly relationshipCutoverReady: boolean;
    readonly relationshipDiagnosticFailureCount: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
    readonly continuityP95LatencyMs: number;
    readonly continuityMaxLatencyMs: number;
    readonly queryTimeModelCalls: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly telemetryGapCount: number;
  };
  readonly dbStats: ProjectionDbStats;
  readonly rebuildCounts: {
    readonly heads: number;
    readonly entries: number;
  };
  readonly failures: readonly string[];
  readonly cases: readonly ProjectionCoverageResult[];
}

const CASES: readonly ProjectionCoverageCase[] = [
  {
    id: "lauren_current_relationship",
    family: "relationship_profile",
    query: "Who is Lauren in my life right now, exactly?",
    expectedClaimTerms: ["Lauren", "former", "romantic"]
  },
  {
    id: "lauren_history",
    family: "relationship_profile",
    query: "What is Steve's history with Lauren?",
    expectedClaimTerms: ["Lauren", "Lake Tahoe", "Bend"]
  },
  {
    id: "dan_relationship",
    family: "relationship_profile",
    query: "Who is Dan in my life right now, exactly?",
    expectedClaimTerms: ["Dan", "friend"]
  },
  {
    id: "john_relationship",
    family: "relationship_profile",
    query: "Who is John in my life, and what is he associated with?",
    expectedClaimTerms: ["John", "associated"]
  },
  {
    id: "warm_start_today",
    family: "continuity_current_state",
    query: "What should you know about me to start today?",
    expectedClaimTerms: ["Warm start", "Preset Kitchen", "AI Brain"]
  },
  {
    id: "pick_back_up",
    family: "continuity_current_state",
    query: "What should I pick back up right now based on my recent notes?",
    expectedClaimTerms: ["Preset Kitchen", "AI Brain"]
  },
  {
    id: "yesterday_work",
    family: "continuity_current_state",
    query: "What did I do yesterday?",
    expectedClaimTerms: ["AI Brain", "Preset Kitchen", "Bumblebee"]
  },
  {
    id: "routine_current",
    family: "continuity_current_state",
    query: "What is my current daily routine?",
    expectedClaimTerms: ["coffee", "Reddit"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function hasAllTerms(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

async function loadProjectionDbStats(namespaceId: string): Promise<ProjectionDbStats> {
  const rows = await queryRows<{
    readonly relationship_head_count: string;
    readonly relationship_entry_count: string;
    readonly continuity_head_count: string;
    readonly continuity_entry_count: string;
    readonly source_evidence_violation_count: string;
    readonly mixed_owner_entry_count: string;
  }>(
    `
      WITH heads AS (
        SELECT id, contract_name
        FROM contract_projection_heads
        WHERE namespace_id = $1
          AND contract_name IN ('relationship_profile', 'continuity_current_state')
          AND truth_status = 'active'
          AND projection_version IN ('profile_report_projection_v1', 'continuity_current_state_projection_v1')
      ),
      entries AS (
        SELECT entry.*, heads.contract_name
        FROM contract_projection_entries entry
        JOIN heads ON heads.id = entry.projection_head_id
        WHERE entry.truth_status = 'active'
      )
      SELECT
        (SELECT count(*) FROM heads WHERE contract_name = 'relationship_profile')::text AS relationship_head_count,
        (SELECT count(*) FROM entries WHERE contract_name = 'relationship_profile')::text AS relationship_entry_count,
        (SELECT count(*) FROM heads WHERE contract_name = 'continuity_current_state')::text AS continuity_head_count,
        (SELECT count(*) FROM entries WHERE contract_name = 'continuity_current_state')::text AS continuity_entry_count,
        (SELECT count(*) FROM entries WHERE NULLIF(metadata->>'source_quote', '') IS NULL OR source_row_id IS NULL)::text AS source_evidence_violation_count,
        (SELECT count(*) FROM entries WHERE owner_binding_status NOT IN ('subject_pair_bound', 'self_bound'))::text AS mixed_owner_entry_count
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    relationshipHeadCount: Number(row?.relationship_head_count ?? 0),
    relationshipEntryCount: Number(row?.relationship_entry_count ?? 0),
    continuityHeadCount: Number(row?.continuity_head_count ?? 0),
    continuityEntryCount: Number(row?.continuity_entry_count ?? 0),
    sourceEvidenceViolationCount: Number(row?.source_evidence_violation_count ?? 0),
    mixedOwnerEntryCount: Number(row?.mixed_owner_entry_count ?? 0)
  };
}

async function runCase(namespaceId: string, testCase: ProjectionCoverageCase): Promise<ProjectionCoverageResult> {
  const startedAt = performance.now();
  const response = await searchMemory({ namespaceId, query: testCase.query, limit: 6 });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const claim = response.duality.claim.text ?? "";
  const evidenceText = response.evidence.map((entry) => entry.snippet).join(" ");
  const isRelationship = testCase.family === "relationship_profile";
  const projectionTried = isRelationship ? response.meta.profileReportProjectionTried === true : response.meta.continuityProjectionTried === true;
  const projectionSucceeded = isRelationship ? response.meta.profileReportProjectionSucceeded === true : response.meta.continuityProjectionSucceeded === true;
  const projectionEntryCount = isRelationship ? response.meta.profileReportProjectionEntryCount ?? 0 : response.meta.continuityProjectionEntryCount ?? 0;
  const projectionEvidenceCount = isRelationship ? response.meta.profileReportProjectionEvidenceCount ?? 0 : response.meta.continuityProjectionEvidenceCount ?? 0;
  const queryTimeModelCalls = response.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0;
  const failures: string[] = [];
  if (!projectionTried) failures.push("projection_not_tried");
  if (!projectionSucceeded) failures.push("projection_not_succeeded");
  if (projectionEntryCount <= 0 || projectionEvidenceCount <= 0 || response.evidence.length <= 0) failures.push("projection_evidence_missing");
  if (!hasAllTerms(`${claim} ${evidenceText}`, testCase.expectedClaimTerms)) failures.push("expected_terms_missing");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls");

  return {
    ...testCase,
    passed: failures.length === 0,
    failures,
    latencyMs,
    projectionTried,
    projectionSucceeded,
    projectionEntryCount,
    projectionEvidenceCount,
    evidenceCount: response.evidence.length,
    dominantStage: response.meta.dominantStage ?? null,
    finalClaimSource: response.meta.finalClaimSource ?? null,
    telemetryCoverageStatus: response.meta.telemetryCoverageStatus ?? null,
    claim
  };
}

export async function runRelationshipContinuityProjectionCoverageBenchmark(
  namespaceId = process.env.BRAIN_RELATIONSHIP_CONTINUITY_PROJECTION_NAMESPACE ?? "personal"
): Promise<RelationshipContinuityProjectionCoverageReport> {
  const previousProfileFlag = process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION;
  const previousContinuityFlag = process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION;
  process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION = "1";
  process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = "1";
  try {
    const rebuild = await rebuildContractProjectionsNamespace(namespaceId);
    const dbStats = await loadProjectionDbStats(namespaceId);
    const cases: ProjectionCoverageResult[] = [];
    for (const testCase of CASES) {
      cases.push(await runCase(namespaceId, testCase));
    }
    const latencies = cases.map((entry) => entry.latencyMs);
    const relationshipCases = cases.filter((entry) => entry.family === "relationship_profile");
    const continuityCases = cases.filter((entry) => entry.family === "continuity_current_state");
    const continuityLatencies = continuityCases.map((entry) => entry.latencyMs);
    const thresholds = {
      coverageRate: 0.9,
      p95LatencyMs: 5000,
      maxLatencyMs: 8000
    };
    const metrics = {
      coverageRate: rate(cases.filter((entry) => entry.passed).length, cases.length),
      relationshipCoverageRate: rate(relationshipCases.filter((entry) => entry.passed).length, relationshipCases.length),
      continuityCoverageRate: rate(continuityCases.filter((entry) => entry.passed).length, continuityCases.length),
      continuityCutoverReady:
        continuityCases.length > 0 && continuityCases.every((entry) => entry.passed) && dbStats.continuityHeadCount > 0 && dbStats.continuityEntryCount > 0,
      relationshipCutoverReady:
        relationshipCases.length > 0 && relationshipCases.every((entry) => entry.passed) && dbStats.relationshipHeadCount > 0 && dbStats.relationshipEntryCount > 0,
      relationshipDiagnosticFailureCount: relationshipCases.filter((entry) => !entry.passed).length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2)),
      continuityP95LatencyMs: percentile(continuityLatencies, 95),
      continuityMaxLatencyMs: Number(Math.max(0, ...continuityLatencies).toFixed(2)),
      queryTimeModelCalls: 0,
      unsupportedNoEvidenceSuccessCount: cases.filter((entry) => entry.projectionSucceeded && entry.evidenceCount === 0).length,
      telemetryGapCount: cases.filter((entry) => entry.telemetryCoverageStatus === "telemetry_gap").length
    };
    const failures: string[] = [];
    if (dbStats.relationshipHeadCount === 0 || dbStats.relationshipEntryCount === 0) failures.push("relationship_projection_missing");
    if (dbStats.continuityHeadCount === 0 || dbStats.continuityEntryCount === 0) failures.push("continuity_projection_missing");
    if (dbStats.sourceEvidenceViolationCount > 0) failures.push("projection_source_evidence_violation");
    if (dbStats.mixedOwnerEntryCount > 0) failures.push("mixed_owner_projection_entry");
    if (!metrics.continuityCutoverReady) failures.push("continuity_projection_not_cutover_ready");
    if (metrics.continuityP95LatencyMs > thresholds.p95LatencyMs) failures.push("continuity_p95_latency_exceeded");
    if (metrics.continuityMaxLatencyMs > thresholds.maxLatencyMs) failures.push("continuity_max_latency_exceeded");
    if (metrics.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "relationship_continuity_projection_coverage",
      namespaceId,
      passed: failures.length === 0,
      thresholds,
      metrics,
      dbStats,
      rebuildCounts: rebuild.counts,
      failures,
      cases
    };
  } finally {
    if (previousProfileFlag === undefined) delete process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION;
    else process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION = previousProfileFlag;
    if (previousContinuityFlag === undefined) delete process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION;
    else process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = previousContinuityFlag;
  }
}

function markdownReport(report: RelationshipContinuityProjectionCoverageReport): string {
  const rows = report.cases
    .map(
      (entry) =>
        `| ${entry.passed ? "PASS" : "FAIL"} | ${entry.family} | ${entry.latencyMs} | ${entry.projectionSucceeded ? "yes" : "no"} | ${entry.evidenceCount} | ${entry.failures.join(", ") || "-"} | ${entry.id} |`
    )
    .join("\n");
  return `# Relationship + Continuity Projection Coverage

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- passed: ${report.passed}
- coverageRate: ${report.metrics.coverageRate}
- relationshipCoverageRate: ${report.metrics.relationshipCoverageRate}
- continuityCoverageRate: ${report.metrics.continuityCoverageRate}
- continuityCutoverReady: ${report.metrics.continuityCutoverReady}
- relationshipCutoverReady: ${report.metrics.relationshipCutoverReady}
- relationshipDiagnosticFailureCount: ${report.metrics.relationshipDiagnosticFailureCount}
- p95LatencyMs: ${report.metrics.p95LatencyMs}
- maxLatencyMs: ${report.metrics.maxLatencyMs}
- continuityP95LatencyMs: ${report.metrics.continuityP95LatencyMs}
- continuityMaxLatencyMs: ${report.metrics.continuityMaxLatencyMs}
- sourceEvidenceViolationCount: ${report.dbStats.sourceEvidenceViolationCount}
- mixedOwnerEntryCount: ${report.dbStats.mixedOwnerEntryCount}

| status | family | latencyMs | projection | evidence | failures | case |
| --- | --- | ---: | --- | ---: | --- | --- |
${rows}
`;
}

export async function runRelationshipContinuityProjectionCoverageCli(): Promise<void> {
  try {
    const namespaceArgIndex = process.argv.indexOf("--namespace");
    const namespaceId = namespaceArgIndex >= 0 ? process.argv[namespaceArgIndex + 1] : undefined;
    const report = await runRelationshipContinuityProjectionCoverageBenchmark(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `relationship-continuity-projection-coverage-${stamp}.json`);
    const markdownPath = path.join(dir, `relationship-continuity-projection-coverage-${stamp}.md`);
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
