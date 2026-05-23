import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool, queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  QUERY_GOLD_FIXTURE_NAMESPACE,
  QUERY_TAXONOMY_GOLD_CASES,
  seedQueryTaxonomyGoldFixture,
  type QueryGoldCase
} from "./query-taxonomy-gold-fixtures.js";
import { runHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

interface McpQueryTaxonomyGoldResult {
  readonly id: string;
  readonly toolName: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly actualContract: string | null;
  readonly actualDomain: string | null;
  readonly actualAnswerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly reviewUnknownRecorded: boolean;
  readonly latencyMs: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface McpQueryTaxonomyGoldReport {
  readonly generatedAt: string;
  readonly benchmark: "mcp_query_taxonomy_gold";
  readonly passed: boolean;
  readonly metrics: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly contractAccuracy: number;
    readonly routeSelectionAccuracy: number;
    readonly answerShapeAccuracy: number;
    readonly abstentionAccuracy: number;
    readonly unknownWithoutReviewUnknownRecordCount: number;
    readonly supportedEvidenceZeroCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly McpQueryTaxonomyGoldResult[];
}

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

function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
}

function payloadEvidenceCount(payload: any): number {
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence.length;
  if (Array.isArray(payload?.evidence)) return payload.evidence.length;
  if (Array.isArray(payload?.tasks)) return payload.tasks.length;
  return 0;
}

function finalClaimSource(payload: any, testCase: QueryGoldCase): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  if (testCase.toolName === "memory.extract_tasks") return "task_extraction";
  return null;
}

function runtimeFlags(): Record<string, string | undefined> {
  return {
    BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION: process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION,
    BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION: process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION,
    BRAIN_ENABLE_SHARED_SOCIAL_GRAPH: process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH,
    BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_RECAP_PROFILE_PROJECTION: process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION
  };
}

function applyRuntimeFlags(): void {
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = "1";
  process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH = "1";
  process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION = "1";
}

