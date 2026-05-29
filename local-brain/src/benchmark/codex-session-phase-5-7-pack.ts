import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  parseAndSummarizeCodexSession,
  promoteCodexSessionMemoryCandidates,
  scanCodexSessions,
  mineCodexSessionPatterns,
  exportCodexSkillCandidateDrafts,
  type CodexSessionConfig
} from "../codex-sessions/service.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type PackMode = "engineering_memory" | "retrieval" | "pattern_mining" | "e2e";

interface QueryScenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedFinalClaimSource: string;
}

const QUERY_SCENARIOS: readonly QueryScenario[] = [
  {
    id: "last_time_repo",
    query: "What did we do last time on this repo?",
    expectedFinalClaimSource: "codex_session_report",
    expectedTerms: ["scanner", "parser", "redaction", "summary"]
  },
  {
    id: "agent_memory_packet",
    query: "Generate an agent memory packet for this task.",
    expectedFinalClaimSource: "engineering_memory_packet",
    expectedTerms: ["raw transcripts", "curated summaries", "task list"]
  },
  {
    id: "avoid_mistakes",
    query: "What mistakes should Codex avoid on this repo?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedTerms: ["raw transcripts", "generic fallback", "docs drift"]
  },
  {
    id: "prior_decisions",
    query: "What prior decisions exist for Codex session ingestion?",
    expectedFinalClaimSource: "codex_session_report",
    expectedTerms: ["archive-only", "curated summaries", "retrieval memory"]
  },
  {
    id: "source_audit_packet",
    query: "Where did that memory packet come from?",
    expectedFinalClaimSource: "codex_source_audit",
    expectedTerms: ["codex-session://", "curated session summary"]
  },
  {
    id: "docs_drift",
    query: "Show sessions that created docs drift.",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedTerms: ["docs drift", "task list", "changelog"]
  },
  {
    id: "repeated_instructions",
    query: "What repeated instructions do I keep giving Codex?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedTerms: ["task list", "documents", "docs"]
  },
  {
    id: "skill_candidates",
    query: "What skill candidates came from my Codex sessions?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedTerms: ["session ingestion", "skill"]
  },
  {
    id: "personal_planning",
    query: "What personal planning tasks came from Codex sessions?",
    expectedFinalClaimSource: "codex_session_report",
    expectedTerms: ["US trip", "planning"]
  },
  {
    id: "candidate_vs_promoted",
    query: "Which memories are candidates versus promoted truth?",
    expectedFinalClaimSource: "codex_session_report",
    expectedTerms: ["candidate", "promoted", "curated"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function writeJsonl(filePath: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function createFixture(mode: PackMode): Promise<{ readonly config: CodexSessionConfig; readonly sourcePaths: readonly string[]; readonly draftDir: string }> {
  const root = path.join(outputDir(), "generated", `codex-session-phase-5-7-${mode}-${stamp()}`);
  await rm(root, { recursive: true, force: true });
  const codexHome = path.join(root, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "25");
  const archiveRoot = path.join(root, "archive");
  const draftDir = path.join(root, "skill-draft");
  const first = path.join(sessionsDir, "rollout-2026-05-25T08-00-00-019e-phase57-engineering.jsonl");
  const second = path.join(sessionsDir, "rollout-2026-05-25T08-30-00-019e-phase57-planning.jsonl");
  await writeJsonl(first, [
    { type: "session_meta", timestamp: "2026-05-25T08:00:00.000Z", payload: { cwd: "/Users/evilone/Documents/Development/AI-Brain/ai-brain" } },
    { type: "user_message", timestamp: "2026-05-25T08:00:30.000Z", payload: { role: "user", text: "# AGENTS.md instructions for /Users/evilone/Documents/Development/AI-Brain/ai-brain <INSTRUCTIONS> A skill is a set of local instructions to follow. Filesystem sandboxing defines which files can be read or written. Approval policy is currently never. </INSTRUCTIONS>" } },
    { type: "user_message", timestamp: "2026-05-25T08:01:00.000Z", payload: { role: "user", text: "Build Codex session ingestion in the AI Brain TypeScript and Postgres stack. Always track via a task list and always update documents so docs do not drift." } },
    { type: "assistant_message", timestamp: "2026-05-25T08:02:00.000Z", payload: { role: "assistant", text: "Decision: raw Codex transcripts stay archive-only; curated summaries become retrieval memory candidates. The MCP retrieval memory packet must cite codex-session sources and remain compatible with pgvector-backed durable memory." } },
    { type: "tool_call", timestamp: "2026-05-25T08:03:00.000Z", payload: { role: "tool", command: "npm run build --workspace local-brain" } },
    { type: "assistant_message", timestamp: "2026-05-25T08:04:00.000Z", payload: { role: "assistant", text: "Failed approach: do not let generic fallback search raw transcripts or skip source trails. Avoid docs drift by updating changelog and task list." } },
    { type: "assistant_message", timestamp: "2026-05-25T08:05:00.000Z", payload: { role: "assistant", text: "Implemented scanner, parser, redaction, and summary proof for Codex session ingestion. Followup: add skill candidate for session ingestion workflows and verify MCP retrieval." } }
  ]);
  await writeJsonl(second, [
    { type: "session_meta", timestamp: "2026-05-25T08:30:00.000Z", payload: { cwd: "/Users/evilone/Documents/Development/AI-Brain/ai-brain" } },
    { type: "user_message", timestamp: "2026-05-25T08:31:00.000Z", payload: { role: "user", text: "Use Codex for personal planning too. For my US trip planning, collect only selected summaries, not every raw turn." } },
    { type: "assistant_message", timestamp: "2026-05-25T08:32:00.000Z", payload: { role: "assistant", text: "Skill candidate: Codex session ingestion skill should generate an agent memory packet, evidence summary, and examples without auto-installing anything." } },
    { type: "assistant_message", timestamp: "2026-05-25T08:33:00.000Z", payload: { role: "assistant", text: "Completed planning summary. Candidate memories remain candidate status until a human promotes them; promoted truth is not overwritten silently." } }
  ]);
  await writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({ id: "019e-phase57-engineering", thread_name: "Codex session ingestion engineering", updated_at: "2026-05-25T08:05:00.000Z" }),
      JSON.stringify({ id: "019e-phase57-planning", thread_name: "Codex session personal planning", updated_at: "2026-05-25T08:33:00.000Z" })
    ].join("\n") + "\n",
    "utf8"
  );
  return {
    sourcePaths: [first, second],
    draftDir,
    config: {
      codexHome,
      scanPaths: [path.join(codexHome, "sessions")],
      excludePaths: [],
      sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
      stateSqlitePath: path.join(codexHome, "state_5.sqlite"),
      archiveRoot,
      archivePolicy: "archive_selected",
      namespaceId: `fixture_codex_phase_5_7_${mode}_${stamp().toLowerCase()}`
    }
  };
}

function payloadText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

async function runQuery(namespaceId: string, scenario: QueryScenario): Promise<Record<string, unknown>> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const text = payloadText(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !text.includes(term.toLowerCase()));
  const finalClaimSource = typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null;
  const selectedReader = typeof payload?.meta?.selectedReader === "string" ? payload.meta.selectedReader : null;
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
    packetTokenEstimate: Number(payload?.meta?.packetTokenEstimate ?? 0),
    missingTerms,
    compactAnswer: String(payload.humanReadable?.answer ?? payload.answer ?? payload.duality?.claim?.text ?? "").slice(0, 600)
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
      missingTerms.length === 0
  };
}

