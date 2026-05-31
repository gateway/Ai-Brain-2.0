import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildMemorySummaryDag, upsertMemorySourceWindow, type MemoryPacketSourceKind } from "../memory-packets/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface FixtureWindow {
  readonly sourceKind: MemoryPacketSourceKind;
  readonly sourceUri: string;
  readonly key: string;
  readonly text: string;
}

interface Scenario {
  readonly id: string;
  readonly category: "codex" | "omi" | "pdf" | "repo" | "task_calendar" | "cross_corpus";
  readonly query: string;
  readonly expectedTerms: readonly string[];
}

interface InsightRow extends Scenario {
  readonly quality: "strong" | "weak" | "fail" | "source_missing";
  readonly answer: string | null;
  readonly humanAnswer: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly finalClaimSource: string | null;
  readonly selectedReader: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly suggestionCount: number;
  readonly exampleCount: number;
  readonly unsupportedInsightClaimCount: number;
  readonly unsupportedSuggestionCount: number;
  readonly citationFaithfulnessScore: number;
  readonly queryTimeModelCalls: number;
  readonly engineeringJargonLeak: boolean;
  readonly missingTerms: readonly string[];
  readonly latencyMs: number;
  readonly residualOwner: string | null;
}

interface UniversalInsightReportPackReport {
  readonly generatedAt: string;
  readonly benchmark: "universal_insight_report_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly totalRows: number;
    readonly strongRows: number;
    readonly weakRows: number;
    readonly failRows: number;
    readonly sourceMissingRows: number;
    readonly sourceTrailCoverageRate: number;
    readonly claimAuditCoverageRate: number;
    readonly unsupportedInsightClaimCount: number;
    readonly unsupportedSuggestionCount: number;
    readonly citationFaithfulnessScore: number;
    readonly humanReadableRate: number;
    readonly engineeringJargonLeakCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly InsightRow[];
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

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function namespaceId(): string {
  return `fixture_universal_insight_${stamp().toLowerCase()}`;
}

function fixtures(): readonly FixtureWindow[] {
  return [
    {
      sourceKind: "codex_session",
      sourceUri: "codex://ai-brain/token-waste-week",
      key: "insight-codex-token-waste",
      text: "Codex token waste patterns include rereading large docs, repeated benchmark logs, oversized pasted prompts, stale task lists, and missing compact focus packets. Suggested fixes were compact failure artifacts, reusable focus packets, and moving repeated instructions into agent rules."
    },
    {
      sourceKind: "codex_session",
      sourceUri: "codex://media-studio/reusable-skills",
      key: "insight-codex-media-studio-skills",
      text: "Media Studio Codex sessions repeatedly asked for no hardcoded patches, browser verification, source-bound summaries, project aliases, and reusable skills for graph and preset workflows."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/travel-planning",
      key: "insight-omi-travel",
      text: "Recent OMI travel planning notes mentioned mid to late July travel, September travel after Burning Man, Chiang Mai flight planning, date confirmation, stale travel tasks, and open tasks that should become calendar-linked reminders."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/social-chiang-mai",
      key: "insight-omi-social",
      text: "Chiang Mai social notes mention Dan, Gummi, Tim, and Ben, plus local meetup and coworking context. The recurring pattern is that people, places, and introductions need relationship plus place-scoped retrieval."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://temporal-kg-paper.pdf#page=4",
      key: "insight-pdf-temporal-kg",
      text: "Temporal KG research recommends separating event time from dialogue time, preserving temporal support paths, decomposing subject relation time constraints, and comparing event windows for change questions."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://citation-verification.pdf#section=vericite",
      key: "insight-pdf-vericite",
      text: "Citation verification research recommends generating answers from retrieved support, checking each claim against citations, refining unsupported claims, and exposing citation faithfulness metrics."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/brain-spec/local/2026-05-31-expandable-memory-presenter-checkpoint.md",
      key: "insight-repo-presenter-checkpoint",
      text: "The expandable memory presenter pass improved top-level answer coverage to 1, compact human-readable rate to 1, source-window prefix leaks to 0, and clean-main smoke passed 10 out of 10 steps."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/brain-spec/local/2026-05-31-universal-insight-report-production-spec.md",
      key: "insight-repo-insight-spec",
      text: "The universal insight report spec says retrieval selects evidence, the insight layer explains evidence, the verifier enforces source support, and suggestions must be separated from supported facts."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://retrieval-weaknesses",
      key: "insight-task-retrieval-weaknesses",
      text: "Current retrieval weakness tasks include implementing insight_report, adding support bundle verification, running a 30-query fixture pack, updating skill guidance, and documenting before-after artifacts."
    },
    {
      sourceKind: "calendar_export",
      sourceUri: "calendar-export://travel-2026",
      key: "insight-calendar-travel",
      text: "Calendar-like travel commitments include confirming mid to late July dates, checking September plans after Burning Man, booking Chiang Mai flights, and reviewing stale travel tasks."
    },
    {
      sourceKind: "markdown",
      sourceUri: "markdown://notes/self-healing-loop.md",
      key: "insight-markdown-self-healing",
      text: "Self-healing notes say each weak answer should record a residual owner, fix the reusable layer only, rerun the smallest failing pack, then rerun broader regression gates."
    },
    {
      sourceKind: "markdown",
      sourceUri: "markdown://notes/evidence-gaps.md",
      key: "insight-markdown-evidence-gaps",
      text: "Evidence gaps across Codex, OMI, PDFs, and tasks often come from missing source windows, missing typed projections, weak presenter shaping, or unsupported suggestions without claim audit."
    }
  ];
}

function scenarios(): readonly Scenario[] {
  return [
    { id: "codex_01", category: "codex", query: "What repeated instructions have I given Codex, and what should become an agent rule?", expectedTerms: ["agent rules", "repeated instructions"] },
    { id: "codex_02", category: "codex", query: "What token waste patterns show up in Codex sessions, with examples and suggested fixes?", expectedTerms: ["rereading large docs", "focus packets"] },
    { id: "codex_03", category: "codex", query: "What did we learn from the clean-main smoke work?", expectedTerms: ["clean-main smoke", "10 out of 10"] },
    { id: "codex_04", category: "codex", query: "What patterns from Media Studio work should become reusable skills?", expectedTerms: ["Media Studio", "reusable skills"] },
    { id: "codex_05", category: "codex", query: "How did Codex retrieval improve from last week, and what evidence supports that?", expectedTerms: ["top-level answer coverage", "human-readable rate"] },
    { id: "omi_01", category: "omi", query: "What did we learn from my recent OMI travel planning notes?", expectedTerms: ["mid to late July", "calendar-linked reminders"] },
    { id: "omi_02", category: "omi", query: "What tasks or reminders should come out of my July travel planning?", expectedTerms: ["July dates", "booking Chiang Mai flights"] },
    { id: "omi_03", category: "omi", query: "What patterns show up in my Chiang Mai social notes?", expectedTerms: ["Dan", "place-scoped retrieval"] },
    { id: "omi_04", category: "omi", query: "What is still uncertain in my recent personal planning notes?", expectedTerms: ["date confirmation", "stale travel tasks"] },
    { id: "omi_05", category: "omi", query: "What suggestions can you make from my recent OMI tasks, with sources?", expectedTerms: ["calendar-linked", "source"] },
    { id: "pdf_01", category: "pdf", query: "What did the temporal KG papers suggest we should add to AI Brain?", expectedTerms: ["event time", "support paths"] },
    { id: "pdf_02", category: "pdf", query: "What did the lossless context research teach us about source windows?", expectedTerms: ["source windows", "source support"] },
    { id: "pdf_03", category: "pdf", query: "What research-backed ideas should become engineering tasks?", expectedTerms: ["citation verification", "event windows"] },
    { id: "pdf_04", category: "pdf", query: "Compare the RAG research notes and our current retrieval system; what is missing?", expectedTerms: ["citation faithfulness", "unsupported claims"] },
    { id: "pdf_05", category: "pdf", query: "What should we change based on citation verification research?", expectedTerms: ["checking each claim", "citations"] },
    { id: "repo_01", category: "repo", query: "What did we complete in the expandable memory packet slice, and what remains?", expectedTerms: ["presenter pass", "source-window prefix leaks"] },
    { id: "repo_02", category: "repo", query: "What recurring weaknesses are documented across the latest checkpoints?", expectedTerms: ["weak presenter shaping", "missing typed projections"] },
    { id: "repo_03", category: "repo", query: "What should be the next three engineering tasks based on the task lists?", expectedTerms: ["insight_report", "30-query fixture pack"] },
    { id: "repo_04", category: "repo", query: "How did the benchmark results improve after the presenter pass?", expectedTerms: ["human-readable rate", "prefix leaks"] },
    { id: "repo_05", category: "repo", query: "Which specs mention self-healing, and what should we implement next?", expectedTerms: ["residual owner", "rerun"] },
    { id: "task_01", category: "task_calendar", query: "What tasks should be generated from the current retrieval weaknesses?", expectedTerms: ["support bundle verification", "skill guidance"] },
    { id: "task_02", category: "task_calendar", query: "What dates or time windows are connected to the open travel tasks?", expectedTerms: ["mid to late July", "September"] },
    { id: "task_03", category: "task_calendar", query: "What changed about July and September travel plans, and what should I do?", expectedTerms: ["July", "September"] },
    { id: "task_04", category: "task_calendar", query: "What calendar-like commitments are implied by the latest OMI notes?", expectedTerms: ["booking Chiang Mai flights", "September plans"] },
    { id: "task_05", category: "task_calendar", query: "What stale tasks should be closed or reviewed?", expectedTerms: ["stale travel tasks", "reviewing"] },
    { id: "cross_01", category: "cross_corpus", query: "What are the top three ways to make AI Brain more useful to a non-engineering user?", expectedTerms: ["human-readable", "suggestions"] },
    { id: "cross_02", category: "cross_corpus", query: "What are the biggest evidence gaps across Codex, OMI, PDFs, and tasks?", expectedTerms: ["missing source windows", "claim audit"] },
    { id: "cross_03", category: "cross_corpus", query: "What patterns repeat across my work, planning, and research data?", expectedTerms: ["source support", "calendar-linked"] },
    { id: "cross_04", category: "cross_corpus", query: "What should become a new skill, automation, or checklist?", expectedTerms: ["agent rules", "checklist"] },
    { id: "cross_05", category: "cross_corpus", query: "What did we learn overall, what should we do next, and where are the sources?", expectedTerms: ["retrieval selects evidence", "source"] }
  ];
}

function structuredContent(result: unknown): Record<string, any> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, any>) : {};
}

