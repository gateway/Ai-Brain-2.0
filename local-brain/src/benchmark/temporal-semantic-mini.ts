import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTemporalSemantic, type TemporalAnswerShape, type TemporalSemanticClass } from "../taxonomy-temporal/temporal-semantics.js";

interface TemporalSemanticCase {
  readonly id: string;
  readonly rawText: string;
  readonly sourceCapturedAt?: string | null;
  readonly knownEventAnchors?: readonly string[];
  readonly expectedClass: TemporalSemanticClass;
  readonly expectedAnswerable: readonly TemporalAnswerShape[];
  readonly expectedBlocked: readonly TemporalAnswerShape[];
  readonly expectedStatus?: string;
  readonly expectedRejectionReason?: string | null;
  readonly expectedDuration?: string | null;
  readonly expectedValue?: string | null;
}

interface TemporalSemanticCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly rawText: string;
  readonly temporalClass: string;
  readonly semanticStatus: string;
  readonly precision: string;
  readonly normalizedStart: string | null;
  readonly normalizedEnd: string | null;
  readonly normalizedDuration: string | null;
  readonly normalizedValue: string | null;
  readonly answerableShapes: readonly string[];
  readonly blockedShapes: readonly string[];
  readonly rejectionReason: string | null;
  readonly issueCodes: readonly string[];
}

interface TemporalSemanticMiniReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_semantic_mini";
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly unsupportedTemporalPrecisionUpgradeCount: number;
    readonly recencyDurationSwapCount: number;
    readonly vaguePromotionCount: number;
    readonly missingAnchorCount: number;
  };
  readonly cases: readonly TemporalSemanticCaseResult[];
}

