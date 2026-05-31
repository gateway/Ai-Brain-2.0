import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

interface LiveAuditScenario {
  readonly id: string;
  readonly query: string;
  readonly expectedFinalClaimSource: string;
  readonly expectedSupport: "supported" | "abstained";
  readonly expectedTerms: readonly string[];
}

const NAMESPACE_ID = "personal";

const SCENARIOS: readonly LiveAuditScenario[] = [
  {
    id: "stack_and_standards",
    query: "What stack and standards usually apply to this repo?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: ["local-first"]
  },
  {
    id: "promoted_truth_vs_candidates",
    query: "Which Codex memories are promoted truth versus candidates?",
    expectedFinalClaimSource: "codex_session_report",
    expectedSupport: "supported",
    expectedTerms: ["candidates", "active semantic/procedural memory"]
  },
  {
    id: "token_waste_patterns",
    query: "What token waste patterns are costing us the most in Codex sessions?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: ["raw transcripts", "excluded from retrieval"]
  },
  {
    id: "memory_packet_reuse",
    query: "Generate a memory packet and show which prior packets it reused.",
    expectedFinalClaimSource: "engineering_memory_packet",
    expectedSupport: "supported",
    expectedTerms: ["curated summaries", "source trails"]
  },
  {
    id: "workflow_to_skill_candidates",
    query: "Which Codex workflow patterns became skill or AGENTS rule candidates?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: []
  },
  {
    id: "ingestion_architecture",
    query: "What architecture decisions did we make for AI Brain Codex session ingestion?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["scan", "promotion", "projection"]
  },
  {
    id: "raw_vs_curated_proof",
    query: "What did we prove about raw transcript embedding and curated summaries for AI Brain Codex ingestion?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["scheduledscancount", "summarizedsessioncount"]
  },
  {
    id: "ingestion_tests_and_gates",
    query: "What tests or benchmark gates verified AI Brain Codex session ingestion?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["benchmark:gliner-relex-cross-ingest-bakeoff", "npm run build"]
  },
  {
    id: "ingestion_sources",
    query: "Show the sources for AI Brain Codex session ingestion decisions.",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["source trail", "codex-session://"]
  },
  {
    id: "missing_before_after_abstains",
    query: "What changed between the first Codex pilot and the later AI Brain Codex ingestion work?",
    expectedFinalClaimSource: "codex_memory_abstention",
    expectedSupport: "abstained",
    expectedTerms: []
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function answerText(payload: any): string {
  return String(payload?.humanReadable?.answer ?? payload?.answer ?? payload?.duality?.claim?.text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function payloadText(payload: any): string {
  return JSON.stringify(payload ?? null).toLowerCase();
}

function hasOperatingContextLeak(text: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count/iu.test(text);
}

async function runScenario(scenario: LiveAuditScenario): Promise<Record<string, unknown>> {
  const started = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: NAMESPACE_ID,
    query: scenario.query,
    detail_mode: "compact",
    limit: 10
  })) as { readonly structuredContent?: any };
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const payload = wrapped.structuredContent ?? {};
  const text = payloadText(payload);
  const finalClaimSource =
    typeof payload?.finalClaimSource === "string"
      ? payload.finalClaimSource
      : typeof payload?.meta?.finalClaimSource === "string"
        ? payload.meta.finalClaimSource
        : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceCount = sourceTrailCount(payload);
  const auditCount = claimAuditCount(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !text.includes(term.toLowerCase()));
  const routeMatches = finalClaimSource === scenario.expectedFinalClaimSource;
  const supportMatches =
    scenario.expectedSupport === "abstained"
      ? evidenceCount === 0
      : evidenceCount > 0 && sourceCount > 0 && auditCount > 0;
  let residualOwner: string | null = null;
  if (!routeMatches) residualOwner = "wrong_route";
  else if (!supportMatches) residualOwner = scenario.expectedSupport === "abstained" ? "abstention_missing" : "support_envelope_missing";
  else if (scenario.expectedSupport === "supported" && missingTerms.length > 0) residualOwner = "missing_terms";
  else if (Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0) !== 0) residualOwner = "raw_transcript_retrieval";
  else if (queryTimeModelCallsFromPayload(payload) !== 0) residualOwner = "query_time_model_calls";
  else if (hasOperatingContextLeak(text)) residualOwner = "operating_context_leak";
  return {
    ...scenario,
    namespaceId: NAMESPACE_ID,
    finalClaimSource,
    selectedReader: payload?.meta?.selectedReader ?? null,
    retrievalDomain: payload?.retrievalDomain ?? payload?.meta?.retrievalDomain ?? null,
    evidenceCount,
    sourceTrailCount: sourceCount,
    claimAuditCount: auditCount,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    rawTranscriptRetrievalCount: Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0),
    missingTerms,
    latencyMs,
    operatingContextLeak: hasOperatingContextLeak(text),
    answerSections: Array.isArray(payload?.answerSections) ? payload.answerSections.map((section: any) => String(section?.id ?? "")).filter(Boolean) : [],
    answer: answerText(payload).slice(0, 1_000),
    residualOwner,
    passed: residualOwner === null
  };
}

