import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { runCodexSessionPhase57Pack } from "./codex-session-phase-5-7-pack.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

interface Phase8QueryScenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedFinalClaimSource: string;
}

const PHASE8_QUERY_SCENARIOS = [
  {
    id: "project_stack_standards",
    query: "What stack and standards usually apply to this repo?",
    expectedTerms: ["Postgres", "TypeScript", "MCP", "source trail"]
  },
  {
    id: "promotion_lifecycle",
    query: "Which Codex memories are promoted truth versus candidates?",
    expectedTerms: ["promoted", "candidate", "curated"]
  },
  {
    id: "token_waste",
    query: "What token waste patterns are costing us the most in Codex sessions?",
    expectedTerms: ["token", "raw transcript", "summary"]
  },
  {
    id: "packet_ledger",
    query: "Generate a memory packet and show which prior packets it reused.",
    expectedTerms: ["Agent memory packet", "included", "raw transcripts"]
  },
  {
    id: "skill_rule_projection",
    query: "Which Codex workflow patterns became skill or AGENTS rule candidates?",
    expectedTerms: ["skill", "workflow", "task list"]
  }
].map((scenario) => ({
  ...scenario,
  expectedFinalClaimSource:
    scenario.id === "packet_ledger"
      ? "engineering_memory_packet"
      : scenario.id === "promotion_lifecycle"
        ? "codex_session_report"
        : "workflow_pattern_report"
})) satisfies readonly Phase8QueryScenario[];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function payloadText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function hasOperatingContextLeak(text: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count/iu.test(text);
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

async function runQuery(namespaceId: string, scenario: Phase8QueryScenario): Promise<Record<string, unknown>> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    limit: 10,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const finalClaimSource = typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null;
  const selectedReader = typeof payload?.meta?.selectedReader === "string" ? payload.meta.selectedReader : null;
  const text = payloadText(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !text.includes(term.toLowerCase()));
  const operatingContextLeak = hasOperatingContextLeak(text);
  const evidenceCount = payloadEvidenceCount(payload);
  const row = {
    ...scenario,
    finalClaimSource,
    selectedReader,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    rawTranscriptRetrievalCount: Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0),
    operatingContextLeak,
    missingTerms,
    compactAnswer: String(payload.humanReadable?.answer ?? payload.answer ?? payload.duality?.claim?.text ?? "").slice(0, 700)
  };
  return {
    ...row,
    passed:
      finalClaimSource === scenario.expectedFinalClaimSource &&
      selectedReader === "codex_memory_reader" &&
      evidenceCount > 0 &&
      sourceTrailCount(payload) > 0 &&
      claimAuditCount(payload) > 0 &&
      queryTimeModelCallsFromPayload(payload) === 0 &&
      Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0) === 0 &&
      !operatingContextLeak &&
      missingTerms.length === 0
  };
}

