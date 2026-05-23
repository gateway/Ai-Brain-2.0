import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTaxonomyTemporalCompiler } from "../taxonomy-temporal/compiler.js";
import type { CompilerRunResult, ExtractionAssistantMode } from "../taxonomy-temporal/types.js";

interface MiniCase {
  readonly id: string;
  readonly sourceType: string;
  readonly capturedAt: string;
  readonly speaker: string;
  readonly text: string;
  readonly expectedEvidence: readonly string[];
  readonly expectedReviewOnlySuggestion?: boolean;
  readonly expectedClarification?: boolean;
}

interface MiniCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly unitCount: number;
  readonly gliner2Attempted: boolean;
  readonly gliner2Error: string | null;
  readonly llmProvider: string;
  readonly llmModel: string | null;
  readonly llmSkippedReason: string | null;
  readonly llmLatencyMs: number;
  readonly llmTokenUsage: Record<string, unknown> | null;
  readonly assistantValidationIssues: readonly string[];
  readonly tokenEfficiencyPass: boolean;
  readonly evidenceQualityPass: boolean;
  readonly chunkBudgetPass: boolean;
  readonly jsonValidityPass: boolean;
  readonly taxonomyCompliancePass: boolean;
  readonly temporalNormalizationPass: boolean;
  readonly promotionSafetyPass: boolean;
  readonly suggestedTaxonomyCount: number;
  readonly needsClarificationCount: number;
  readonly acceptedEvidenceQuotes: readonly string[];
  readonly candidateCount: number;
}

interface MiniReport {
  readonly generatedAt: string;
  readonly benchmark: "taxonomy_temporal_assistant_mini";
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly chunkBudgetPass: number;
    readonly jsonValidityPass: number;
    readonly taxonomyCompliancePass: number;
    readonly temporalNormalizationPass: number;
    readonly promotionSafetyPass: number;
    readonly suggestedTaxonomyCount: number;
    readonly needsClarificationCount: number;
    readonly llmCalledCount: number;
    readonly llmSkippedCount: number;
    readonly gliner2ErrorCount: number;
    readonly llmOffSmokePassed: boolean;
    readonly tokenEfficiencyPass: number;
    readonly evidenceQualityPass: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxTotalTokens: number;
  };
  readonly cases: readonly MiniCaseResult[];
}

const CASES: readonly MiniCase[] = [
  {
    id: "omi_self_current_state",
    sourceType: "omi_note",
    capturedAt: "2026-04-28T09:00:00Z",
    speaker: "self",
    text: "I switched my music service to Spotify and my home internet speed is 500 Mbps.",
    expectedEvidence: ["Spotify", "500 Mbps"]
  },
  {
    id: "chat_other_person_fact",
    sourceType: "chat",
    capturedAt: "2026-04-27T12:00:00Z",
    speaker: "friend",
    text: "Lauren said her dog is a Golden Retriever, not mine.",
    expectedEvidence: ["Golden Retriever"]
  },
  {
    id: "raw_task_list",
    sourceType: "task_list",
    capturedAt: "2026-04-26T08:00:00Z",
    speaker: "self",
    text: "Todo: update the roadmap, check the benchmark task list, and keep the priority notes tidy.",
    expectedEvidence: ["Todo", "task list"]
  },
  {
    id: "project_tool_substrate",
    sourceType: "raw_note",
    capturedAt: "2026-04-25T18:00:00Z",
    speaker: "self",
    text: "For the memoir engine, the knowledge graph needs Postgres, taxonomy, and a temporal registry.",
    expectedEvidence: ["memoir engine", "knowledge graph", "Postgres"]
  },
  {
    id: "health_adhd_claim",
    sourceType: "asr",
    capturedAt: "2026-04-24T10:00:00Z",
    speaker: "self",
    text: "I was diagnosed with ADHD and it affected how I handled school support.",
    expectedEvidence: ["ADHD"]
  },
  {
    id: "exact_date",
    sourceType: "document",
    capturedAt: "2026-04-23T00:00:00Z",
    speaker: "import",
    text: "The fundraiser dinner happened on 2026-02-14.",
    expectedEvidence: ["2026-02-14"]
  },
  {
    id: "relative_source_date",
    sourceType: "omi_note",
    capturedAt: "2026-05-01T00:00:00Z",
    speaker: "self",
    text: "I finished the first draft three weeks ago.",
    expectedEvidence: ["three weeks ago"]
  },
  {
    id: "event_relative_unresolved",
    sourceType: "asr",
    capturedAt: "2026-04-21T10:00:00Z",
    speaker: "self",
    text: "The move happened after Dad got sick, but I do not remember exactly when.",
    expectedEvidence: ["after Dad got sick"],
    expectedClarification: true
  },
  {
    id: "unknown_taxonomy_suggestion",
    sourceType: "raw_note",
    capturedAt: "2026-04-20T14:00:00Z",
    speaker: "self",
    text: "The triage rubric is becoming a recurring planning object, but it is not just a task.",
    expectedEvidence: ["triage rubric"],
    expectedReviewOnlySuggestion: true
  },
  {
    id: "longmem_exact_detail_cluster",
    sourceType: "benchmark",
    capturedAt: "2026-04-19T11:00:00Z",
    speaker: "self",
    text: "I bought the bookshelf from IKEA, stop checking work emails at 7 pm, and worked as a Marketing specialist for three months.",
    expectedEvidence: ["IKEA", "7 pm", "Marketing specialist", "three months"]
  }
];

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function acceptedEvidence(runs: readonly CompilerRunResult[]): readonly string[] {
  return runs.flatMap((run) =>
    run.candidates
      .filter(
        (entry) =>
          entry.promotionEligible ||
          entry.candidate.taxonomy_status === "needs_taxonomy_review" ||
          entry.candidate.promotion_recommendation === "needs_clarification"
      )
      .map((entry) => String(entry.candidate.evidence_quote ?? "").trim())
      .filter(Boolean)
  );
}

