import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  QUERY_GOLD_FIXTURE_NAMESPACE,
  QUERY_TAXONOMY_GOLD_CASES,
  seedQueryTaxonomyGoldFixture,
  type QueryGoldCase
} from "./query-taxonomy-gold-fixtures.js";
import {
  applyProjectionRuntimeFlags,
  hasTerm,
  payloadEvidenceCount,
  percentile,
  projectionRuntimeFlags,
  queryTimeModelCallsFromPayload,
  rate,
  restoreProjectionRuntimeFlags
} from "./query-benchmark-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ResidualOwner =
  | "task_source_selection"
  | "task_term_extraction"
  | "temporal_leaf_descent"
  | "temporal_exact_token_rendering"
  | "source_missing"
  | "contract_regression"
  | "none";

interface ResidualScenario {
  readonly id: string;
  readonly expectedResidualOwner: Exclude<ResidualOwner, "none">;
}

export interface McpGoldFidelityResidualRow {
  readonly id: string;
  readonly query: string;
  readonly toolName: string;
  readonly expectedTerms: readonly string[];
  readonly actualTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly residualOwner: ResidualOwner;
  readonly latencyMs: number;
  readonly taskUnrelatedEvidence: boolean;
  readonly passed: boolean;
}

export interface McpGoldFidelityResidualReport {
  readonly generatedAt: string;
  readonly benchmark: "mcp_gold_fidelity_residual_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly mcpGoldFailureCount: number;
    readonly taskOpsMissingTermCount: number;
    readonly temporalExactDateMissingCount: number;
    readonly taskUnrelatedEvidenceCount: number;
    readonly temporalExactTokenPreservationRate: number;
    readonly queryTimeModelCalls: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly McpGoldFidelityResidualRow[];
}

const RESIDUAL_SCENARIOS: readonly ResidualScenario[] = [
  { id: "task_ops_0", expectedResidualOwner: "task_source_selection" },
  { id: "task_ops_2", expectedResidualOwner: "task_source_selection" },
  { id: "task_ops_3", expectedResidualOwner: "task_source_selection" },
  { id: "task_ops_4", expectedResidualOwner: "task_source_selection" },
  { id: "task_ops_5", expectedResidualOwner: "task_source_selection" },
  { id: "temporal_history_4", expectedResidualOwner: "temporal_exact_token_rendering" },
  { id: "temporal_history_5", expectedResidualOwner: "temporal_exact_token_rendering" }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function namespaceIdForCase(testCase: QueryGoldCase): string {
  if (testCase.namespaceKind === "personal") return "personal";
  return QUERY_GOLD_FIXTURE_NAMESPACE;
}

function finalClaimSource(payload: any, testCase: QueryGoldCase): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  if (testCase.toolName === "memory.extract_tasks") return "task_extraction";
  return null;
}

