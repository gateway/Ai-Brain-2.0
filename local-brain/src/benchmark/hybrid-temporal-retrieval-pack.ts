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
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "place_friend_metadata_filter",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"]
  },
  {
    id: "event_window_july",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    expectedTerms: ["mid-to-late July", "US"]
  },
  {
    id: "travel_task_lifecycle",
    toolName: "memory.extract_tasks",
    query: "What are the open travel tasks from my recent travel planning notes, excluding older unrelated tasks?",
    expectedTerms: ["Store Jeep", "RV", "driver"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function hasTerm(payload: any, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
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
  const filterTrace = Array.isArray(payload?.meta?.filterTrace) ? payload.meta.filterTrace : [];
  return {
    ...scenario,
    finalClaimSource: payload.finalClaimSource ?? null,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    missingTerms,
    vectorAuthoritative,
    filterBeforeVectorFinalSelection: scenario.toolName !== "memory.search" || filterTrace.length > 0 || payload?.meta?.rerankDecision === "metadata_first",
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed: missingTerms.length === 0 && !vectorAuthoritative && payloadEvidenceCount(payload) > 0 && queryTimeModelCallsFromPayload(payload) === 0
  };
}

export async function runAndWriteHybridTemporalRetrievalPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  const generatedAt = new Date().toISOString();
  const metrics = {
    vectorAuthoritativeClaimCount: results.filter((row) => row.vectorAuthoritative).length,
    filterBeforeVectorFinalSelectionRate: results.filter((row) => row.filterBeforeVectorFinalSelection).length / Math.max(1, results.length),
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0)
  };
  const report = {
    generatedAt,
    benchmark: "hybrid_temporal_retrieval_pack",
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      metrics.vectorAuthoritativeClaimCount === 0 &&
      metrics.filterBeforeVectorFinalSelectionRate === 1 &&
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
  await writeFile(markdownPath, `# Hybrid Temporal Retrieval Pack\n\n- passed: ${report.passed}\n- vectorAuthoritativeClaimCount: ${metrics.vectorAuthoritativeClaimCount}\n- filterBeforeVectorFinalSelectionRate: ${metrics.filterBeforeVectorFinalSelectionRate}\n`, "utf8");
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