function restoreRuntimeFlags(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function queryReviewItemExists(namespaceId: string, queryText: string): Promise<boolean> {
  const rows = await queryRows<{ readonly present: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM taxonomy_review_items
        WHERE namespace_id = $1
          AND example_evidence = $2
          AND status = 'open'
      ) AS present
    `,
    [namespaceId, queryText]
  );
  return rows[0]?.present === true;
}

function namespaceIdForCase(testCase: QueryGoldCase, syntheticNamespace: string): string {
  switch (testCase.namespaceKind) {
    case "personal":
      return "personal";
    case "synthetic":
      return syntheticNamespace;
    case "fixture":
      return QUERY_GOLD_FIXTURE_NAMESPACE;
  }
}

async function runMcpCase(testCase: QueryGoldCase, namespaceId: string): Promise<McpQueryTaxonomyGoldResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(testCase.toolName, {
    namespace_id: namespaceId,
    query: testCase.query,
    ...(testCase.referenceNow ? { reference_now: testCase.referenceNow } : {}),
    limit: 8
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidenceCount = payloadEvidenceCount(payload);
  const actualContract = typeof payload?.queryContract === "string" ? payload.queryContract : null;
  const actualDomain = typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : null;
  const actualAnswerShape = typeof payload?.answerShape === "string" ? payload.answerShape : null;
  const source = finalClaimSource(payload, testCase);
  const reviewRecorded = payload?.reviewUnknown?.recorded === true || (await queryReviewItemExists(namespaceId, testCase.query));
  const failures: string[] = [];

  if (actualContract !== testCase.expectedContract) failures.push("wrong_query_contract");
  if (actualDomain !== testCase.expectedDomain) failures.push("wrong_retrieval_domain");
  if (actualAnswerShape !== testCase.expectedAnswerShape) failures.push("wrong_answer_shape");
  if (
    testCase.expectedFinalClaimSources.length > 0 &&
    !testCase.expectedFinalClaimSources.includes(source ?? "") &&
    !(testCase.shouldAbstain === true && evidenceCount === 0)
  ) {
    failures.push("wrong_final_claim_source");
  }
  for (const term of testCase.expectedTerms) {
    if (!hasTerm(payload, term)) failures.push(`missing_term:${term}`);
  }
  if (testCase.minimumEvidence > 0 && evidenceCount < testCase.minimumEvidence) failures.push("insufficient_evidence");
  if (testCase.shouldAbstain === true && evidenceCount > 0 && source !== "review_unknown") failures.push("should_have_abstained");
  if (actualContract === "review_only" && !reviewRecorded) failures.push("review_unknown_record_missing");
  const queryTimeModelCalls = payload?.meta?.queryTimeGLiNEROrLLMUsed === true ? 1 : Number(payload?.meta?.queryTimeModelCalls ?? 0);
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls_nonzero");

  return {
    id: testCase.id,
    toolName: testCase.toolName,
    namespaceId,
    query: testCase.query,
    actualContract,
    actualDomain,
    actualAnswerShape,
    finalClaimSource: source,
    evidenceCount,
    queryTimeModelCalls,
    reviewUnknownRecorded: reviewRecorded,
    latencyMs,
    passed: failures.length === 0,
    failures
  };
}

export async function runMcpQueryTaxonomyGoldBenchmark(): Promise<McpQueryTaxonomyGoldReport> {
  const previousFlags = runtimeFlags();
  applyRuntimeFlags();
  try {
    const syntheticReport = await runHumanSyntheticWatchBenchmark();
    await seedQueryTaxonomyGoldFixture();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    const results: McpQueryTaxonomyGoldResult[] = [];
    for (const testCase of QUERY_TAXONOMY_GOLD_CASES) {
      results.push(await runMcpCase(testCase, namespaceIdForCase(testCase, syntheticReport.namespaceId)));
    }
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    const latencies = results.map((result) => result.latencyMs);
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "mcp_query_taxonomy_gold",
      passed: failures.length === 0,
      metrics: {
        totalCases: results.length,
        passedCases: results.filter((result) => result.passed).length,
        contractAccuracy: rate(results.filter((result, index) => result.actualContract === QUERY_TAXONOMY_GOLD_CASES[index]?.expectedContract).length, results.length),
        routeSelectionAccuracy: rate(results.filter((result, index) => result.actualDomain === QUERY_TAXONOMY_GOLD_CASES[index]?.expectedDomain).length, results.length),
        answerShapeAccuracy: rate(results.filter((result, index) => result.actualAnswerShape === QUERY_TAXONOMY_GOLD_CASES[index]?.expectedAnswerShape).length, results.length),
        abstentionAccuracy: rate(
          results.filter((result, index) => (QUERY_TAXONOMY_GOLD_CASES[index]?.shouldAbstain === true ? result.evidenceCount === 0 : true)).length,
          results.length
        ),
        unknownWithoutReviewUnknownRecordCount: results.filter((result, index) => QUERY_TAXONOMY_GOLD_CASES[index]?.expectedContract === "review_only" && !result.reviewUnknownRecorded)
          .length,
        supportedEvidenceZeroCount: results.filter((result, index) => QUERY_TAXONOMY_GOLD_CASES[index]?.shouldAbstain !== true && result.evidenceCount === 0).length,
        unsupportedNoEvidenceSuccessCount: results.filter((result, index) => QUERY_TAXONOMY_GOLD_CASES[index]?.shouldAbstain === true && result.evidenceCount > 0).length,
        queryTimeModelCalls: results.reduce((sum, result) => sum + result.queryTimeModelCalls, 0),
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        maxLatencyMs: percentile(latencies, 100)
      },
      failures,
      results
    };
  } finally {
    restoreRuntimeFlags(previousFlags);
  }
}

function markdown(report: McpQueryTaxonomyGoldReport): string {
  return [
    "# MCP Query Taxonomy Gold",
    "",
    `- passed: ${report.passed}`,
    `- totalCases: ${report.metrics.totalCases}`,
    `- contractAccuracy: ${report.metrics.contractAccuracy}`,
    `- routeSelectionAccuracy: ${report.metrics.routeSelectionAccuracy}`,
    `- answerShapeAccuracy: ${report.metrics.answerShapeAccuracy}`,
    `- unknownWithoutReviewUnknownRecordCount: ${report.metrics.unknownWithoutReviewUnknownRecordCount}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runAndWriteMcpQueryTaxonomyGoldBenchmark(): Promise<McpQueryTaxonomyGoldReport> {
  const report = await runMcpQueryTaxonomyGoldBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `mcp-query-taxonomy-gold-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `mcp-query-taxonomy-gold-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`mcp-query-taxonomy-gold failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runMcpQueryTaxonomyGoldCli(): Promise<void> {
  const report = await runAndWriteMcpQueryTaxonomyGoldBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