function tokenValue(tokenUsage: Record<string, unknown> | null, key: string): number {
  const value = tokenUsage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function evidenceQualityPass(evidenceQuotes: readonly string[], candidateCount: number): boolean {
  if (candidateCount > 6) {
    return false;
  }
  return evidenceQuotes.every((quote) => quote.length <= 160);
}

function caseResult(spec: MiniCase, runs: readonly CompilerRunResult[]): MiniCaseResult {
  const evidenceQuotes = acceptedEvidence(runs);
  const failures: string[] = [];
  const hasExpectedEvidence = spec.expectedEvidence.every((expected) =>
    evidenceQuotes.some((quote) => quote.toLowerCase().includes(expected.toLowerCase()))
  );
  const chunkBudgetPass = runs.every((run) => run.metrics.chunkBudgetPass);
  const jsonValidityPass = runs.every((run) => run.metrics.jsonValidityPass);
  const taxonomyCompliancePass = runs.every((run) => run.metrics.taxonomyCompliancePass);
  const temporalNormalizationPass = runs.every((run) => run.metrics.temporalNormalizationPass);
  const promotionSafetyPass = runs.every((run) => run.metrics.promotionSafetyPass);
  const suggestedTaxonomyCount = runs.reduce((sum, run) => sum + run.metrics.suggestedTaxonomyCount, 0);
  const needsClarificationCount = runs.reduce((sum, run) => sum + run.metrics.needsClarificationCount, 0);
  const gliner2Error = runs.find((run) => run.gliner2.error)?.gliner2.error ?? null;
  const firstAssistant = runs[0]?.assistant;
  const tokenEfficiencyPass = runs.every((run) => {
    const inputTokens = run.assistant.tokenUsage?.inputTokens ?? 0;
    const outputTokens = run.assistant.tokenUsage?.outputTokens ?? 0;
    return inputTokens <= 950 && outputTokens <= 450;
  });
  const evidencePass = evidenceQualityPass(evidenceQuotes, runs.reduce((sum, run) => sum + run.candidates.length, 0));

  if (!hasExpectedEvidence) {
    failures.push("expected_evidence_missing");
  }
  if (!chunkBudgetPass) {
    failures.push("chunk_budget_failed");
  }
  if (!jsonValidityPass) {
    failures.push("llm_json_invalid");
  }
  if (!taxonomyCompliancePass) {
    failures.push("taxonomy_compliance_failed");
  }
  if (!temporalNormalizationPass) {
    failures.push("temporal_normalization_failed");
  }
  if (!promotionSafetyPass) {
    failures.push("promotion_safety_failed");
  }
  if (spec.expectedReviewOnlySuggestion && suggestedTaxonomyCount < 1) {
    failures.push("expected_review_only_suggestion_missing");
  }
  if (spec.expectedClarification && needsClarificationCount < 1) {
    failures.push("expected_clarification_missing");
  }
  if (!tokenEfficiencyPass) {
    failures.push("token_efficiency_failed");
  }
  if (!evidencePass) {
    failures.push("evidence_quality_failed");
  }

  return {
    id: spec.id,
    passed: failures.length === 0,
    failures,
    unitCount: runs.length,
    gliner2Attempted: runs.some((run) => run.gliner2.attempted),
    gliner2Error,
    llmProvider: firstAssistant?.provider ?? "unknown",
    llmModel: firstAssistant?.model ?? null,
    llmSkippedReason: firstAssistant?.skippedReason ?? null,
    llmLatencyMs: firstAssistant?.latencyMs ?? 0,
    llmTokenUsage: firstAssistant?.tokenUsage ?? null,
    assistantValidationIssues: runs.flatMap((run) => run.assistant.validationIssues.map((issue) => issue.code)),
    tokenEfficiencyPass,
    evidenceQualityPass: evidencePass,
    chunkBudgetPass,
    jsonValidityPass,
    taxonomyCompliancePass,
    temporalNormalizationPass,
    promotionSafetyPass,
    suggestedTaxonomyCount,
    needsClarificationCount,
    acceptedEvidenceQuotes: evidenceQuotes,
    candidateCount: runs.reduce((sum, run) => sum + run.candidates.length, 0)
  };
}

async function runCase(spec: MiniCase, mode?: ExtractionAssistantMode): Promise<MiniCaseResult> {
  const runs = await runTaxonomyTemporalCompiler(
    {
      namespaceId: "benchmark_taxonomy_temporal_assistant_mini",
      sourceType: spec.sourceType,
      sourceId: spec.id,
      capturedAt: spec.capturedAt,
      speaker: spec.speaker,
      text: spec.text,
      metadata: {
        benchmark: "taxonomy_temporal_assistant_mini",
        case_id: spec.id
      }
    },
    { mode }
  );
  return caseResult(spec, runs);
}

function summarize(cases: readonly MiniCaseResult[], llmOffSmokePassed: boolean): MiniReport["summary"] {
  return {
    total: cases.length,
    pass: cases.filter((entry) => entry.passed).length,
    fail: cases.filter((entry) => !entry.passed).length,
    chunkBudgetPass: cases.filter((entry) => entry.chunkBudgetPass).length,
    jsonValidityPass: cases.filter((entry) => entry.jsonValidityPass).length,
    taxonomyCompliancePass: cases.filter((entry) => entry.taxonomyCompliancePass).length,
    temporalNormalizationPass: cases.filter((entry) => entry.temporalNormalizationPass).length,
    promotionSafetyPass: cases.filter((entry) => entry.promotionSafetyPass).length,
    suggestedTaxonomyCount: cases.reduce((sum, entry) => sum + entry.suggestedTaxonomyCount, 0),
    needsClarificationCount: cases.reduce((sum, entry) => sum + entry.needsClarificationCount, 0),
    llmCalledCount: cases.filter((entry) => !entry.llmSkippedReason && entry.llmProvider === "openrouter").length,
    llmSkippedCount: cases.filter((entry) => Boolean(entry.llmSkippedReason)).length,
    gliner2ErrorCount: cases.filter((entry) => Boolean(entry.gliner2Error)).length,
    llmOffSmokePassed,
    tokenEfficiencyPass: cases.filter((entry) => entry.tokenEfficiencyPass).length,
    evidenceQualityPass: cases.filter((entry) => entry.evidenceQualityPass).length,
    maxInputTokens: Math.max(0, ...cases.map((entry) => tokenValue(entry.llmTokenUsage, "inputTokens"))),
    maxOutputTokens: Math.max(0, ...cases.map((entry) => tokenValue(entry.llmTokenUsage, "outputTokens"))),
    maxTotalTokens: Math.max(0, ...cases.map((entry) => tokenValue(entry.llmTokenUsage, "totalTokens")))
  };
}

async function writeReport(report: MiniReport): Promise<string> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `taxonomy-temporal-assistant-mini-${stamp}.json`);
  const mdPath = path.join(dir, `taxonomy-temporal-assistant-mini-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Taxonomy Temporal Assistant Mini",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- summary: ${JSON.stringify(report.summary)}`,
    "",
    "## Cases",
    "",
    ...report.cases.map((entry) => `- ${entry.passed ? "PASS" : "FAIL"} ${entry.id}: ${entry.failures.join(", ") || "ok"}`)
  ];
  await writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");
  return jsonPath;
}