async function candidateCounts(namespaceId: string): Promise<Record<string, number>> {
  const rows = await queryRows<{ readonly candidate_type: string; readonly count: string }>(
    `
      SELECT candidate_type, COUNT(*)::text AS count
      FROM memory_candidates
      WHERE namespace_id = $1
        AND candidate_type LIKE 'codex_%'
      GROUP BY candidate_type
      ORDER BY candidate_type
    `,
    [namespaceId]
  );
  return Object.fromEntries(rows.map((row) => [row.candidate_type, Number(row.count)]));
}

export async function runCodexSessionPhase57Pack(mode: PackMode = "e2e"): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const fixture = await createFixture(mode);
  const dryRun = await scanCodexSessions(fixture.config, { dryRun: true, limit: 10 });
  const scan = await scanCodexSessions(fixture.config, { dryRun: false, limit: 10, archivePolicy: "archive_selected" });
  for (const session of scan.selectedSessions) {
    await parseAndSummarizeCodexSession({ namespaceId: fixture.config.namespaceId, sourcePath: session.sourcePath, persist: true });
  }
  const promotion = await promoteCodexSessionMemoryCandidates({ namespaceId: fixture.config.namespaceId });
  const patterns = await mineCodexSessionPatterns({ namespaceId: fixture.config.namespaceId });
  const draft = await exportCodexSkillCandidateDrafts({ namespaceId: fixture.config.namespaceId, outputDir: fixture.draftDir });
  const rows = await Promise.all(QUERY_SCENARIOS.map((scenario) => runQuery(fixture.config.namespaceId, scenario)));
  const counts = await candidateCounts(fixture.config.namespaceId);
  const metrics = {
    sessionFileCount: dryRun.metrics.sessionFileCount,
    dryRunMutationCount: dryRun.metrics.dryRunMutationCount,
    rawFilesCopiedCount: scan.metrics.rawFilesCopiedCount,
    scannedSummaryCount: promotion.scannedSummaryCount,
    codexCandidateCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
    rawTranscriptEmbeddingCount: promotion.rawTranscriptEmbeddingCount,
    conflictCount: promotion.conflictCount,
    queryCount: rows.length,
    queryStrongCount: rows.filter((row) => row.passed === true).length,
    missingExpectedTermRows: rows.filter((row) => Array.isArray(row.missingTerms) && row.missingTerms.length > 0).length,
    supportedZeroEvidenceRows: rows.filter((row) => Number(row.evidenceCount) === 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => Number(row.sourceTrailCount) === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => Number(row.claimAuditCount) === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0),
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    patternCategoryCount: Object.values(patterns.patterns).filter((values) => values.length > 0).length,
    skillDraftFileCount: draft.files.length
  };
  const failures = [
    metrics.dryRunMutationCount !== 0 ? "dry_run_mutated_state" : "",
    metrics.rawFilesCopiedCount < 2 ? "raw_archive_copy_missing" : "",
    metrics.codexCandidateCount < 8 ? "insufficient_codex_candidates" : "",
    metrics.rawTranscriptEmbeddingCount !== 0 ? "raw_transcript_embedding_detected" : "",
    metrics.conflictCount !== 0 ? "candidate_conflict_detected" : "",
    metrics.queryStrongCount !== metrics.queryCount ? "codex_query_quality_below_gate" : "",
    metrics.supportedZeroEvidenceRows !== 0 ? "supported_zero_evidence" : "",
    metrics.supportedEmptySourceTrailRows !== 0 ? "empty_source_trail" : "",
    metrics.supportedMissingClaimAuditRows !== 0 ? "missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieved" : "",
    metrics.patternCategoryCount < 6 ? "insufficient_pattern_categories" : "",
    metrics.skillDraftFileCount !== 3 ? "skill_draft_not_exported" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: `codex_session_phase_5_7_${mode}_pack`,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: fixture.config.namespaceId, mode }
    }),
    passed: failures.length === 0,
    namespaceId: fixture.config.namespaceId,
    metrics,
    candidateTypeCounts: counts,
    promotion,
    patterns,
    skillDraft: { outputDir: draft.outputDir, files: draft.files },
    queryRows: rows,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const suffix = stamp();
  const base = `codex-session-phase-5-7-${mode}-pack-${suffix}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      `# Codex Session Phase 5-7 ${mode} Pack`,
      "",
      `- passed: ${report.passed}`,
      `- queryStrongCount: ${metrics.queryStrongCount}/${metrics.queryCount}`,
      `- codexCandidateCount: ${metrics.codexCandidateCount}`,
      `- rawTranscriptEmbeddingCount: ${metrics.rawTranscriptEmbeddingCount}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      `- patternCategoryCount: ${metrics.patternCategoryCount}`,
      "",
      "## Query Examples",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak missing=${row.missingTerms.join(", ")}`} -> ${row.compactAnswer}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexSessionPhase57PackCli(mode: PackMode = "e2e"): Promise<void> {
  try {
    const { report, output } = await runCodexSessionPhase57Pack(mode);
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-session-phase-5-7-${mode}-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
