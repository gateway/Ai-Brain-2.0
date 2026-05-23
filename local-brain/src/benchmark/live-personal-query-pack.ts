import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { closePool } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { searchMemory } from "../retrieval/service.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";
import { LIVE_PERSONAL_QUERY_CASES } from "./live-personal-query-fixtures.js";
import {
  answerTextFromPayload,
  applyProjectionRuntimeFlags,
  benchmarkOutputDir,
  payloadEvidenceCount,
  percentile,
  projectionRuntimeFlags,
  queryTimeModelCallsFromPayload,
  rate,
  restoreProjectionRuntimeFlags
} from "./query-benchmark-utils.js";

interface LivePersonalQueryResult {
  readonly id: string;
  readonly query: string;
  readonly actualContract: string | null;
  readonly actualDomain: string | null;
  readonly actualAnswerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly queryEmbeddingCacheHit: boolean;
  readonly vectorContribution: string | null;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly answerText: string;
}

export interface LivePersonalQueryPackReport {
  readonly generatedAt: string;
  readonly benchmark: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly contractAccuracy: number;
    readonly retrievalDomainAccuracy: number;
    readonly answerShapeAccuracy: number;
    readonly abstentionAccuracy: number;
    readonly supportedEvidenceZeroCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly LivePersonalQueryResult[];
}

async function runCase(testCase: (typeof LIVE_PERSONAL_QUERY_CASES)[number]): Promise<LivePersonalQueryResult> {
  const startedAt = performance.now();
  const payload = await searchMemory({
    query: testCase.query,
    namespaceId: "personal",
    limit: 8
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const inferred = inferQueryContract(testCase.query);
  const actualContract = typeof payload?.meta?.queryContractName === "string" ? payload.meta.queryContractName : inferred.contractName;
  const actualDomain =
    typeof payload?.meta?.queryContractRetrievalDomain === "string" ? payload.meta.queryContractRetrievalDomain : inferred.retrievalDomain;
  const actualAnswerShape =
    typeof payload?.meta?.queryContractAnswerShape === "string" ? payload.meta.queryContractAnswerShape : inferred.answerShape;
  const finalClaimSource =
    typeof payload?.meta?.finalClaimSource === "string"
      ? payload.meta.finalClaimSource
      : typeof payload?.meta?.finalRouteFamily === "string"
        ? payload.meta.finalRouteFamily
        : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const answerText = answerTextFromPayload(payload);
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
    if (!answerText.toLowerCase().includes(term.toLowerCase())) failures.push(`missing_term:${term}`);
  }
  for (const term of testCase.forbiddenTerms ?? []) {
    if (answerText.toLowerCase().includes(term.toLowerCase())) failures.push(`forbidden_term:${term}`);
  }
  if (testCase.minimumEvidence > 0 && evidenceCount < testCase.minimumEvidence) failures.push("insufficient_evidence");
  if (testCase.shouldAbstain === true && evidenceCount > 0) failures.push("should_have_abstained");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls_nonzero");

  return {
    id: testCase.id,
    query: testCase.query,
    actualContract,
    actualDomain,
    actualAnswerShape,
    finalClaimSource,
    evidenceCount,
    queryTimeModelCalls,
    latencyMs,
    queryEmbeddingCacheHit: payload?.meta?.queryEmbeddingCacheHit === true,
    vectorContribution: typeof payload?.meta?.vectorContribution === "string" ? payload.meta.vectorContribution : null,
    passed: failures.length === 0,
    failures,
    answerText
  };
}

function markdown(report: LivePersonalQueryPackReport): string {
  return [
    "# Live Personal Query Pack",
    "",
    `- passed: ${report.passed}`,
    `- totalCases: ${report.metrics.totalCases}`,
    `- passedCases: ${report.metrics.passedCases}`,
    `- contractAccuracy: ${report.metrics.contractAccuracy}`,
    `- retrievalDomainAccuracy: ${report.metrics.retrievalDomainAccuracy}`,
    `- answerShapeAccuracy: ${report.metrics.answerShapeAccuracy}`,
    `- abstentionAccuracy: ${report.metrics.abstentionAccuracy}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runLivePersonalQueryPackBenchmark(params?: {
  readonly benchmarkName?: string;
  readonly cases?: readonly (typeof LIVE_PERSONAL_QUERY_CASES)[number][];
}): Promise<LivePersonalQueryPackReport> {
  const previousFlags = projectionRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    const cases = params?.cases ?? LIVE_PERSONAL_QUERY_CASES;
    await rebuildContractProjectionsNamespace("personal");
    const results: LivePersonalQueryResult[] = [];
    for (const testCase of cases) {
      results.push(await runCase(testCase));
    }
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    const latencies = results.map((result) => result.latencyMs);
    return {
      generatedAt: new Date().toISOString(),
      benchmark: params?.benchmarkName ?? "live_personal_query_pack",
      passed: failures.length === 0,
      metrics: {
        totalCases: results.length,
        passedCases: results.filter((result) => result.passed).length,
        contractAccuracy: rate(results.filter((result, index) => result.actualContract === cases[index]?.expectedContract).length, results.length),
        retrievalDomainAccuracy: rate(results.filter((result, index) => result.actualDomain === cases[index]?.expectedDomain).length, results.length),
        answerShapeAccuracy: rate(results.filter((result, index) => result.actualAnswerShape === cases[index]?.expectedAnswerShape).length, results.length),
        abstentionAccuracy: rate(results.filter((result, index) => (cases[index]?.shouldAbstain === true ? result.evidenceCount === 0 : true)).length, results.length),
        supportedEvidenceZeroCount: results.filter((result, index) => cases[index]?.shouldAbstain !== true && result.evidenceCount === 0).length,
        unsupportedNoEvidenceSuccessCount: results.filter((result, index) => cases[index]?.shouldAbstain === true && result.evidenceCount > 0).length,
        queryTimeModelCalls: results.reduce((sum, result) => sum + result.queryTimeModelCalls, 0),
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        maxLatencyMs: percentile(latencies, 100)
      },
      failures,
      results
    };
  } finally {
    restoreProjectionRuntimeFlags(previousFlags);
  }
}

export async function runAndWriteLivePersonalQueryPackBenchmark(): Promise<LivePersonalQueryPackReport> {
  const report = await runLivePersonalQueryPackBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `live-personal-query-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `live-personal-query-pack-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`live-personal-query-pack failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runLivePersonalQueryPackCli(): Promise<void> {
  const report = await runAndWriteLivePersonalQueryPackBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