const CASES: readonly TemporalSemanticCase[] = [
  { id: "iso_exact_date", rawText: "2026-02-14", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "2026-02-14" },
  { id: "animal_shelter_month_day", rawText: "February 14th", sourceCapturedAt: "2026-03-01T00:00:00Z", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "february 14" },
  { id: "month_year", rawText: "April 2026", expectedClass: "month_year", expectedAnswerable: ["when", "date_range"], expectedBlocked: ["duration", "recency"], expectedValue: "april 2026" },
  { id: "end_of_april", rawText: "end of April", sourceCapturedAt: "2026-04-10T00:00:00Z", expectedClass: "date_range", expectedAnswerable: ["when", "date_range"], expectedBlocked: ["duration", "recency"], expectedValue: "end of april 2026" },
  { id: "last_month", rawText: "last month", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "date_range", expectedAnswerable: ["when", "date_range"], expectedBlocked: ["duration", "recency"], expectedValue: "last month" },
  { id: "today", rawText: "today", sourceCapturedAt: "2026-05-04T09:00:00Z", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "today" },
  { id: "yesterday", rawText: "yesterday", sourceCapturedAt: "2026-05-04T09:00:00Z", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "yesterday" },
  { id: "three_days_ago", rawText: "three days ago", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedValue: "three days ago" },
  { id: "two_weeks_ago", rawText: "two weeks ago", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedValue: "two weeks ago" },
  { id: "few_months_ago", rawText: "a few months ago", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedValue: "a few months ago" },
  { id: "recency_missing_anchor", rawText: "three weeks ago", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedStatus: "rejected", expectedRejectionReason: "missing_source_date_anchor" },
  { id: "for_two_weeks", rawText: "for two weeks", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "P2W" },
  { id: "two_weeks_duration", rawText: "two weeks", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "P2W" },
  { id: "five_hours", rawText: "5 hours", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "PT5H" },
  { id: "two_hours_screen_time", rawText: "2 hours per day", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "PT2H" },
  { id: "thirty_minutes", rawText: "30 minutes", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "PT30M" },
  { id: "around_7_pm", rawText: "around 7 pm", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "19:00" },
  { id: "clock_exact", rawText: "7:30 am", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "07:30" },
  { id: "every_morning", rawText: "every morning", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "morning" },
  { id: "evening", rawText: "evening", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "evening" },
  { id: "after_lauren_left_known", rawText: "after Lauren left", knownEventAnchors: ["Lauren left"], expectedClass: "event_relative", expectedAnswerable: ["relative_order"], expectedBlocked: ["duration", "recency"], expectedValue: "after Lauren left" },
  { id: "after_lauren_left_unknown", rawText: "after Lauren left", expectedClass: "needs_anchor", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "missing_event_anchor" },
  { id: "before_the_meeting_unknown", rawText: "before the meeting", expectedClass: "needs_anchor", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "missing_event_anchor" },
  { id: "recently", rawText: "recently", expectedClass: "vague_time", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "vague_temporal_reference" },
  { id: "last_spring", rawText: "last spring", expectedClass: "vague_time", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "vague_temporal_reference" },
  { id: "when_i_was_younger", rawText: "when I was younger", expectedClass: "vague_time", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "vague_temporal_reference" },
  { id: "japan_recency_not_duration", rawText: "a few months ago", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedValue: "a few months ago" },
  { id: "japan_stay_duration", rawText: "for two weeks", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "P2W" },
  { id: "apartment_move_duration", rawText: "5 hours", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "PT5H" },
  { id: "instagram_per_day", rawText: "2 hours per day", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "PT2H" },
  { id: "end_april_trip", rawText: "end of April", sourceCapturedAt: "2026-03-27T00:00:00Z", expectedClass: "date_range", expectedAnswerable: ["when", "date_range"], expectedBlocked: ["duration", "recency"], expectedValue: "end of april 2026" },
  { id: "lauren_departure_exact", rawText: "2025-10-18", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "2025-10-18" },
  { id: "omi_today_recap", rawText: "today", sourceCapturedAt: "2026-03-28T09:43:07Z", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "today" },
  { id: "omi_yesterday_recap", rawText: "yesterday", sourceCapturedAt: "2026-03-28T09:43:07Z", expectedClass: "exact_date", expectedAnswerable: ["when"], expectedBlocked: ["duration", "recency"], expectedValue: "yesterday" },
  { id: "routine_every_day", rawText: "every day", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "day" },
  { id: "routine_night", rawText: "every night", expectedClass: "routine_time", expectedAnswerable: ["routine_time"], expectedBlocked: ["duration", "recency", "date_range"], expectedValue: "night" },
  { id: "one_year_ago", rawText: "one year ago", sourceCapturedAt: "2026-05-04T00:00:00Z", expectedClass: "recency", expectedAnswerable: ["when", "recency"], expectedBlocked: ["duration"], expectedValue: "one year ago" },
  { id: "three_month_duration", rawText: "three months", expectedClass: "duration", expectedAnswerable: ["duration"], expectedBlocked: ["when", "recency"], expectedDuration: "P3M" },
  { id: "event_relative_known_meeting", rawText: "before the meetup", knownEventAnchors: ["meetup"], expectedClass: "event_relative", expectedAnswerable: ["relative_order"], expectedBlocked: ["duration", "recency"], expectedValue: "before the meetup" },
  { id: "unsupported_temporal", rawText: "sometime around then", expectedClass: "vague_time", expectedAnswerable: [], expectedBlocked: ["when", "date_range", "duration", "recency", "routine_time"], expectedStatus: "rejected", expectedRejectionReason: "vague_temporal_reference" }
];

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function includesAll(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((value) => actual.includes(value));
}

