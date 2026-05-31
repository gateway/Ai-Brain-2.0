import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

interface AuditScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedFinalClaimSource: string;
  readonly expectedSupport: "supported" | "abstained";
  readonly expectedTerms: readonly string[];
}

const SCENARIOS: readonly AuditScenario[] = [
  {
    id: "media_estimated_pricing_boundary",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "For the media app, what did we decide about estimated pricing and the KIE pricing boundary?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["estimated-pricing", "KIE", "pricing"]
  },
  {
    id: "media_duplicate_tabs",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What happened with duplicate New workflow tabs in Media Studio?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["duplicate", "New workflow", "browser"]
  },
  {
    id: "media_kie_onboarding",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What was verified when we added Kie model onboarding for Media Studio?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["Suno", "188 passed", "verified"]
  },
  {
    id: "media_this_week_patterns",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What repeated patterns show up in Media Studio this week?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: ["task lists", "source trails"]
  },
  {
    id: "media_last_week_abstention",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What mistakes commonly came up last week in the media studio?",
    expectedFinalClaimSource: "codex_memory_abstention",
    expectedSupport: "abstained",
    expectedTerms: []
  },
  {
    id: "media_source_audit",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "Show sources for the Media Studio standalone implementation plan.",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["Source trail", "codex-session"]
  },
  {
    id: "media_future_agent_packet",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What should a future agent preload before working on Media Studio?",
    expectedFinalClaimSource: "engineering_memory_packet",
    expectedSupport: "supported",
    expectedTerms: ["curated summaries", "source trails"]
  },
  {
    id: "media_tests",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "Which tests or verification gates mattered for Media Studio?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["pytest", "passed"]
  },
  {
    id: "media_before_after",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What changed between the original Media Studio build and the Media Assistant hardening?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["Earlier", "Later", "Media"]
  },
  {
    id: "media_workspace_confusion",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "Where did the Media Studio browser workflow verification get confusing?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["duplicate", "tab"]
  },
  {
    id: "ai_benchmark_hygiene",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What build command kept showing up in AI Brain Codex maintenance work?",
    expectedFinalClaimSource: "codex_session_report",
    expectedSupport: "supported",
    expectedTerms: []
  },
  {
    id: "ai_duplicate_candidates",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What fixed the repeated memory candidate collision in AI Brain Codex ingestion?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["duplicate", "memory_candidates", "source_chunk"]
  },
  {
    id: "ai_raw_vs_curated",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What did we prove about raw transcripts versus curated Codex summaries in AI Brain?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["raw transcript", "curated", "embedding"]
  },
  {
    id: "ai_this_week_patterns",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What repeated patterns show up in AI Brain this week?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: []
  },
  {
    id: "ai_last_week_abstention",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What token waste patterns showed up in AI Brain last week?",
    expectedFinalClaimSource: "codex_memory_abstention",
    expectedSupport: "abstained",
    expectedTerms: []
  },
  {
    id: "ai_source_audit",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "Show the source trail for those AI Brain Codex patterns.",
    expectedFinalClaimSource: "codex_source_audit",
    expectedSupport: "supported",
    expectedTerms: ["Source trail", "codex-session"]
  },
  {
    id: "ai_future_agent_packet",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What should a future agent preload before working on AI Brain?",
    expectedFinalClaimSource: "engineering_memory_packet",
    expectedSupport: "supported",
    expectedTerms: ["curated summaries", "source trails"]
  },
  {
    id: "ai_phase_change",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "Show the sources for the AI Brain Codex maintenance metrics.",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["Source trail", "codex-session"]
  },
  {
    id: "ai_vector_sync_policy",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What did AI Brain establish about vector sync for Codex session memory?",
    expectedFinalClaimSource: "codex_project_detail_report",
    expectedSupport: "supported",
    expectedTerms: ["vector", "sync"]
  },
  {
    id: "ai_changelog_tasklist_standard",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What standards kept showing up around task lists, changelogs, and docs for AI Brain?",
    expectedFinalClaimSource: "workflow_pattern_report",
    expectedSupport: "supported",
    expectedTerms: ["task", "docs"]
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

function looksSnippetLike(answer: string): boolean {
  return /^(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation)\b/iu.test(answer);
}

function hasOperatingContextLeak(text: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count/iu.test(text);
}

async function runScenario(scenario: AuditScenario): Promise<Record<string, unknown>> {
  const started = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    reference_now: "2026-05-27T00:00:00.000Z",
    detail_mode: "compact",
    limit: 10
  })) as { readonly structuredContent?: any };
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const payload = wrapped.structuredContent ?? {};
  const answer = answerText(payload);
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
  const row = {
    ...scenario,
    finalClaimSource,
    queryContract: payload?.queryContract ?? payload?.meta?.queryContractName ?? null,
    selectedReader: payload?.meta?.selectedReader ?? null,
    retrievalDomain: payload?.retrievalDomain ?? payload?.meta?.retrievalDomain ?? null,
    evidenceCount,
    sourceTrailCount: sourceCount,
    claimAuditCount: auditCount,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    rawTranscriptRetrievalCount: Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0),
    missingTerms,
    snippetLikeAnswer: looksSnippetLike(answer),
    operatingContextLeak: hasOperatingContextLeak(text),
    latencyMs,
    answer: answer.slice(0, 900)
  };
  let residualOwner: string | null = null;
  if (!routeMatches) residualOwner = "wrong_route";
  else if (!supportMatches) residualOwner = scenario.expectedSupport === "abstained" ? "abstention_leaked_evidence" : "support_envelope_missing";
  else if (missingTerms.length > 0) residualOwner = "missing_expected_terms";
  else if (looksSnippetLike(answer)) residualOwner = "snippet_like_answer";
  else if (hasOperatingContextLeak(text)) residualOwner = "operating_context_leak";
  else if (queryTimeModelCallsFromPayload(payload) !== 0) residualOwner = "query_time_model_calls";
  else if (Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0) !== 0) residualOwner = "raw_transcript_retrieval";
  return { ...row, residualOwner, passed: residualOwner === null };
}

