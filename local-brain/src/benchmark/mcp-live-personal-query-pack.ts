import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { closePool } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { executeMcpTool } from "../mcp/server.js";
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

interface McpLivePersonalQueryResult {
  readonly id: string;
  readonly query: string;
  readonly actualContract: string | null;
  readonly actualDomain: string | null;
  readonly actualAnswerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly selectionTraceCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly queryEmbeddingCacheHit: boolean;
  readonly vectorContribution: string | null;
  readonly fullHumanReadableAnswer: string;
  readonly compactHumanReadableAnswer: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly answerText: string;
}

export interface McpLivePersonalQueryPackReport {
  readonly generatedAt: string;
  readonly benchmark: "mcp_live_personal_query_pack";
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
    readonly supportedSourceTrailZeroCount: number;
    readonly supportedSelectionTraceZeroCount: number;
    readonly fullAnswerCoverage: number;
    readonly compactAnswerCoverage: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly McpLivePersonalQueryResult[];
}

async function runCase(testCase: (typeof LIVE_PERSONAL_QUERY_CASES)[number]): Promise<McpLivePersonalQueryResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(testCase.toolName, {
    namespace_id: "personal",
    query: testCase.query,
    limit: 8,
    detail_mode: "full"
  })) as { readonly structuredContent?: any };
  const compactWrapped = (await executeMcpTool(testCase.toolName, {
    namespace_id: "personal",
    query: testCase.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const compactPayload = compactWrapped.structuredContent ?? {};
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const actualContract = typeof payload?.queryContract === "string" ? payload.queryContract : null;
  const actualDomain = typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : null;
  const actualAnswerShape = typeof payload?.answerShape === "string" ? payload.answerShape : null;
  const finalClaimSource =
    typeof payload?.finalClaimSource === "string"
      ? payload.finalClaimSource
      : typeof payload?.meta?.finalClaimSource === "string"
        ? payload.meta.finalClaimSource
        : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceTrailCount = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  const selectionTraceCount = Array.isArray(payload?.selectionTrace) ? payload.selectionTrace.length : 0;
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const answerText = answerTextFromPayload(payload, testCase.toolName);
  const fullHumanReadableAnswer = typeof payload?.humanReadable?.answer === "string" ? payload.humanReadable.answer : "";
  const compactHumanReadableAnswer = typeof compactPayload?.humanReadable?.answer === "string" ? compactPayload.humanReadable.answer : "";
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
    if (fullHumanReadableAnswer.toLowerCase().includes(term.toLowerCase())) failures.push(`forbidden_full_term:${term}`);
    if (compactHumanReadableAnswer.toLowerCase().includes(term.toLowerCase())) failures.push(`forbidden_compact_term:${term}`);
  }
  if (testCase.minimumEvidence > 0 && evidenceCount < testCase.minimumEvidence) failures.push("insufficient_evidence");
  if (testCase.minimumEvidence > 0 && evidenceCount > 0 && sourceTrailCount === 0) failures.push("missing_source_trail");
  if (testCase.minimumEvidence > 0 && evidenceCount > 0 && selectionTraceCount === 0) failures.push("missing_selection_trace");
  if (testCase.shouldAbstain === true && evidenceCount > 0) failures.push("should_have_abstained");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls_nonzero");
  if (!fullHumanReadableAnswer) failures.push("missing_full_human_readable_answer");
  if (!compactHumanReadableAnswer) failures.push("missing_compact_human_readable_answer");
  if (compactPayload?.queryContract !== payload?.queryContract) failures.push("compact_detail_mode_contract_drift");
  if ((compactPayload?.finalClaimSource ?? null) !== finalClaimSource) failures.push("compact_detail_mode_final_claim_source_drift");
  if (payloadEvidenceCount(compactPayload) !== evidenceCount) failures.push("compact_detail_mode_evidence_drift");

  return {
    id: testCase.id,
    query: testCase.query,
    actualContract,
    actualDomain,
    actualAnswerShape,
    finalClaimSource,
    evidenceCount,
    sourceTrailCount,
    selectionTraceCount,
    queryTimeModelCalls,
    latencyMs,
    queryEmbeddingCacheHit: payload?.queryEmbeddingCacheHit === true,
    vectorContribution: typeof payload?.vectorContribution === "string" ? payload.vectorContribution : null,
    fullHumanReadableAnswer,
    compactHumanReadableAnswer,
    passed: failures.length === 0,
    failures,
    answerText
  };
}

function markdown(report: McpLivePersonalQueryPackReport): string {
  return [
    "# MCP Live Personal Query Pack",
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

export async function runMcpLivePersonalQueryPackBenchmark(): Promise<McpLivePersonalQueryPackReport> {
  const previousFlags = projectionRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    await rebuildContractProjectionsNamespace("personal");
    const results: McpLivePersonalQueryResult[] = [];
    for (const testCase of LIVE_PERSONAL_QUERY_CASES) {
      results.push(await runCase(testCase));
    }
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    const latencies = results.map((result) => result.latencyMs);
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "mcp_live_personal_query_pack",
      passed: failures.length === 0,
      metrics: {
        totalCases: results.length,
        passedCases: results.filter((result) => result.passed).length,
        contractAccuracy: rate(results.filter((result, index) => result.actualContract === LIVE_PERSONAL_QUERY_CASES[index]?.expectedContract).length, results.length),
        retrievalDomainAccuracy: rate(results.filter((result, index) => result.actualDomain === LIVE_PERSONAL_QUERY_CASES[index]?.expectedDomain).length, results.length),
        answerShapeAccuracy: rate(results.filter((result, index) => result.actualAnswerShape === LIVE_PERSONAL_QUERY_CASES[index]?.expectedAnswerShape).length, results.length),
        abstentionAccuracy: rate(results.filter((result, index) => (LIVE_PERSONAL_QUERY_CASES[index]?.shouldAbstain === true ? result.evidenceCount === 0 : true)).length, results.length),
        supportedEvidenceZeroCount: results.filter((result, index) => LIVE_PERSONAL_QUERY_CASES[index]?.shouldAbstain !== true && result.evidenceCount === 0).length,
        unsupportedNoEvidenceSuccessCount: results.filter((result, index) => LIVE_PERSONAL_QUERY_CASES[index]?.shouldAbstain === true && result.evidenceCount > 0).length,
        supportedSourceTrailZeroCount: results.filter((result, index) => LIVE_PERSONAL_QUERY_CASES[index]?.shouldAbstain !== true && result.evidenceCount > 0 && result.sourceTrailCount === 0).length,
        supportedSelectionTraceZeroCount: results.filter((result, index) => LIVE_PERSONAL_QUERY_CASES[index]?.shouldAbstain !== true && result.evidenceCount > 0 && result.selectionTraceCount === 0).length,
        fullAnswerCoverage: rate(results.filter((result) => result.fullHumanReadableAnswer.length > 0).length, results.length),
        compactAnswerCoverage: rate(results.filter((result) => result.compactHumanReadableAnswer.length > 0).length, results.length),
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

export async function runAndWriteMcpLivePersonalQueryPackBenchmark(): Promise<McpLivePersonalQueryPackReport> {
  const report = await runMcpLivePersonalQueryPackBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `mcp-live-personal-query-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `mcp-live-personal-query-pack-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`mcp-live-personal-query-pack failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runMcpLivePersonalQueryPackCli(): Promise<void> {
  const report = await runAndWriteMcpLivePersonalQueryPackBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