function includesTerm(payload: unknown, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function hasEngineeringJargonLeak(value: string | null): boolean {
  if (!value) return false;
  return /\b(?:finalClaimSource|selectedReader|queryContract|retrievalDomain|claimAuditCount|sourceTrailCount|duality_v2)\b/u.test(value);
}

async function seed(namespace: string): Promise<void> {
  for (const [index, fixture] of fixtures().entries()) {
    await upsertMemorySourceWindow({
      namespaceId: namespace,
      artifactId: `artifact-${fixture.key}`,
      sourceWindowKey: fixture.key,
      sourceKind: fixture.sourceKind,
      sourceUri: fixture.sourceUri,
      startLocator: `insight:${index}:start`,
      endLocator: `insight:${index}:end`,
      text: fixture.text,
      capturedAt: "2026-05-31T00:00:00.000Z",
      occurredAt: "2026-05-31T00:00:00.000Z",
      metadata: {
        fixture: true,
        audit: "universal_insight_report_pack",
        redaction_checked: true,
        large_block_externalized: true
      }
    });
  }
}

async function runScenario(namespace: string, scenario: Scenario): Promise<InsightRow> {
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: namespace,
    query: scenario.query,
    detail_mode: "full",
    limit: 8
  });
  const latencyMs = performance.now() - startedAt;
  const payload = structuredContent(result);
  const answer = typeof payload.answer === "string" && payload.answer.trim() ? payload.answer.trim() : null;
  const humanAnswer = typeof payload.humanReadable?.answer === "string" ? payload.humanReadable.answer : null;
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const suggestionCount = Array.isArray(payload.suggestions) ? payload.suggestions.length : 0;
  const exampleCount = Array.isArray(payload.examples) ? payload.examples.length : 0;
  const verification = payload.insightVerification && typeof payload.insightVerification === "object" ? payload.insightVerification : {};
  const unsupportedInsightClaimCount = typeof verification.unsupportedInsightClaimCount === "number" ? verification.unsupportedInsightClaimCount : 0;
  const unsupportedSuggestionCount = typeof verification.unsupportedSuggestionCount === "number" ? verification.unsupportedSuggestionCount : 0;
  const citationFaithfulnessScore = typeof verification.citationFaithfulnessScore === "number" ? verification.citationFaithfulnessScore : 0;
  const queryTimeModelCalls = typeof verification.queryTimeModelCalls === "number" ? verification.queryTimeModelCalls : typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const engineeringJargonLeak = hasEngineeringJargonLeak(humanAnswer);
  const missingTerms = scenario.expectedTerms.filter((term) => !includesTerm({ answer, humanAnswer, insightReport: payload.insightReport, sourceTrail: payload.sourceTrail }, term));
  const quality: InsightRow["quality"] =
    evidenceCount === 0
      ? "source_missing"
      : payload.queryContract !== "insight_report" || payload.finalClaimSource !== "insight_report"
        ? "fail"
        : sourceTrailCount > 0 &&
            claimAuditCount > 0 &&
            suggestionCount > 0 &&
            exampleCount > 0 &&
            unsupportedInsightClaimCount === 0 &&
            unsupportedSuggestionCount === 0 &&
            citationFaithfulnessScore >= 0.95 &&
            !engineeringJargonLeak &&
            missingTerms.length === 0
          ? "strong"
          : "weak";
  const residualOwner =
    quality === "strong"
      ? null
      : evidenceCount === 0
        ? "source_missing"
        : payload.queryContract !== "insight_report" || payload.finalClaimSource !== "insight_report"
          ? "wrong_contract_or_route"
          : sourceTrailCount === 0 || claimAuditCount === 0
            ? "missing_source_or_claim_audit"
            : suggestionCount === 0 || exampleCount === 0
              ? "missing_examples_or_suggestions"
              : unsupportedInsightClaimCount > 0 || unsupportedSuggestionCount > 0
                ? "unsupported_insight_or_suggestion"
                : engineeringJargonLeak
                  ? "engineering_jargon_leak"
                  : missingTerms.length > 0
                    ? "missing_expected_terms"
                    : "unknown_owner";
  return {
    ...scenario,
    quality,
    answer,
    humanAnswer,
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    retrievalDomain: typeof payload.retrievalDomain === "string" ? payload.retrievalDomain : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    selectedReader: typeof payload.selectedReader === "string" ? payload.selectedReader : null,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    suggestionCount,
    exampleCount,
    unsupportedInsightClaimCount,
    unsupportedSuggestionCount,
    citationFaithfulnessScore,
    queryTimeModelCalls,
    engineeringJargonLeak,
    missingTerms,
    latencyMs: Number(latencyMs.toFixed(2)),
    residualOwner
  };
}