function sourceTrailCount(payload: any): number {
  const direct = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  const section = Array.isArray(payload?.answerSections)
    ? payload.answerSections.reduce((sum: number, section: any) => sum + (Array.isArray(section?.sourceTrail) ? section.sourceTrail.length : 0), 0)
    : 0;
  const tasks = Array.isArray(payload?.tasks)
    ? payload.tasks.reduce((sum: number, task: any) => sum + (Array.isArray(task?.sourceTrail) ? task.sourceTrail.length : 0), 0)
    : 0;
  return direct + section + tasks;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function taskEvidenceLooksUnrelated(payload: any): boolean {
  const text = JSON.stringify(payload ?? null).toLowerCase();
  if (!text.includes("social") && !text.includes("friend")) return false;
  return !/\b(task|tasks|action item|action list|todo|to-do|need to|remaining|finish|review|add stable|projection audit|mcp studio|querycontract)\b/u.test(text);
}

function classifyResidualOwner(params: {
  readonly testCase: QueryGoldCase;
  readonly payload: any;
  readonly missingTerms: readonly string[];
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
}): ResidualOwner {
  if (params.missingTerms.length === 0 && params.evidenceCount >= params.testCase.minimumEvidence && params.queryTimeModelCalls === 0) {
    return "none";
  }
  if (params.queryTimeModelCalls > 0) return "contract_regression";
  if (params.evidenceCount <= 0) return "source_missing";
  const evidenceText = JSON.stringify(params.payload?.evidence ?? params.payload?.duality?.evidence ?? params.payload?.sourceTrail ?? params.payload ?? null);
  const evidenceHasMissingTerms = params.missingTerms.some((term) => hasTerm(evidenceText, term));
  if (params.testCase.id.startsWith("task_ops")) {
    return evidenceHasMissingTerms ? "task_term_extraction" : "task_source_selection";
  }
  if (params.testCase.id.startsWith("temporal_history")) {
    return evidenceHasMissingTerms ? "temporal_exact_token_rendering" : "temporal_leaf_descent";
  }
  return "contract_regression";
}

async function runCase(testCase: QueryGoldCase): Promise<McpGoldFidelityResidualRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(testCase.toolName, {
    namespace_id: namespaceIdForCase(testCase),
    query: testCase.query,
    ...(testCase.referenceNow ? { reference_now: testCase.referenceNow } : {}),
    limit: 8
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const expectedTerms = testCase.expectedTerms;
  const actualTerms = expectedTerms.filter((term) => hasTerm(payload, term));
  const missingTerms = expectedTerms.filter((term) => !hasTerm(payload, term));
  const evidenceCount = payloadEvidenceCount(payload);
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const trailCount = sourceTrailCount(payload);
  const auditCount = claimAuditCount(payload);
  const finalSource = finalClaimSource(payload, testCase);
  const taskUnrelatedEvidence = testCase.id.startsWith("task_ops") && taskEvidenceLooksUnrelated(payload);
  const passed =
    missingTerms.length === 0 &&
    evidenceCount >= testCase.minimumEvidence &&
    trailCount > 0 &&
    auditCount > 0 &&
    queryTimeModelCalls === 0 &&
    !taskUnrelatedEvidence;

  return {
    id: testCase.id,
    query: testCase.query,
    toolName: testCase.toolName,
    expectedTerms,
    actualTerms,
    missingTerms,
    finalClaimSource: finalSource,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    queryTimeModelCalls,
    residualOwner: classifyResidualOwner({ testCase, payload, missingTerms, evidenceCount, queryTimeModelCalls }),
    latencyMs,
    taskUnrelatedEvidence,
    passed
  };
}

function summarizeMetrics(results: readonly McpGoldFidelityResidualRow[]): McpGoldFidelityResidualReport["metrics"] {
  const latencies = results.map((row) => row.latencyMs);
  const temporalRows = results.filter((row) => row.id.startsWith("temporal_history"));
  const temporalExactRows = temporalRows.filter((row) => row.missingTerms.length === 0);
  return {
    mcpGoldFailureCount: results.filter((row) => !row.passed).length,
    taskOpsMissingTermCount: results
      .filter((row) => row.id.startsWith("task_ops"))
      .reduce((sum, row) => sum + row.missingTerms.length, 0),
    temporalExactDateMissingCount: temporalRows.reduce((sum, row) => sum + row.missingTerms.length, 0),
    taskUnrelatedEvidenceCount: results.filter((row) => row.taskUnrelatedEvidence).length,
    temporalExactTokenPreservationRate: rate(temporalExactRows.length, temporalRows.length),
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: results.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: percentile(latencies, 100)
  };
}

function reportPassed(report: McpGoldFidelityResidualReport): boolean {
  const metrics = report.metrics;
  return (
    metrics.mcpGoldFailureCount === 0 &&
    metrics.taskOpsMissingTermCount === 0 &&
    metrics.temporalExactDateMissingCount === 0 &&
    metrics.taskUnrelatedEvidenceCount === 0 &&
    metrics.temporalExactTokenPreservationRate === 1 &&
    metrics.queryTimeModelCalls === 0 &&
    metrics.supportedEmptySourceTrailCount === 0 &&
    metrics.supportedMissingClaimAuditCount === 0 &&
    metrics.p95LatencyMs <= 5000 &&
    metrics.maxLatencyMs <= 10000
  );
}

function toMarkdown(report: McpGoldFidelityResidualReport): string {
  const lines = [
    "# MCP Gold Fidelity Residual Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- sampleCount: ${report.sampleCount}`,
    `- mcpGoldFailureCount: ${report.metrics.mcpGoldFailureCount}`,
    `- taskOpsMissingTermCount: ${report.metrics.taskOpsMissingTermCount}`,
    `- temporalExactDateMissingCount: ${report.metrics.temporalExactDateMissingCount}`,
    `- taskUnrelatedEvidenceCount: ${report.metrics.taskUnrelatedEvidenceCount}`,
    `- temporalExactTokenPreservationRate: ${report.metrics.temporalExactTokenPreservationRate}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Rows",
    ""
  ];
  for (const row of report.results) {
    lines.push(
      `- ${row.id}: passed=${row.passed} owner=${row.residualOwner} missing=${row.missingTerms.length === 0 ? "none" : row.missingTerms.join(", ")} source=${row.finalClaimSource ?? "null"} evidence=${row.evidenceCount} audit=${row.claimAuditCount}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMcpGoldFidelityResidualPack(): Promise<{
  readonly report: McpGoldFidelityResidualReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const previousFlags = projectionRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    await seedQueryTaxonomyGoldFixture();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    const scenarios = new Set(RESIDUAL_SCENARIOS.map((scenario) => scenario.id));
    const cases = QUERY_TAXONOMY_GOLD_CASES.filter((testCase) => scenarios.has(testCase.id));
    const results: McpGoldFidelityResidualRow[] = [];
    for (const testCase of cases) {
      results.push(await runCase(testCase));
    }
    const generatedAt = new Date().toISOString();
    const partialReport: McpGoldFidelityResidualReport = {
      generatedAt,
      benchmark: "mcp_gold_fidelity_residual_pack",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode: "sampled",
        sampleControls: {
          fixtureFirst: true,
          scenarioCount: results.length,
          residualIds: RESIDUAL_SCENARIOS.map((scenario) => scenario.id).join(",")
        }
      }),
      sampleCount: results.length,
      passed: false,
      metrics: summarizeMetrics(results),
      results
    };
    const report = { ...partialReport, passed: reportPassed(partialReport) };
    await mkdir(outputDir(), { recursive: true });
    const stamp = generatedAt.replace(/[:.]/gu, "-");
    const jsonPath = path.join(outputDir(), `mcp-gold-fidelity-residual-pack-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `mcp-gold-fidelity-residual-pack-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return { report, output: { jsonPath, markdownPath } };
  } finally {
    restoreProjectionRuntimeFlags(previousFlags);
  }
}

export async function runMcpGoldFidelityResidualPackCli(): Promise<void> {
  const { report, output } = await runAndWriteMcpGoldFidelityResidualPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
