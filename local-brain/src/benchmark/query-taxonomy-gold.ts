import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool } from "../db/client.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";
import { extractTaskMemory, searchMemory } from "../retrieval/service.js";
import {
  QUERY_GOLD_FIXTURE_NAMESPACE,
  QUERY_TAXONOMY_GOLD_CASES,
  seedQueryTaxonomyGoldFixture,
  type QueryGoldCase
} from "./query-taxonomy-gold-fixtures.js";
import { runHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

interface QueryTaxonomyGoldResult {
  readonly id: string;
  readonly toolName: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedContract: string;
  readonly actualContract: string | null;
  readonly expectedDomain: string;
  readonly actualDomain: string | null;
  readonly expectedAnswerShape: string;
  readonly actualAnswerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly answerText: string;
}

export interface QueryTaxonomyGoldReport {
  readonly generatedAt: string;
  readonly benchmark: "query_taxonomy_gold";
  readonly passed: boolean;
  readonly namespaces: {
    readonly personal: string;
    readonly synthetic: string;
    readonly fixture: string;
  };
  readonly metrics: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly contractAccuracy: number;
    readonly retrievalDomainAccuracy: number;
    readonly answerShapeAccuracy: number;
    readonly supportedEvidenceZeroCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly QueryTaxonomyGoldResult[];
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

function answerTextFromPayload(payload: any, toolName: string): string {
  if (toolName === "memory.extract_tasks") {
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    return tasks
      .map((task: any) => (typeof task?.title === "string" ? task.title : typeof task?.text === "string" ? task.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  if (typeof payload?.summaryText === "string") return payload.summaryText;
  return "";
}

function answerShapeFromPayload(payload: any, testCase: QueryGoldCase): string | null {
  if (testCase.toolName === "memory.extract_tasks") return "list";
  return typeof payload?.meta?.queryContractAnswerShape === "string" ? payload.meta.queryContractAnswerShape : inferQueryContract(testCase.query).answerShape;
}

function finalClaimSourceFromPayload(payload: any, testCase: QueryGoldCase): string | null {
  if (testCase.toolName === "memory.extract_tasks") return "task_extraction";
  return typeof payload?.meta?.finalClaimSource === "string"
    ? payload.meta.finalClaimSource
    : typeof payload?.meta?.finalRouteFamily === "string"
      ? payload.meta.finalRouteFamily
      : null;
}

function queryTimeModelCallsFromPayload(payload: any): number {
  if (payload?.meta?.queryTimeGLiNEROrLLMUsed === true) return 1;
  if (typeof payload?.meta?.queryTimeModelCalls === "number") return payload.meta.queryTimeModelCalls;
  return 0;
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

async function runRuntimeCase(testCase: QueryGoldCase, namespaceId: string): Promise<QueryTaxonomyGoldResult> {
  const startedAt = performance.now();
  const payload: any =
    testCase.toolName === "memory.extract_tasks"
      ? await extractTaskMemory({
          query: testCase.query,
          namespaceId,
          referenceNow: testCase.referenceNow,
          limit: 8
        })
      : await searchMemory({
          query: testCase.query,
          namespaceId,
          referenceNow: testCase.referenceNow,
          limit: 8
        });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const inferred = inferQueryContract(testCase.query);
  const actualContract =
    testCase.toolName === "memory.extract_tasks"
      ? inferred.contractName
      : typeof payload?.meta?.queryContractName === "string"
        ? payload.meta.queryContractName
        : inferred.contractName;
  const actualDomain =
    testCase.toolName === "memory.extract_tasks"
      ? inferred.retrievalDomain
      : typeof payload?.meta?.queryContractRetrievalDomain === "string"
        ? payload.meta.queryContractRetrievalDomain
        : inferred.retrievalDomain;
  const actualAnswerShape = answerShapeFromPayload(payload, testCase);
  const finalClaimSource = finalClaimSourceFromPayload(payload, testCase);
  const evidenceCount = payloadEvidenceCount(payload);
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const answerText = answerTextFromPayload(payload, testCase.toolName);
  const failures: string[] = [];

  if (actualContract !== testCase.expectedContract) failures.push("wrong_query_contract");
  if (actualDomain !== testCase.expectedDomain) failures.push("wrong_retrieval_domain");
  if (actualAnswerShape !== testCase.expectedAnswerShape) failures.push("wrong_answer_shape");
  if (
    testCase.expectedFinalClaimSources.length > 0 &&
    !testCase.expectedFinalClaimSources.includes(finalClaimSource ?? "") &&
    !(testCase.shouldAbstain === true && evidenceCount === 0)
  ) {
    failures.push("wrong_final_claim_source");
  }
  for (const term of testCase.expectedTerms) {
    if (!hasTerm({ payload, answerText }, term)) failures.push(`missing_term:${term}`);
  }
  if (testCase.minimumEvidence > 0 && evidenceCount < testCase.minimumEvidence) failures.push("insufficient_evidence");
  if (testCase.shouldAbstain === true && evidenceCount > 0 && finalClaimSource !== "review_unknown") failures.push("should_have_abstained");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls_nonzero");

  return {
    id: testCase.id,
    toolName: testCase.toolName,
    namespaceId,
    query: testCase.query,
    expectedContract: testCase.expectedContract,
    actualContract,
    expectedDomain: testCase.expectedDomain,
    actualDomain,
    expectedAnswerShape: testCase.expectedAnswerShape,
    actualAnswerShape,
    finalClaimSource,
    evidenceCount,
    queryTimeModelCalls,
    latencyMs,
    passed: failures.length === 0,
    failures,
    answerText
  };
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

export async function runQueryTaxonomyGoldBenchmark(): Promise<QueryTaxonomyGoldReport> {
  const previousFlags = runtimeFlags();
  applyRuntimeFlags();
  try {
    const syntheticReport = await runHumanSyntheticWatchBenchmark();
    await seedQueryTaxonomyGoldFixture();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    const results: QueryTaxonomyGoldResult[] = [];
    for (const testCase of QUERY_TAXONOMY_GOLD_CASES) {
      results.push(await runRuntimeCase(testCase, namespaceIdForCase(testCase, syntheticReport.namespaceId)));
    }
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    const latencies = results.map((result) => result.latencyMs);
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "query_taxonomy_gold",
      passed: failures.length === 0,
      namespaces: {
        personal: "personal",
        synthetic: syntheticReport.namespaceId,
        fixture: QUERY_GOLD_FIXTURE_NAMESPACE
      },
      metrics: {
        totalCases: results.length,
        passedCases: results.filter((result) => result.passed).length,
        contractAccuracy: rate(results.filter((result) => result.actualContract === result.expectedContract).length, results.length),
        retrievalDomainAccuracy: rate(results.filter((result) => result.actualDomain === result.expectedDomain).length, results.length),
        answerShapeAccuracy: rate(results.filter((result) => result.actualAnswerShape === result.expectedAnswerShape).length, results.length),
        supportedEvidenceZeroCount: results.filter((result) => !QUERY_TAXONOMY_GOLD_CASES.find((row) => row.id === result.id)?.shouldAbstain && result.evidenceCount === 0).length,
        unsupportedNoEvidenceSuccessCount: results.filter((result) => {
          const definition = QUERY_TAXONOMY_GOLD_CASES.find((row) => row.id === result.id);
          return definition?.shouldAbstain === true && result.evidenceCount > 0;
        }).length,
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

function markdown(report: QueryTaxonomyGoldReport): string {
  return [
    "# Query Taxonomy Gold",
    "",
    `- passed: ${report.passed}`,
    `- totalCases: ${report.metrics.totalCases}`,
    `- contractAccuracy: ${report.metrics.contractAccuracy}`,
    `- retrievalDomainAccuracy: ${report.metrics.retrievalDomainAccuracy}`,
    `- answerShapeAccuracy: ${report.metrics.answerShapeAccuracy}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runAndWriteQueryTaxonomyGoldBenchmark(): Promise<QueryTaxonomyGoldReport> {
  const report = await runQueryTaxonomyGoldBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `query-taxonomy-gold-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `query-taxonomy-gold-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`query-taxonomy-gold failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runQueryTaxonomyGoldCli(): Promise<void> {
  const report = await runAndWriteQueryTaxonomyGoldBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