function runCase(spec: TemporalSemanticCase): TemporalSemanticCaseResult {
  const result = compileTemporalSemantic({
    rawText: spec.rawText,
    sourceCapturedAt: spec.sourceCapturedAt ?? null,
    knownEventAnchors: spec.knownEventAnchors ?? [],
    candidateIndex: 0
  });
  const semantic = result.semantic;
  const failures: string[] = [];
  if (semantic.temporalClass !== spec.expectedClass) failures.push(`class:${semantic.temporalClass}`);
  if (!includesAll(semantic.answerableShapes, spec.expectedAnswerable)) failures.push("answerable_shapes");
  if (!includesAll(semantic.blockedShapes, spec.expectedBlocked)) failures.push("blocked_shapes");
  if (spec.expectedStatus && semantic.semanticStatus !== spec.expectedStatus) failures.push(`status:${semantic.semanticStatus}`);
  if (spec.expectedRejectionReason !== undefined && semantic.rejectionReason !== spec.expectedRejectionReason) failures.push(`rejection:${semantic.rejectionReason}`);
  if (spec.expectedDuration !== undefined && semantic.normalizedDuration !== spec.expectedDuration) failures.push(`duration:${semantic.normalizedDuration}`);
  if (spec.expectedValue && !String(semantic.normalizedValue ?? "").toLowerCase().includes(spec.expectedValue.toLowerCase())) failures.push(`value:${semantic.normalizedValue}`);
  if (semantic.temporalClass === "recency" && semantic.answerableShapes.includes("duration")) failures.push("recency_duration_swap");
  if (semantic.temporalClass === "duration" && semantic.answerableShapes.includes("when")) failures.push("duration_when_swap");
  if (semantic.temporalClass === "vague_time" && semantic.semanticStatus === "compiled") failures.push("vague_promoted");
  return {
    id: spec.id,
    passed: failures.length === 0,
    failures,
    rawText: spec.rawText,
    temporalClass: semantic.temporalClass,
    semanticStatus: semantic.semanticStatus,
    precision: semantic.precision,
    normalizedStart: semantic.normalizedStart,
    normalizedEnd: semantic.normalizedEnd,
    normalizedDuration: semantic.normalizedDuration,
    normalizedValue: semantic.normalizedValue,
    answerableShapes: semantic.answerableShapes,
    blockedShapes: semantic.blockedShapes,
    rejectionReason: semantic.rejectionReason,
    issueCodes: result.issues.map((issue) => issue.code)
  };
}

function toMarkdown(report: TemporalSemanticMiniReport): string {
  const lines = [
    "# Temporal Semantic Mini",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- summary: ${JSON.stringify(report.summary)}`,
    "",
    "## Cases",
    "",
    ...report.cases.map((entry) => `- ${entry.passed ? "PASS" : "FAIL"} ${entry.id}: class=${entry.temporalClass} status=${entry.semanticStatus} failures=${entry.failures.join(", ") || "none"}`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runTemporalSemanticMiniBenchmark(): Promise<{
  readonly report: TemporalSemanticMiniReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const cases = CASES.map(runCase);
  const summary = {
    total: cases.length,
    pass: cases.filter((entry) => entry.passed).length,
    fail: cases.filter((entry) => !entry.passed).length,
    unsupportedTemporalPrecisionUpgradeCount: cases.flatMap((entry) => entry.issueCodes).filter((code) => code === "unsupported_temporal_precision_upgrade").length,
    recencyDurationSwapCount: cases.filter((entry) => entry.failures.includes("recency_duration_swap") || entry.failures.includes("duration_when_swap")).length,
    vaguePromotionCount: cases.filter((entry) => entry.failures.includes("vague_promoted")).length,
    missingAnchorCount: cases.flatMap((entry) => entry.issueCodes).filter((code) => code === "missing_source_date_anchor" || code === "missing_event_anchor").length
  };
  const report: TemporalSemanticMiniReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_semantic_mini",
    passed:
      summary.total >= 40 &&
      summary.fail === 0 &&
      summary.unsupportedTemporalPrecisionUpgradeCount === 0 &&
      summary.recencyDurationSwapCount === 0 &&
      summary.vaguePromotionCount === 0,
    summary,
    cases
  };
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `temporal-semantic-mini-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-semantic-mini-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalSemanticMiniBenchmarkCli(): Promise<void> {
  const { report, output } = await runTemporalSemanticMiniBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, summary: report.summary, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}
