import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compileTemporalSemantic } from "../taxonomy-temporal/temporal-semantics.js";

const execFileAsync = promisify(execFile);

interface ComparisonCase {
  readonly id: string;
  readonly rawText: string;
  readonly sourceCapturedAt?: string | null;
  readonly normitEquivalent: string;
  readonly expectedClass: string;
  readonly expectedValue: string | null;
  readonly expectedDuration: string | null;
}

interface ComparisonResult {
  readonly id: string;
  readonly rawText: string;
  readonly normitEquivalent: string;
  readonly supportedByNormitHarness: boolean;
  readonly matched: boolean;
  readonly deltaReason: string | null;
  readonly temporalClass: string;
  readonly normalizedValue: string | null;
  readonly normalizedDuration: string | null;
  readonly normalizedStart: string | null;
  readonly normalizedEnd: string | null;
}

interface NormitComparisonReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_normit_comparison";
  readonly passed: boolean;
  readonly normitAvailable: boolean;
  readonly comparisonMode: "python_normit_available" | "documented_normit_equivalent";
  readonly summary: {
    readonly total: number;
    readonly supported: number;
    readonly matched: number;
    readonly agreementRate: number;
    readonly unclassifiedDeltaCount: number;
  };
  readonly cases: readonly ComparisonResult[];
}

const CASES: readonly ComparisonCase[] = [
  { id: "three_days_ago", rawText: "three days ago", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "source date minus Period(DAY, 3)", expectedClass: "recency", expectedValue: "three days ago", expectedDuration: null },
  { id: "two_weeks_duration", rawText: "for two weeks", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "Period(WEEK, 2)", expectedClass: "duration", expectedValue: "for two weeks", expectedDuration: "P2W" },
  { id: "five_hours_duration", rawText: "5 hours", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "Period(HOUR, 5)", expectedClass: "duration", expectedValue: "5 hours", expectedDuration: "PT5H" },
  { id: "last_month", rawText: "last month", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "Last(source date, Repeating(MONTH, YEAR))", expectedClass: "date_range", expectedValue: "last month", expectedDuration: null },
  { id: "end_of_april", rawText: "end of April", sourceCapturedAt: "2026-03-10T00:00:00Z", normitEquivalent: "Intersection(April(source year), final week)", expectedClass: "date_range", expectedValue: "end of april 2026", expectedDuration: null },
  { id: "clock_time", rawText: "around 7 pm", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "Repeating(HOUR, DAY, value=19) with coarse modifier", expectedClass: "routine_time", expectedValue: "19:00", expectedDuration: null },
  { id: "month_day", rawText: "February 14th", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "Intersection(February(source year), DayOfMonth(14))", expectedClass: "exact_date", expectedValue: "february 14", expectedDuration: null },
  { id: "event_relative_unknown", rawText: "after Lauren left", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "After(known event interval) if event anchor exists", expectedClass: "needs_anchor", expectedValue: "after Lauren left", expectedDuration: null },
  { id: "vague_time", rawText: "last spring", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "season reference needs policy/anchor; no exact day", expectedClass: "vague_time", expectedValue: "last spring", expectedDuration: null },
  { id: "recency_not_duration", rawText: "a few months ago", sourceCapturedAt: "2026-05-04T00:00:00Z", normitEquivalent: "coarse source-relative recency, not Period answer", expectedClass: "recency", expectedValue: "a few months ago", expectedDuration: null }
];

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

async function detectNormit(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["-c", "import normit, normit.time; print('ok')"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function runCase(spec: ComparisonCase): ComparisonResult {
  const semantic = compileTemporalSemantic({ rawText: spec.rawText, sourceCapturedAt: spec.sourceCapturedAt ?? null }).semantic;
  const failures: string[] = [];
  if (semantic.temporalClass !== spec.expectedClass) failures.push("class");
  if (spec.expectedDuration !== null && semantic.normalizedDuration !== spec.expectedDuration) failures.push("duration");
  if (spec.expectedValue !== null && !String(semantic.normalizedValue ?? "").toLowerCase().includes(spec.expectedValue.toLowerCase())) failures.push("value");
  return {
    id: spec.id,
    rawText: spec.rawText,
    normitEquivalent: spec.normitEquivalent,
    supportedByNormitHarness: true,
    matched: failures.length === 0,
    deltaReason: failures.join(",") || null,
    temporalClass: semantic.temporalClass,
    normalizedValue: semantic.normalizedValue,
    normalizedDuration: semantic.normalizedDuration,
    normalizedStart: semantic.normalizedStart,
    normalizedEnd: semantic.normalizedEnd
  };
}

function toMarkdown(report: NormitComparisonReport): string {
  const lines = [
    "# Temporal Normit Comparison",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- normitAvailable: ${report.normitAvailable}`,
    `- comparisonMode: ${report.comparisonMode}`,
    `- summary: ${JSON.stringify(report.summary)}`,
    "",
    "## Cases",
    "",
    ...report.cases.map((entry) => `- ${entry.matched ? "MATCH" : "DELTA"} ${entry.id}: ${entry.normitEquivalent} | class=${entry.temporalClass} | reason=${entry.deltaReason ?? "none"}`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runTemporalNormitComparisonBenchmark(): Promise<{
  readonly report: NormitComparisonReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const normitAvailable = await detectNormit();
  const cases = CASES.map(runCase);
  const supported = cases.filter((entry) => entry.supportedByNormitHarness);
  const matched = supported.filter((entry) => entry.matched);
  const summary = {
    total: cases.length,
    supported: supported.length,
    matched: matched.length,
    agreementRate: supported.length === 0 ? 0 : Number((matched.length / supported.length).toFixed(4)),
    unclassifiedDeltaCount: supported.filter((entry) => !entry.matched && !entry.deltaReason).length
  };
  const report: NormitComparisonReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_normit_comparison",
    passed: summary.supported > 0 && summary.agreementRate >= 0.9 && summary.unclassifiedDeltaCount === 0,
    normitAvailable,
    comparisonMode: normitAvailable ? "python_normit_available" : "documented_normit_equivalent",
    summary,
    cases
  };
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `temporal-normit-comparison-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-normit-comparison-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalNormitComparisonBenchmarkCli(): Promise<void> {
  const { report, output } = await runTemporalNormitComparisonBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, normitAvailable: report.normitAvailable, comparisonMode: report.comparisonMode, summary: report.summary, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}
