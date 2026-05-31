import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

interface CodexProjectDetailScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly project: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedSections: readonly string[];
}

const SCENARIOS: readonly CodexProjectDetailScenario[] = [
  {
    id: "media_architecture_targets",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What was the target architecture for Media Studio, and what parts were supposed to own UI, backend, queue, and KIE orchestration?",
    expectedTerms: ["Next.js", "FastAPI", "SQLite", "KIE"],
    expectedSections: ["architecture", "decisions", "source_trail"]
  },
  {
    id: "media_queue_bug_fix",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What went wrong with Media Studio job events or queue processing, and how was it supposed to be fixed?",
    expectedTerms: ["media_job_events", "queue", "patch"],
    expectedSections: ["bugs_fixes", "source_trail"]
  },
  {
    id: "media_real_kie_proof",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What proof did we get that Media Studio could run a real KIE job and publish an asset?",
    expectedTerms: ["KIE", "published", "asset"],
    expectedSections: ["proof_results", "source_trail"]
  },
  {
    id: "media_tests_gates",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What tests or verification gates were mentioned for Media Studio work?",
    expectedTerms: ["pytest", "passed"],
    expectedSections: ["tests_verification", "source_trail"]
  },
  {
    id: "media_before_after",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What changed between the March Build Media Studio work and the May Media Assistant hardening work?",
    expectedTerms: ["Earlier", "Later", "Media"],
    expectedSections: ["before_after", "source_trail"]
  },
  {
    id: "media_source_audit",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "Show the sources for the Media Studio standalone implementation plan.",
    expectedTerms: ["Codex", "source"],
    expectedSections: ["source_trail"]
  },
  {
    id: "ai_brain_codex_architecture",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "What was the architecture decision behind Codex session ingestion for AI Brain?",
    expectedTerms: ["scan", "promotion", "projection"],
    expectedSections: ["architecture", "source_trail"]
  },
  {
    id: "ai_brain_raw_vs_curated_proof",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "What did we prove about raw transcript embedding and curated summaries for AI Brain Codex ingestion?",
    expectedTerms: ["raw transcript", "curated", "embedding"],
    expectedSections: ["proof_results", "source_trail"]
  },
  {
    id: "ai_brain_tests_benchmarks",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "What tests or benchmark gates verified AI Brain Codex session ingestion?",
    expectedTerms: ["npm run build"],
    expectedSections: ["tests_verification", "source_trail"]
  },
  {
    id: "ai_brain_before_after",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "Show the sources for the AI Brain Codex maintenance metrics.",
    expectedTerms: ["source", "codex-session"],
    expectedSections: ["source_trail"]
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

function answerSectionIds(payload: any): readonly string[] {
  return Array.isArray(payload?.answerSections)
    ? payload.answerSections.map((section: any) => String(section?.id ?? "")).filter(Boolean)
    : [];
}

function payloadText(payload: any): string {
  return JSON.stringify(payload ?? null).toLowerCase();
}

function hasOperatingContextLeak(text: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count/iu.test(text);
}

async function namespaceHasCodexSummaries(namespaceId: string): Promise<boolean> {
  const rows = await queryRows<{ readonly count: string }>(
    "SELECT COUNT(*)::text AS count FROM codex_session_summaries WHERE namespace_id = $1",
    [namespaceId]
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function runScenario(scenario: CodexProjectDetailScenario): Promise<Record<string, unknown>> {
  const hasNamespace = await namespaceHasCodexSummaries(scenario.namespaceId);
  if (!hasNamespace) {
    return {
      ...scenario,
      skipped: true,
      passed: false,
      residualOwner: "source_missing",
      missingTerms: scenario.expectedTerms,
      missingSections: scenario.expectedSections
    };
  }
  const started = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    detail_mode: "compact",
    limit: 10
  })) as { readonly structuredContent?: any };
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const payload = wrapped.structuredContent ?? {};
  const allText = payloadText(payload);
  const sections = answerSectionIds(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !allText.includes(term.toLowerCase()));
  const missingSections = scenario.expectedSections.filter((section) => !sections.includes(section));
  const actualContract =
    typeof payload?.queryContract === "string"
      ? payload.queryContract
      : typeof payload?.meta?.queryContractName === "string"
        ? payload.meta.queryContractName
        : null;
  const finalClaimSource =
    typeof payload?.finalClaimSource === "string"
      ? payload.finalClaimSource
      : typeof payload?.meta?.finalClaimSource === "string"
        ? payload.meta.finalClaimSource
        : null;
  const selectedReader = typeof payload?.meta?.selectedReader === "string" ? payload.meta.selectedReader : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const row = {
    ...scenario,
    skipped: false,
    actualContract,
    finalClaimSource,
    selectedReader,
    retrievalDomain: payload?.retrievalDomain ?? payload?.meta?.retrievalDomain ?? null,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    rawTranscriptRetrievalCount: Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0),
    answerSections: sections,
    missingTerms,
    missingSections,
    operatingContextLeak: hasOperatingContextLeak(allText),
    latencyMs,
    answer: answerText(payload).slice(0, 1200)
  };
  const wrongRoute = finalClaimSource !== "codex_project_detail_report" || selectedReader !== "codex_memory_reader";
  const zeroEvidence = evidenceCount === 0;
  const emptySourceTrail = sourceTrailCount(payload) === 0;
  const missingClaimAudit = claimAuditCount(payload) === 0;
  const wrongShape = missingSections.length > 0;
  const termMiss = missingTerms.length > 0;
  let residualOwner: string | null = null;
  if (wrongRoute) residualOwner = "wrong_route";
  else if (zeroEvidence || emptySourceTrail || missingClaimAudit) residualOwner = "support_envelope_missing";
  else if (wrongShape) residualOwner = "project_detail_wrong_shape";
  else if (termMiss) residualOwner = "project_detail_missing_terms";
  else if (hasOperatingContextLeak(allText)) residualOwner = "operating_context_leak";
  else if (Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0) !== 0) residualOwner = "raw_transcript_retrieval";
  else if (queryTimeModelCallsFromPayload(payload) !== 0) residualOwner = "query_time_model_calls";
  return {
    ...row,
    residualOwner,
    passed: residualOwner === null
  };
}

