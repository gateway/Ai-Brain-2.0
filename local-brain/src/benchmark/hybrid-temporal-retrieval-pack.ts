import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_calendar" | "memory.extract_tasks";

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedRecallChannel: "graph" | "typed_read_model" | "temporal" | "task_projection";
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "place_friend_metadata_filter",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    expectedRecallChannel: "graph"
  },
  {
    id: "event_window_july",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    expectedTerms: ["mid-to-late July", "US"],
    expectedRecallChannel: "temporal"
  },
  {
    id: "travel_task_lifecycle",
    toolName: "memory.extract_tasks",
    query: "What are the open travel tasks from my recent travel planning notes, excluding older unrelated tasks?",
    expectedTerms: ["Store Jeep", "RV", "driver"],
    expectedRecallChannel: "task_projection"
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function hasTerm(payload: any, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
}

function metaForPayload(payload: any): Record<string, unknown> {
  return payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
}

function inferRecallChannels(payload: any): readonly string[] {
  const meta = metaForPayload(payload);
  const direct = Array.isArray(meta.recallChannels)
    ? meta.recallChannels.filter((item): item is string => typeof item === "string")
    : Array.isArray(payload.recallChannels)
      ? payload.recallChannels.filter((item: unknown): item is string => typeof item === "string")
      : [];
  const inferred = new Set<string>(direct);
  const finalClaimSource = String(payload.finalClaimSource ?? meta.finalClaimSource ?? "");
  const contract = String(payload.queryContract ?? "");
  const domain = String(payload.retrievalDomain ?? "");
  if (/shared_social_graph|relationship|graph/iu.test(`${finalClaimSource} ${contract} ${domain}`)) inferred.add("graph");
  if (/typed_temporal|temporal_event|calendar/iu.test(`${finalClaimSource} ${contract} ${domain}`)) inferred.add("temporal");
  if (/task_extraction|task_list|task_item/iu.test(`${finalClaimSource} ${contract} ${domain}`)) inferred.add("task_projection");
  if (/typed|projection|read_model/iu.test(`${finalClaimSource} ${contract} ${domain}`)) inferred.add("typed_read_model");
  if (payload.vectorContribution === "candidate_pool" || meta.vectorContribution === "candidate_pool") inferred.add("vector");
  return [...inferred].sort();
}

async function runScenario(scenario: Scenario): Promise<any> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detailMode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const vectorAuthoritative = payload?.meta?.vectorContribution === "final_support";
  const meta = metaForPayload(payload);
  const filterTrace = Array.isArray(meta.filterTrace) ? meta.filterTrace : Array.isArray(payload.filterTrace) ? payload.filterTrace : [];
  const recallChannels = inferRecallChannels(payload);
  const candidateCountsByStage = meta.candidateCountsByStage && typeof meta.candidateCountsByStage === "object" ? meta.candidateCountsByStage : payload.candidateCountsByStage ?? {};
  const rowsScannedByStage = meta.rowsScannedByStage && typeof meta.rowsScannedByStage === "object" ? meta.rowsScannedByStage : payload.rowsScannedByStage ?? {};
  return {
    ...scenario,
    finalClaimSource: payload.finalClaimSource ?? null,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    missingTerms,
    recallChannels,
    recallTelemetryPresent: recallChannels.length > 0,
    expectedRecallChannelPresent: recallChannels.includes(scenario.expectedRecallChannel),
    lexicalCandidateCount: Number((candidateCountsByStage as any).lexical_load ?? 0),
    vectorCandidateCount: Number((candidateCountsByStage as any).vector_recall ?? 0),
    typedReadModelCandidateCount: Number((candidateCountsByStage as any).typed_temporal_anchor ?? (candidateCountsByStage as any).typed_task_extraction_general_fast_path ?? 0),
    graphCandidateCount: Number((candidateCountsByStage as any).shared_social_graph ?? 0),
    sourceTopicCandidateCount: Number((candidateCountsByStage as any).source_topic_report ?? 0),
    rowsScannedByStage,
    rerankDecision: typeof meta.rerankDecision === "string" ? meta.rerankDecision : payload.rerankDecision ?? null,
    filterTrace,
    finalSelectionReason: typeof meta.finalSelectionReason === "string" ? meta.finalSelectionReason : payload.finalSelectionReason ?? null,
    vectorAuthoritative,
    filterBeforeVectorFinalSelection: scenario.toolName !== "memory.search" || filterTrace.length > 0 || meta.rerankDecision === "metadata_first",
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed:
      missingTerms.length === 0 &&
      !vectorAuthoritative &&
      recallChannels.includes(scenario.expectedRecallChannel) &&
      payloadEvidenceCount(payload) > 0 &&
      queryTimeModelCallsFromPayload(payload) === 0
  };
}

export async function runAndWriteHybridTemporalRetrievalPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  const generatedAt = new Date().toISOString();
  const metrics = {
    recallTelemetryCoverageRate: results.filter((row) => row.recallTelemetryPresent).length / Math.max(1, results.length),
    expectedRecallChannelCoverageRate: results.filter((row) => row.expectedRecallChannelPresent).length / Math.max(1, results.length),
    vectorAuthoritativeClaimCount: results.filter((row) => row.vectorAuthoritative).length,
    filterBeforeVectorFinalSelectionRate: results.filter((row) => row.filterBeforeVectorFinalSelection).length / Math.max(1, results.length),
    wrongCorpusCount: results.filter((row) => row.expectedRecallChannelPresent === false).length,
    unsupportedNoEvidenceSuccessCount: results.filter((row) => row.evidenceCount <= 0 && row.passed).length,
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0)
  };
  const report = {
    generatedAt,
    benchmark: "hybrid_temporal_retrieval_pack",
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      metrics.recallTelemetryCoverageRate >= 0.98 &&
      metrics.expectedRecallChannelCoverageRate === 1 &&
      metrics.vectorAuthoritativeClaimCount === 0 &&
      metrics.filterBeforeVectorFinalSelectionRate === 1 &&
      metrics.wrongCorpusCount === 0 &&
      metrics.unsupportedNoEvidenceSuccessCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `hybrid-temporal-retrieval-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `hybrid-temporal-retrieval-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Hybrid Temporal Retrieval Pack\n\n- passed: ${report.passed}\n- recallTelemetryCoverageRate: ${metrics.recallTelemetryCoverageRate}\n- expectedRecallChannelCoverageRate: ${metrics.expectedRecallChannelCoverageRate}\n- vectorAuthoritativeClaimCount: ${metrics.vectorAuthoritativeClaimCount}\n- filterBeforeVectorFinalSelectionRate: ${metrics.filterBeforeVectorFinalSelectionRate}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runHybridTemporalRetrievalPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteHybridTemporalRetrievalPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