async function projectionCounts(namespaceId: string): Promise<Record<string, number>> {
  const rows = await queryRows<{ readonly key: string; readonly count: string }>(
    `
      SELECT 'semantic' AS key, COUNT(*)::text AS count
      FROM semantic_memory
      WHERE namespace_id = $1 AND memory_kind LIKE 'codex_%'
      UNION ALL
      SELECT 'procedural' AS key, COUNT(*)::text AS count
      FROM procedural_memory
      WHERE namespace_id = $1 AND state_type LIKE 'codex_%'
      UNION ALL
      SELECT 'vector_jobs' AS key, COUNT(*)::text AS count
      FROM vector_sync_jobs
      WHERE namespace_id = $1 AND target_table = 'semantic_memory'
      UNION ALL
      SELECT 'artifact_chunks' AS key, COUNT(*)::text AS count
      FROM artifact_chunks ac
      JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      WHERE a.namespace_id = $1 AND a.artifact_type = 'codex_session_summary'
    `,
    [namespaceId]
  );
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

export async function runCodexSessionPhase8Pack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const phase57 = await runCodexSessionPhase57Pack("e2e");
  const namespaceId = phase57.report.namespaceId as string;
  const projection = await projectCodexSessionSpecCoverage({ namespaceId });
  const queryRowsResult = await Promise.all(PHASE8_QUERY_SCENARIOS.map((scenario) => runQuery(namespaceId, scenario)));
  const counts = await projectionCounts(namespaceId);
  const metrics = {
    ...projection.metrics,
    summaryCount: projection.summaryCount,
    candidateCount: projection.candidateCount,
    semanticProjectionCount: projection.semanticProjectionCount,
    proceduralProjectionCount: projection.proceduralProjectionCount,
    vectorSyncJobCount: projection.vectorSyncJobCount,
    packetLedgerCount: projection.packetLedgerCount,
    projectProfileCount: projection.projectProfileCount,
    tokenAnalyticsCount: projection.tokenAnalyticsCount,
    workflowPatternProjectionCount: projection.workflowPatternProjectionCount,
    deprecatedMemoryActiveSelectionCount: projection.deprecatedMemoryActiveSelectionCount,
    rawTranscriptEmbeddingCount: projection.rawTranscriptEmbeddingCount,
    rawTranscriptRetrievalCount: queryRowsResult.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    queryCount: queryRowsResult.length,
    queryStrongCount: queryRowsResult.filter((row) => row.passed === true).length,
    supportedZeroEvidenceRows: queryRowsResult.filter((row) => Number(row.evidenceCount) === 0).length,
    supportedEmptySourceTrailRows: queryRowsResult.filter((row) => Number(row.sourceTrailCount) === 0).length,
    supportedMissingClaimAuditRows: queryRowsResult.filter((row) => Number(row.claimAuditCount) === 0).length,
    queryTimeModelCalls: queryRowsResult.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0)
  };
  const failures = [
    metrics.codexSourceEnvelopeCoverage !== 1 ? "codex_source_envelope_incomplete" : "",
    metrics.codexCuratedEmbeddingCoverage !== 1 ? "codex_curated_embedding_vector_sync_incomplete" : "",
    metrics.promotionStateAccuracy !== 1 ? "promotion_lifecycle_inaccurate" : "",
    metrics.workflowPatternProjectionCoverage < 0.95 ? "workflow_pattern_projection_incomplete" : "",
    metrics.technologyProfileExtractionAccuracy < 0.95 ? "technology_profile_inaccurate" : "",
    metrics.agentPacketLedgerCoverage !== 1 ? "agent_packet_ledger_missing" : "",
    metrics.rawTranscriptEmbeddingCount !== 0 ? "raw_transcript_embedding_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : "",
    metrics.queryStrongCount !== metrics.queryCount ? "phase8_query_quality_below_gate" : "",
    metrics.supportedZeroEvidenceRows !== 0 ? "supported_zero_evidence" : "",
    metrics.supportedEmptySourceTrailRows !== 0 ? "empty_source_trail" : "",
    metrics.supportedMissingClaimAuditRows !== 0 ? "missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_session_phase_8_spec_coverage_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId }
    }),
    passed: failures.length === 0,
    namespaceId,
    phase57Artifact: phase57.output.jsonPath,
    projection,
    projectionCounts: counts,
    metrics,
    queryRows: queryRowsResult,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const suffix = stamp();
  const base = `codex-session-phase-8-spec-coverage-pack-${suffix}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Session Phase 8 Spec Coverage Pack",
      "",
      `- passed: ${report.passed}`,
      `- codexSourceEnvelopeCoverage: ${metrics.codexSourceEnvelopeCoverage}`,
      `- codexCuratedEmbeddingCoverage: ${metrics.codexCuratedEmbeddingCoverage}`,
      `- promotionStateAccuracy: ${metrics.promotionStateAccuracy}`,
      `- workflowPatternProjectionCoverage: ${metrics.workflowPatternProjectionCoverage}`,
      `- technologyProfileExtractionAccuracy: ${metrics.technologyProfileExtractionAccuracy}`,
      `- agentPacketLedgerCoverage: ${metrics.agentPacketLedgerCoverage}`,
      `- queryStrongCount: ${metrics.queryStrongCount}/${metrics.queryCount}`,
      `- rawTranscriptEmbeddingCount: ${metrics.rawTranscriptEmbeddingCount}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      "",
      "## Query Examples",
      ...queryRowsResult.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak missing=${row.missingTerms.join(", ")}`} -> ${row.compactAnswer}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexSessionPhase8PackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexSessionPhase8Pack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-session-phase-8-spec-coverage-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