export async function runCodexLiveAiBrainQueryAudit(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario)));
  const metrics = {
    queryCount: rows.length,
    strongCount: rows.filter((row) => row.passed === true).length,
    strongRate: rate(rows.filter((row) => row.passed === true).length, rows.length),
    abstentionCount: rows.filter((row) => row.expectedSupport === "abstained" && Number(row.evidenceCount) === 0).length,
    wrongRouteCount: rows.filter((row) => row.residualOwner === "wrong_route").length,
    supportEnvelopeMissingCount: rows.filter((row) => row.residualOwner === "support_envelope_missing").length,
    abstentionMissingCount: rows.filter((row) => row.residualOwner === "abstention_missing").length,
    missingTermCount: rows.filter((row) => row.residualOwner === "missing_terms").length,
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0),
    operatingContextLeakCount: rows.filter((row) => row.operatingContextLeak === true).length,
    p95LatencyMs: [...rows].sort((left, right) => Number(left.latencyMs ?? 0) - Number(right.latencyMs ?? 0))[Math.ceil(rows.length * 0.95) - 1]?.latencyMs ?? 0,
    maxLatencyMs: rows.reduce((max, row) => Math.max(max, Number(row.latencyMs ?? 0)), 0)
  };
  const failures = [
    metrics.strongCount !== metrics.queryCount ? "live_query_quality_below_gate" : "",
    metrics.wrongRouteCount !== 0 ? "wrong_route" : "",
    metrics.supportEnvelopeMissingCount !== 0 ? "support_envelope_missing" : "",
    metrics.abstentionMissingCount !== 0 ? "abstention_missing" : "",
    metrics.missingTermCount !== 0 ? "missing_terms" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.operatingContextLeakCount !== 0 ? "operating_context_leak" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_live_ai_brain_query_audit",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: NAMESPACE_ID, queryCount: String(SCENARIOS.length) }
    }),
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const suffix = stamp();
  const base = `codex-live-ai-brain-query-audit-${suffix}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Live AI Brain Query Audit",
      "",
      `- namespaceId: ${NAMESPACE_ID}`,
      `- passed: ${report.passed}`,
      `- strongCount: ${metrics.strongCount}/${metrics.queryCount}`,
      `- strongRate: ${metrics.strongRate}`,
      `- abstentionCount: ${metrics.abstentionCount}`,
      `- wrongRouteCount: ${metrics.wrongRouteCount}`,
      `- supportEnvelopeMissingCount: ${metrics.supportEnvelopeMissingCount}`,
      `- abstentionMissingCount: ${metrics.abstentionMissingCount}`,
      `- missingTermCount: ${metrics.missingTermCount}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      `- p95LatencyMs: ${metrics.p95LatencyMs}`,
      `- maxLatencyMs: ${metrics.maxLatencyMs}`,
      "",
      "## Query Rows",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak owner=${row.residualOwner} missingTerms=${row.missingTerms?.join(", ") ?? ""}`} -> ${row.answer ?? ""}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexLiveAiBrainQueryAuditCli(): Promise<void> {
  try {
    const { report, output } = await runCodexLiveAiBrainQueryAudit();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-live-ai-brain-query-audit failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