export async function runTaxonomyTemporalAssistantMiniBenchmark(options?: {
  readonly caseId?: string;
}): Promise<{ readonly report: MiniReport; readonly artifactPath: string }> {
  const results: MiniCaseResult[] = [];
  const selectedCases = options?.caseId ? CASES.filter((entry) => entry.id === options.caseId) : CASES;
  if (options?.caseId && selectedCases.length === 0) {
    throw new Error(`Unknown taxonomy temporal assistant mini case: ${options.caseId}`);
  }
  for (const spec of selectedCases) {
    results.push(await runCase(spec));
  }
  const llmOffSmoke = await runCase(CASES[0], "off");
  const llmOffSmokePassed = llmOffSmoke.passed && llmOffSmoke.llmSkippedReason === "assistant_off";
  const generatedAt = new Date().toISOString();
  const summary = summarize(results, llmOffSmokePassed);
  const report: MiniReport = {
    generatedAt,
    benchmark: "taxonomy_temporal_assistant_mini",
    passed:
      summary.fail === 0 &&
      summary.total === selectedCases.length &&
      summary.chunkBudgetPass === selectedCases.length &&
      summary.jsonValidityPass === selectedCases.length &&
      summary.taxonomyCompliancePass === selectedCases.length &&
      summary.temporalNormalizationPass === selectedCases.length &&
      summary.promotionSafetyPass === selectedCases.length &&
      summary.tokenEfficiencyPass === selectedCases.length &&
      summary.evidenceQualityPass === selectedCases.length &&
      summary.llmOffSmokePassed,
    summary,
    cases: results
  };
  const artifactPath = await writeReport(report);
  return { report, artifactPath };
}

export async function runTaxonomyTemporalAssistantMiniBenchmarkCli(): Promise<void> {
  const caseArg = process.argv.find((arg) => arg.startsWith("--case="));
  const caseId = caseArg?.slice("--case=".length);
  const { report, artifactPath } = await runTaxonomyTemporalAssistantMiniBenchmark({ caseId });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, summary: report.summary, artifactPath }, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}