export async function runCodexMultiProjectQueryAudit(): Promise<{
  readonly report: any;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
    readonly missLedgerJsonPath: string;
    readonly missLedgerMarkdownPath: string;
  };
}> {
  const rows = await Promise.all(SCENARIOS.map(runScenario));
  const missRows = rows.filter((row) => row.passed !== true);
  const residualOwnerCounts = Object.fromEntries(
    [...new Set(missRows.map((row) => String(row.residualOwner ?? "unknown")))]
      .sort()
      .map((owner) => [owner, missRows.filter((row) => String(row.residualOwner ?? "unknown") === owner).length])
  );
  const dominantResidualOwner =
    Object.entries(residualOwnerCounts).sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] ?? null;
  const supportedRows = rows.filter((row) => row.expectedSupport === "supported");
  const latencies = [...rows].map((row) => Number(row.latencyMs ?? 0)).sort((left, right) => left - right);
  const metrics = {
    queryCount: rows.length,
    strongCount: rows.filter((row) => row.passed === true).length,
    strongRate: rate(rows.filter((row) => row.passed === true).length, rows.length),
    wrongRouteCount: rows.filter((row) => row.residualOwner === "wrong_route").length,
    supportEnvelopeMissingCount: rows.filter((row) => row.residualOwner === "support_envelope_missing").length,
    abstentionLeakCount: rows.filter((row) => row.residualOwner === "abstention_leaked_evidence").length,
    missingExpectedTermCount: rows.filter((row) => row.residualOwner === "missing_expected_terms").length,
    snippetLikeAnswerCount: rows.filter((row) => row.snippetLikeAnswer === true).length,
    operatingContextLeakCount: rows.filter((row) => row.operatingContextLeak === true).length,
    supportedZeroEvidenceCount: supportedRows.filter((row) => Number(row.evidenceCount) === 0).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => Number(row.sourceTrailCount) === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => Number(row.claimAuditCount) === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0),
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? 0,
    maxLatencyMs: latencies.at(-1) ?? 0
  };
  const failures = [
    metrics.strongCount !== metrics.queryCount ? "multi_project_query_audit_not_green" : "",
    metrics.wrongRouteCount !== 0 ? "wrong_route" : "",
    metrics.supportEnvelopeMissingCount !== 0 ? "support_envelope_missing" : "",
    metrics.abstentionLeakCount !== 0 ? "abstention_leaked_evidence" : "",
    metrics.missingExpectedTermCount !== 0 ? "missing_expected_terms" : "",
    metrics.snippetLikeAnswerCount !== 0 ? "snippet_like_answer" : "",
    metrics.operatingContextLeakCount !== 0 ? "operating_context_leak" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_multi_project_query_audit",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { referenceNow: "2026-05-27T00:00:00.000Z" }
    }),
    rows,
    metrics,
    missLedger: {
      rowCount: missRows.length,
      dominantResidualOwner,
      residualOwnerCounts
    },
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = `codex-multi-project-query-audit-${stamp()}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  const ledgerBase = `codex-multi-project-miss-ledger-${stamp()}`;
  const missLedgerJsonPath = path.join(dir, `${ledgerBase}.json`);
  const missLedgerMarkdownPath = path.join(dir, `${ledgerBase}.md`);
  const missLedger = {
    generatedAt: report.generatedAt,
    benchmark: "codex_multi_project_query_audit_miss_ledger",
    sourceAuditArtifact: jsonPath,
    rowCount: missRows.length,
    dominantResidualOwner,
    residualOwnerCounts,
    rows: missRows.map((row: any) => ({
      id: row.id,
      query: row.query,
      namespaceId: row.namespaceId,
      expectedFinalClaimSource: row.expectedFinalClaimSource,
      finalClaimSource: row.finalClaimSource,
      evidenceCount: row.evidenceCount,
      sourceTrailCount: row.sourceTrailCount,
      claimAuditCount: row.claimAuditCount,
      missingTerms: row.missingTerms,
      residualOwner: row.residualOwner,
      notes:
        row.residualOwner === "missing_expected_terms"
          ? "Retrieved a supported answer but did not preserve expected source terms."
          : row.residualOwner === "wrong_route"
            ? "Planner or route arbitration selected the wrong final claim source."
            : row.residualOwner === "support_envelope_missing"
              ? "Supported row lacked required evidence/source-trail/claim-audit envelope."
              : row.residualOwner === "abstention_leaked_evidence"
                ? "Expected typed abstention but retrieval returned evidence."
                : row.residualOwner ?? "No residual owner classified."
    }))
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(missLedgerJsonPath, `${JSON.stringify(missLedger, null, 2)}\n`, "utf8");
  await writeFile(
    missLedgerMarkdownPath,
    [
      "# Codex Multi-Project Miss Ledger",
      "",
      `- sourceAuditArtifact: ${jsonPath}`,
      `- rowCount: ${missRows.length}`,
      `- dominantResidualOwner: ${dominantResidualOwner ?? "none"}`,
      `- residualOwnerCounts: ${JSON.stringify(residualOwnerCounts)}`,
      "",
      ...(missRows.length === 0
        ? ["No non-source-missing residual rows remain."]
        : missRows.map((row: any) => `- ${row.id}: ${row.residualOwner} -> ${row.query}`))
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    markdownPath,
    [
      "# Codex Multi-Project Query Audit",
      "",
      `- passed: ${report.passed}`,
      `- strongCount: ${metrics.strongCount}/${metrics.queryCount}`,
      `- wrongRouteCount: ${metrics.wrongRouteCount}`,
      `- missingExpectedTermCount: ${metrics.missingExpectedTermCount}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      "",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak:${row.residualOwner}`} -> ${row.answer}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath, missLedgerJsonPath, missLedgerMarkdownPath } };
}

export async function runCodexMultiProjectQueryAuditCli(): Promise<void> {
  try {
    const { report, output } = await runCodexMultiProjectQueryAudit();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${output.missLedgerJsonPath}\n${output.missLedgerMarkdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-multi-project-query-audit failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
