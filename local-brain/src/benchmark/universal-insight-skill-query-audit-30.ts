import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

const LATENCY_TAIL_THRESHOLD_MS = 5000;
const COMPACT_ANSWER_TOKEN_BUDGET = 700;
const STRUCTURED_PAYLOAD_BYTE_BUDGET = 64_000;

interface SkillAuditScenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
}

interface SkillAuditRow extends SkillAuditScenario {
  readonly toolName: "memory.search";
  readonly rating: "strong" | "weak" | "failed" | "source_missing";
  readonly answerExcerpt: string;
  readonly queryContract: string | null;
  readonly finalClaimSource: string | null;
  readonly selectedReader: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly suggestionCount: number;
  readonly unsupportedInsightClaimCount: number;
  readonly unsupportedSuggestionCount: number;
  readonly queryTimeModelCalls: number;
  readonly missingTerms: readonly string[];
  readonly latencyMs: number;
  readonly primaryAnswerTokenEstimate: number;
  readonly structuredPayloadBytes: number;
  readonly sourceQuoteCount: number;
  readonly expandableDetailAvailable: boolean;
  readonly rawJsonLeak: boolean;
  readonly engineeringMetadataLeak: boolean;
  readonly residualOwner: string | null;
}

interface UniversalInsightSkillQueryAudit30Report {
  readonly generatedAt: string;
  readonly benchmark: "universal_insight_skill_query_audit_30";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: "personal";
  readonly passed: boolean;
  readonly metrics: {
    readonly totalRows: number;
    readonly strongRows: number;
    readonly weakRows: number;
    readonly failedRows: number;
    readonly sourceMissingRows: number;
    readonly missingExpectedTermRows: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly unsupportedInsightClaimCount: number;
    readonly unsupportedSuggestionCount: number;
    readonly queryTimeModelCalls: number;
    readonly latencyTailThresholdMs: number;
    readonly latencyTailRows: number;
    readonly latencyTailRowIds: readonly string[];
    readonly compactAnswerTokenBudget: number;
    readonly compactAnswerOverBudgetRows: number;
    readonly compactAnswerOverBudgetRowIds: readonly string[];
    readonly p95PrimaryAnswerTokenEstimate: number;
    readonly maxPrimaryAnswerTokenEstimate: number;
    readonly structuredPayloadByteBudget: number;
    readonly structuredPayloadOverBudgetRows: number;
    readonly structuredPayloadOverBudgetRowIds: readonly string[];
    readonly p95StructuredPayloadBytes: number;
    readonly maxStructuredPayloadBytes: number;
    readonly rawJsonLeakCount: number;
    readonly engineeringMetadataLeakCount: number;
    readonly sourceQuoteCount: number;
    readonly expandableDetailAvailableRows: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly SkillAuditRow[];
  readonly failures: readonly string[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function scenarios(): readonly SkillAuditScenario[] {
  return [
    { id: "codex_token_waste_suggestions", query: "What token waste patterns show up in Codex sessions, and what should I do about them?", expectedTerms: ["Codex", "source", "suggest"] },
    { id: "codex_repeated_agent_rules", query: "Which repeated Codex instructions should become permanent agent rules?", expectedTerms: ["Codex", "rule"] },
    { id: "codex_skill_candidates", query: "What reusable skills or checklists should come out of my Codex work?", expectedTerms: ["skill", "checklist"] },
    { id: "codex_workflow_patterns", query: "What workflow patterns keep repeating across my Codex sessions?", expectedTerms: ["pattern", "source"] },
    { id: "codex_docs_drift", query: "What did we learn about docs drift from Codex sessions?", expectedTerms: ["docs", "source"] },
    { id: "omi_recent_travel_learning", query: "What did we learn from my recent OMI travel planning notes?", expectedTerms: ["travel", "source"] },
    { id: "omi_calendar_commitments", query: "What calendar-like commitments are implied by my latest OMI notes?", expectedTerms: ["calendar", "source"] },
    { id: "omi_stale_travel_tasks", query: "What stale or uncertain travel tasks should I review from OMI notes?", expectedTerms: ["travel", "task"] },
    { id: "omi_july_september_dates", query: "What dates or time windows are connected to my July and September travel planning?", expectedTerms: ["July", "September"] },
    { id: "omi_note_patterns", query: "What patterns show up in my OMI notes that should become tasks or reminders?", expectedTerms: ["task", "source"] },
    { id: "research_temporal_kg", query: "What did the temporal KG research teach us to add to AI Brain?", expectedTerms: ["temporal", "source"] },
    { id: "research_event_dialogue_time", query: "What did we learn about separating event time from note or dialogue time?", expectedTerms: ["event", "time"] },
    { id: "research_citation_faithfulness", query: "What should we improve based on the citation and source-faithfulness research?", expectedTerms: ["citation", "source"] },
    { id: "research_source_windows", query: "What did source-window research teach us about retrieval efficiency?", expectedTerms: ["source", "window"] },
    { id: "research_rag_missing", query: "Compare the RAG research notes and our retrieval system; what is still missing?", expectedTerms: ["retrieval", "missing"] },
    { id: "repo_recurring_weaknesses", query: "What recurring weaknesses are documented across the latest checkpoints?", expectedTerms: ["weak", "source"] },
    { id: "repo_next_engineering_tasks", query: "What should be the next three engineering tasks based on the task lists?", expectedTerms: ["task", "source"] },
    { id: "repo_clean_main_lessons", query: "What did the clean-main smoke results teach us?", expectedTerms: ["clean", "smoke"] },
    { id: "repo_latency_tail", query: "What latency tail should we track from the latest retrieval audits?", expectedTerms: ["latency", "tail"] },
    { id: "repo_source_audit_lessons", query: "What did we learn from the source-audit and claim-audit gates?", expectedTerms: ["source", "audit"] },
    { id: "task_retrieval_weaknesses", query: "What tasks should be generated from the current retrieval weaknesses?", expectedTerms: ["task", "retrieval"] },
    { id: "task_calendar_improvements", query: "What task and calendar improvements should come out of the temporal notes?", expectedTerms: ["task", "calendar"] },
    { id: "task_skill_checklist", query: "What should become a new skill, automation, or checklist?", expectedTerms: ["skill", "checklist"] },
    { id: "task_stale_open", query: "What did we learn about stale open tasks and lifecycle cleanup?", expectedTerms: ["stale", "task"] },
    { id: "task_evidence_gaps", query: "What task evidence gaps still need better projected support?", expectedTerms: ["task", "evidence"] },
    { id: "cross_corpus_evidence_gaps", query: "What are the biggest evidence gaps across Codex, OMI, PDFs, and tasks?", expectedTerms: ["Codex", "OMI"] },
    { id: "cross_corpus_overall", query: "What did we learn overall, what should we do next, and where are the sources?", expectedTerms: ["source", "next"] },
    { id: "cross_corpus_better_results", query: "What could make our retrieval answers more natural and useful to a human?", expectedTerms: ["answer", "source"] },
    { id: "cross_corpus_before_after", query: "How did the latest benchmark results improve the system?", expectedTerms: ["benchmark", "improve"] },
    { id: "cross_corpus_product_risk", query: "What are the top risks before calling this retrieval layer product-ready?", expectedTerms: ["risk", "source"] }
  ];
}

function structuredContent(result: unknown): Record<string, any> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, any>) : {};
}

function answerText(payload: Record<string, any>): string {
  const humanReadable = typeof payload.humanReadable === "string" ? payload.humanReadable : "";
  const answer = typeof payload.answer === "string" ? payload.answer : "";
  return (humanReadable || answer || "").replace(/\s+/gu, " ").trim();
}

function estimateTokens(value: string): number {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sourceQuoteCount(payload: Record<string, any>): number {
  if (Array.isArray(payload.sourceQuotes) && payload.sourceQuotes.length > 0) {
    return payload.sourceQuotes.length;
  }
  const trailQuotes = Array.isArray(payload.sourceTrail)
    ? payload.sourceTrail.filter((item: any) => typeof item?.quote === "string" && item.quote.trim().length > 0).length
    : 0;
  const auditQuotes = Array.isArray(payload.claimAudit)
    ? payload.claimAudit.reduce((sum: number, entry: any) => sum + (Array.isArray(entry?.sourceQuotes) ? entry.sourceQuotes.length : 0), 0)
    : 0;
  return trailQuotes + auditQuotes;
}

function hasExpandableDetail(payload: Record<string, any>): boolean {
  return Boolean(
    payload.expandable === true ||
      payload.memoryPacketId ||
      (Array.isArray(payload.sourceWindowIds) && payload.sourceWindowIds.length > 0) ||
      (Array.isArray(payload.summaryNodeIds) && payload.summaryNodeIds.length > 0) ||
      (Array.isArray(payload.answerSections) && payload.answerSections.length > 0)
  );
}

function answerHasRawJsonLeak(answer: string): boolean {
  return /(?:^\s*\{[\s\S]*\}\s*$|"\w+"\s*:|\[\s*\{)/u.test(answer);
}

function answerHasEngineeringMetadataLeak(answer: string): boolean {
  return /\b(?:queryContract|retrievalDomain|finalClaimSource|selectedReader|claimAudit|sourceTrail|selectionTrace|evidenceCount)\b/u.test(answer);
}

function excerpt(value: string): string {
  return value.length > 420 ? `${value.slice(0, 417)}...` : value;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function missingTerms(answer: string, terms: readonly string[]): readonly string[] {
  const lower = answer.toLowerCase();
  return terms.filter((term) => !lower.includes(term.toLowerCase()));
}

async function runScenario(scenario: SkillAuditScenario): Promise<SkillAuditRow> {
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: "personal",
    query: scenario.query,
    detail_mode: "compact",
    limit: 8
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const payload = structuredContent(result);
  const answer = answerText(payload);
  const structuredPayloadBytes = byteLength(JSON.stringify(payload));
  const primaryAnswerTokenEstimate = estimateTokens(answer);
  const rawJsonLeak = answerHasRawJsonLeak(answer);
  const engineeringMetadataLeak = answerHasEngineeringMetadataLeak(answer);
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const suggestionCount = Array.isArray(payload.suggestions) ? payload.suggestions.length : 0;
  const verification = payload.insightVerification && typeof payload.insightVerification === "object" ? payload.insightVerification : {};
  const unsupportedInsightClaimCount = typeof verification.unsupportedInsightClaimCount === "number" ? verification.unsupportedInsightClaimCount : 0;
  const unsupportedSuggestionCount = typeof verification.unsupportedSuggestionCount === "number" ? verification.unsupportedSuggestionCount : 0;
  const queryTimeModelCalls = typeof verification.queryTimeModelCalls === "number" ? verification.queryTimeModelCalls : typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const missing = missingTerms(answer, scenario.expectedTerms);
  const rating: SkillAuditRow["rating"] =
    evidenceCount === 0
      ? "source_missing"
      : payload.queryContract === "insight_report" &&
          payload.finalClaimSource === "insight_report" &&
          sourceTrailCount > 0 &&
          claimAuditCount > 0 &&
          suggestionCount > 0 &&
          unsupportedInsightClaimCount === 0 &&
          unsupportedSuggestionCount === 0 &&
          missing.length === 0 &&
          answer.length >= 80 &&
          primaryAnswerTokenEstimate <= COMPACT_ANSWER_TOKEN_BUDGET &&
          structuredPayloadBytes <= STRUCTURED_PAYLOAD_BYTE_BUDGET &&
          !rawJsonLeak &&
          !engineeringMetadataLeak
        ? "strong"
        : evidenceCount > 0 && sourceTrailCount > 0 && claimAuditCount > 0 && unsupportedInsightClaimCount === 0 && unsupportedSuggestionCount === 0
          ? "weak"
          : "failed";
  const residualOwner =
    latencyMs > LATENCY_TAIL_THRESHOLD_MS
      ? "latency_tail"
      : primaryAnswerTokenEstimate > COMPACT_ANSWER_TOKEN_BUDGET
        ? "compact_answer_token_budget"
        : structuredPayloadBytes > STRUCTURED_PAYLOAD_BYTE_BUDGET
          ? "structured_payload_budget"
          : rawJsonLeak
            ? "raw_json_leak"
            : engineeringMetadataLeak
              ? "engineering_metadata_leak"
              : rating === "strong"
                ? null
                : rating === "source_missing"
                  ? "source_missing"
                  : missing.length > 0
                    ? "missing_expected_terms"
                    : sourceTrailCount === 0 || claimAuditCount === 0
                      ? "missing_source_or_claim_audit"
                      : unsupportedInsightClaimCount > 0 || unsupportedSuggestionCount > 0
                        ? "unsupported_insight_or_suggestion"
                        : "presenter_shape";
  return {
    ...scenario,
    toolName: "memory.search",
    rating,
    answerExcerpt: excerpt(answer),
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    selectedReader: typeof payload.selectedReader === "string" ? payload.selectedReader : null,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    suggestionCount,
    unsupportedInsightClaimCount,
    unsupportedSuggestionCount,
    queryTimeModelCalls,
    missingTerms: missing,
    latencyMs,
    primaryAnswerTokenEstimate,
    structuredPayloadBytes,
    sourceQuoteCount: sourceQuoteCount(payload),
    expandableDetailAvailable: hasExpandableDetail(payload),
    rawJsonLeak,
    engineeringMetadataLeak,
    residualOwner
  };
}

function toMarkdown(report: UniversalInsightSkillQueryAudit30Report): string {
  const rows = report.rows.map((row, index) => [
    `### ${index + 1}. ${row.query}`,
    "",
    `- rating: ${row.rating}`,
    `- latencyMs: ${row.latencyMs}`,
    `- evidence/source/claimAudit: ${row.evidenceCount}/${row.sourceTrailCount}/${row.claimAuditCount}`,
    `- residualOwner: ${row.residualOwner ?? "none"}`,
    `- payload budget: answerTokens=${row.primaryAnswerTokenEstimate}, structuredBytes=${row.structuredPayloadBytes}, sourceQuotes=${row.sourceQuoteCount}, expandable=${row.expandableDetailAvailable}`,
    `- answer: ${row.answerExcerpt}`,
    ""
  ].join("\n"));
  return [
    "# Universal Insight Skill Query Audit 30",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Metrics",
    "",
    ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value}`),
    "",
    "## Rows",
    "",
    ...rows,
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runUniversalInsightSkillQueryAudit30(): Promise<{
  readonly report: UniversalInsightSkillQueryAudit30Report;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const rows: SkillAuditRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(scenario));
  }
  const supportedRows = rows.filter((row) => row.rating !== "source_missing");
  const latencyTailRows = rows.filter((row) => row.latencyMs > LATENCY_TAIL_THRESHOLD_MS);
  const compactAnswerOverBudgetRows = rows.filter((row) => row.primaryAnswerTokenEstimate > COMPACT_ANSWER_TOKEN_BUDGET);
  const structuredPayloadOverBudgetRows = rows.filter((row) => row.structuredPayloadBytes > STRUCTURED_PAYLOAD_BYTE_BUDGET);
  const metrics = {
    totalRows: rows.length,
    strongRows: rows.filter((row) => row.rating === "strong").length,
    weakRows: rows.filter((row) => row.rating === "weak").length,
    failedRows: rows.filter((row) => row.rating === "failed").length,
    sourceMissingRows: rows.filter((row) => row.rating === "source_missing").length,
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    unsupportedInsightClaimCount: rows.reduce((sum, row) => sum + row.unsupportedInsightClaimCount, 0),
    unsupportedSuggestionCount: rows.reduce((sum, row) => sum + row.unsupportedSuggestionCount, 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    latencyTailThresholdMs: LATENCY_TAIL_THRESHOLD_MS,
    latencyTailRows: latencyTailRows.length,
    latencyTailRowIds: latencyTailRows.map((row) => row.id),
    compactAnswerTokenBudget: COMPACT_ANSWER_TOKEN_BUDGET,
    compactAnswerOverBudgetRows: compactAnswerOverBudgetRows.length,
    compactAnswerOverBudgetRowIds: compactAnswerOverBudgetRows.map((row) => row.id),
    p95PrimaryAnswerTokenEstimate: percentile(rows.map((row) => row.primaryAnswerTokenEstimate), 95),
    maxPrimaryAnswerTokenEstimate: Math.max(...rows.map((row) => row.primaryAnswerTokenEstimate), 0),
    structuredPayloadByteBudget: STRUCTURED_PAYLOAD_BYTE_BUDGET,
    structuredPayloadOverBudgetRows: structuredPayloadOverBudgetRows.length,
    structuredPayloadOverBudgetRowIds: structuredPayloadOverBudgetRows.map((row) => row.id),
    p95StructuredPayloadBytes: percentile(rows.map((row) => row.structuredPayloadBytes), 95),
    maxStructuredPayloadBytes: Math.max(...rows.map((row) => row.structuredPayloadBytes), 0),
    rawJsonLeakCount: rows.filter((row) => row.rawJsonLeak).length,
    engineeringMetadataLeakCount: rows.filter((row) => row.engineeringMetadataLeak).length,
    sourceQuoteCount: rows.reduce((sum, row) => sum + row.sourceQuoteCount, 0),
    expandableDetailAvailableRows: rows.filter((row) => row.expandableDetailAvailable).length,
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(...rows.map((row) => row.latencyMs), 0).toFixed(2))
  };
  const failures = [
    metrics.strongRows < 27 ? "strong_rows_below_27" : "",
    metrics.failedRows !== 0 ? "failed_rows_present" : "",
    metrics.sourceMissingRows !== 0 ? "source_missing_rows_present" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.unsupportedInsightClaimCount !== 0 ? "unsupported_insight_claims_present" : "",
    metrics.unsupportedSuggestionCount !== 0 ? "unsupported_suggestions_present" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : "",
    metrics.compactAnswerOverBudgetRows !== 0 ? "compact_answer_token_budget_exceeded" : "",
    metrics.structuredPayloadOverBudgetRows !== 0 ? "structured_payload_byte_budget_exceeded" : "",
    metrics.rawJsonLeakCount !== 0 ? "raw_json_leak_present" : "",
    metrics.engineeringMetadataLeakCount !== 0 ? "engineering_metadata_leak_present" : ""
  ].filter(Boolean);
  const report: UniversalInsightSkillQueryAudit30Report = {
    generatedAt: new Date().toISOString(),
    benchmark: "universal_insight_skill_query_audit_30",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: "personal", scenarioCount: scenarios().length }
    }),
    namespaceId: "personal",
    passed: failures.length === 0,
    metrics,
    rows,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `universal-insight-skill-query-audit-30-${generatedAt}.json`);
  const markdownPath = path.join(dir, `universal-insight-skill-query-audit-30-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runUniversalInsightSkillQueryAudit30Cli(): Promise<void> {
  const { report, output } = await runUniversalInsightSkillQueryAudit30();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