async function projectionForNamespace(namespaceId: string): Promise<unknown> {
  try {
    return await projectCodexSessionSpecCoverage({ namespaceId });
  } catch (error) {
    return {
      namespaceId,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runCodexProjectDetailPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario)));
  const activeRows = rows.filter((row) => row.skipped !== true);
  const namespaceIds = [...new Set(SCENARIOS.map((scenario) => scenario.namespaceId))];
  const projections = Object.fromEntries(await Promise.all(namespaceIds.map(async (namespaceId) => [namespaceId, await projectionForNamespace(namespaceId)] as const)));
  const metrics = {
    queryCount: rows.length,
    activeQueryCount: activeRows.length,
    projectDetailStrongCount: rows.filter((row) => row.passed === true).length,
    projectDetailStrongRate: rate(rows.filter((row) => row.passed === true).length, rows.length),
    wrongRouteCount: rows.filter((row) => row.residualOwner === "wrong_route").length,
    wrongCorpusCount: rows.filter((row) => row.skipped !== true && row.retrievalDomain !== "engineering_specs").length,
    projectDetailZeroEvidenceCount: rows.filter((row) => Number(row.evidenceCount) === 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.skipped !== true && Number(row.sourceTrailCount) === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.skipped !== true && Number(row.claimAuditCount) === 0).length,
    projectDetailWrongShapeCount: rows.filter((row) => row.residualOwner === "project_detail_wrong_shape").length,
    projectDetailMissingTermCount: rows.filter((row) => row.residualOwner === "project_detail_missing_terms").length,
    sourceAuditWrongCorpusCount: rows.filter((row) => /\bsources?\b/iu.test(String(row.query ?? "")) && row.retrievalDomain !== "engineering_specs").length,
    beforeAfterEvidenceNoAnswerCount: rows.filter((row) => /\bbefore\b|\bchanged\s+between\b/iu.test(String(row.query ?? "")) && Number(row.evidenceCount) > 0 && !String(row.answer ?? "").trim()).length,
    sourceMissingCount: rows.filter((row) => row.residualOwner === "source_missing").length,
    operatingContextLeakCount: rows.filter((row) => row.operatingContextLeak === true).length,
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0),
    p95LatencyMs: activeRows.length > 0 ? [...activeRows].sort((left, right) => Number(left.latencyMs ?? 0) - Number(right.latencyMs ?? 0))[Math.ceil(activeRows.length * 0.95) - 1]?.latencyMs ?? 0 : 0,
    maxLatencyMs: activeRows.reduce((max, row) => Math.max(max, Number(row.latencyMs ?? 0)), 0)
  };
  const failures = [
    metrics.sourceMissingCount !== 0 ? "source_missing" : "",
    metrics.projectDetailStrongCount !== metrics.queryCount ? "project_detail_query_quality_below_gate" : "",
    metrics.wrongRouteCount !== 0 ? "wrong_route" : "",
    metrics.wrongCorpusCount !== 0 ? "wrong_corpus" : "",
    metrics.projectDetailZeroEvidenceCount !== 0 ? "zero_evidence" : "",
    metrics.supportedEmptySourceTrailRows !== 0 ? "empty_source_trail" : "",
    metrics.supportedMissingClaimAuditRows !== 0 ? "missing_claim_audit" : "",
    metrics.projectDetailWrongShapeCount !== 0 ? "wrong_shape" : "",
    metrics.projectDetailMissingTermCount !== 0 ? "missing_terms" : "",
    metrics.sourceAuditWrongCorpusCount !== 0 ? "source_audit_wrong_corpus" : "",
    metrics.beforeAfterEvidenceNoAnswerCount !== 0 ? "before_after_evidence_no_answer" : "",
    metrics.operatingContextLeakCount !== 0 ? "operating_context_leak" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_project_detail_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaces: namespaceIds.join(",") }
    }),
    projections,
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const suffix = stamp();
  const base = `codex-project-detail-pack-${suffix}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Project Detail Pack",
      "",
      `- passed: ${report.passed}`,
      `- projectDetailStrongCount: ${metrics.projectDetailStrongCount}/${metrics.queryCount}`,
      `- projectDetailStrongRate: ${metrics.projectDetailStrongRate}`,
      `- wrongRouteCount: ${metrics.wrongRouteCount}`,
      `- wrongCorpusCount: ${metrics.wrongCorpusCount}`,
      `- projectDetailZeroEvidenceCount: ${metrics.projectDetailZeroEvidenceCount}`,
      `- supportedEmptySourceTrailRows: ${metrics.supportedEmptySourceTrailRows}`,
      `- supportedMissingClaimAuditRows: ${metrics.supportedMissingClaimAuditRows}`,
      `- projectDetailWrongShapeCount: ${metrics.projectDetailWrongShapeCount}`,
      `- projectDetailMissingTermCount: ${metrics.projectDetailMissingTermCount}`,
      `- sourceAuditWrongCorpusCount: ${metrics.sourceAuditWrongCorpusCount}`,
      `- beforeAfterEvidenceNoAnswerCount: ${metrics.beforeAfterEvidenceNoAnswerCount}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      "",
      "## Query Rows",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak owner=${row.residualOwner} missingTerms=${row.missingTerms?.join(", ") ?? ""} missingSections=${row.missingSections?.join(", ") ?? ""}`} -> ${row.answer ?? ""}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexProjectDetailPackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexProjectDetailPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-project-detail-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