function toMarkdown(report: UniversalInsightReportPackReport): string {
  return [
    "# Universal Insight Report Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- namespaceId: ${report.namespaceId}`,
    "",
    "## Metrics",
    "",
    ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Rows",
    "",
    ...report.rows.map((row) => `- ${row.id}: ${row.quality}; evidence=${row.evidenceCount}; sources=${row.sourceTrailCount}; suggestions=${row.suggestionCount}; missing=${row.missingTerms.join(", ") || "none"}; owner=${row.residualOwner ?? "none"}`),
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runUniversalInsightReportPack(): Promise<{
  readonly report: UniversalInsightReportPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const namespace = namespaceId();
  await seed(namespace);
  await buildMemorySummaryDag({ namespaceId: namespace });
  const rows: InsightRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(namespace, scenario));
  }
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const latencies = rows.map((row) => row.latencyMs);
  const strongRows = rows.filter((row) => row.quality === "strong").length;
  const weakRows = rows.filter((row) => row.quality === "weak").length;
  const failRows = rows.filter((row) => row.quality === "fail").length;
  const sourceMissingRows = rows.filter((row) => row.quality === "source_missing").length;
  const metrics = {
    totalRows: rows.length,
    strongRows,
    weakRows,
    failRows,
    sourceMissingRows,
    sourceTrailCoverageRate: rate(supportedRows.filter((row) => row.sourceTrailCount > 0).length, supportedRows.length),
    claimAuditCoverageRate: rate(supportedRows.filter((row) => row.claimAuditCount > 0).length, supportedRows.length),
    unsupportedInsightClaimCount: rows.reduce((sum, row) => sum + row.unsupportedInsightClaimCount, 0),
    unsupportedSuggestionCount: rows.reduce((sum, row) => sum + row.unsupportedSuggestionCount, 0),
    citationFaithfulnessScore: supportedRows.length === 0 ? 0 : Number((supportedRows.reduce((sum, row) => sum + row.citationFaithfulnessScore, 0) / supportedRows.length).toFixed(4)),
    humanReadableRate: rate(rows.filter((row) => row.humanAnswer !== null && !row.engineeringJargonLeak).length, rows.length),
    engineeringJargonLeakCount: rows.filter((row) => row.engineeringJargonLeak).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    rows.length !== 30 ? "scenario_count_not_30" : "",
    metrics.strongRows < 29 ? "strong_rows_below_gate" : "",
    metrics.failRows !== 0 ? "fail_rows_present" : "",
    metrics.sourceMissingRows !== 0 ? "source_missing_rows_present" : "",
    metrics.sourceTrailCoverageRate !== 1 ? "source_trail_coverage_below_gate" : "",
    metrics.claimAuditCoverageRate !== 1 ? "claim_audit_coverage_below_gate" : "",
    metrics.unsupportedInsightClaimCount !== 0 ? "unsupported_insight_claims_present" : "",
    metrics.unsupportedSuggestionCount !== 0 ? "unsupported_suggestions_present" : "",
    metrics.citationFaithfulnessScore < 0.95 ? "citation_faithfulness_below_gate" : "",
    metrics.humanReadableRate < 0.95 ? "human_readable_rate_below_gate" : "",
    metrics.engineeringJargonLeakCount !== 0 ? "engineering_jargon_leak_present" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : "",
    metrics.p95LatencyMs > 5000 ? "p95_latency_above_gate" : "",
    metrics.maxLatencyMs > 10000 ? "max_latency_above_gate" : "",
    ...rows.filter((row) => row.quality === "fail" || row.quality === "source_missing").map((row) => `${row.id}:${row.residualOwner ?? "failed"}`)
  ].filter(Boolean);
  const report: UniversalInsightReportPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "universal_insight_report_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: namespace, scenarioCount: scenarios().length, fixtureCount: fixtures().length }
    }),
    namespaceId: namespace,
    passed: failures.length === 0,
    metrics,
    rows,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `universal-insight-report-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `universal-insight-report-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runUniversalInsightReportPackCli(): Promise<void> {
  const { report, output } = await runUniversalInsightReportPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
