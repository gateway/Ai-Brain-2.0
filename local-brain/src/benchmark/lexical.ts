import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalEvaluation } from "../eval/runner.js";
import { closePool } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";

interface BenchmarkCase {
  readonly name: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly expectTopIncludes?: readonly string[];
  readonly expectZeroResults?: boolean;
  readonly maxApproxTokens?: number;
}

interface BenchmarkCaseResult {
  readonly name: string;
  readonly provider: "fts" | "bm25";
  readonly passed: boolean;
  readonly resultCount: number;
  readonly topMemoryType?: string;
  readonly topContent?: string;
  readonly approxTokens: number;
  readonly failureReasons: readonly string[];
}

export interface LexicalBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly baselineEvalPassed: boolean;
  readonly baselineEvalFailures: readonly string[];
  readonly cases: readonly BenchmarkCaseResult[];
  readonly summary: {
    readonly ftsPassed: number;
    readonly bm25Passed: number;
    readonly totalCases: number;
    readonly bm25TokenDelta: number;
    readonly recommendation: "keep_feature_gated" | "candidate_for_default";
    readonly reason: string;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultOutputDir(): string {
  return path.resolve(thisDir(), "../../benchmark-results");
}

function approxTokenCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    name: "japan_exact_temporal",
    query: "Japan 2025 Sarah",
    timeStart: "2025-01-01T00:00:00Z",
    timeEnd: "2025-12-31T23:59:59Z",
    expectTopIncludes: ["Japan", "Sarah", "2025"],
    maxApproxTokens: 120
  },
  {
    name: "spicy_active_truth",
    query: "spicy food",
    expectTopIncludes: ["spicy", "dislike"],
    maxApproxTokens: 120
  },
  {
    name: "sweet_active_truth",
    query: "sweet food",
    expectTopIncludes: ["sweet", "like"],
    maxApproxTokens: 120
  },
  {
    name: "abstention_unknown",
    query: "quantum pineapple architecture decision that was never mentioned",
    expectZeroResults: true,
    maxApproxTokens: 0
  }
];

async function runOne(
  provider: "fts" | "bm25",
  namespaceId: string,
  testCase: BenchmarkCase
): Promise<BenchmarkCaseResult> {
  const previous = process.env.BRAIN_LEXICAL_PROVIDER;
  process.env.BRAIN_LEXICAL_PROVIDER = provider;

  try {
    const response = await searchMemory({
      namespaceId,
      query: testCase.query,
      timeStart: testCase.timeStart,
      timeEnd: testCase.timeEnd,
      limit: 5
    });

    const top = response.results[0];
    const topContent = top?.content ?? "";
    const approxTokens = approxTokenCount(response.results.map((item) => item.content).join(" "));
    const failureReasons: string[] = [];

    if (testCase.expectZeroResults) {
      if (response.results.length !== 0) {
        failureReasons.push(`expected 0 results, got ${response.results.length}`);
      }
    } else {
      if (!top) {
        failureReasons.push("expected a top result");
      }

      for (const term of testCase.expectTopIncludes ?? []) {
        if (!topContent.toLowerCase().includes(term.toLowerCase())) {
          failureReasons.push(`top result missing term: ${term}`);
        }
      }
    }

    if (typeof testCase.maxApproxTokens === "number" && approxTokens > testCase.maxApproxTokens) {
      failureReasons.push(`approx tokens ${approxTokens} exceeded ${testCase.maxApproxTokens}`);
    }

    return {
      name: testCase.name,
      provider,
      passed: failureReasons.length === 0,
      resultCount: response.results.length,
      topMemoryType: top?.memoryType,
      topContent,
      approxTokens,
      failureReasons
    };
  } finally {
    if (previous === undefined) {
      delete process.env.BRAIN_LEXICAL_PROVIDER;
    } else {
      process.env.BRAIN_LEXICAL_PROVIDER = previous;
    }
  }
}

function compareCaseResults(report: readonly BenchmarkCaseResult[], provider: "fts" | "bm25"): number {
  return report.filter((item) => item.provider === provider && item.passed).length;
}

function tokenSum(report: readonly BenchmarkCaseResult[], provider: "fts" | "bm25"): number {
  return report
    .filter((item) => item.provider === provider)
    .map((item) => item.approxTokens)
    .reduce((sum, value) => sum + value, 0);
}

function toMarkdown(report: LexicalBenchmarkReport): string {
  const lines: string[] = [
    "# Lexical Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Baseline Eval Passed: ${report.baselineEvalPassed}`,
    "",
    "## Summary",
    "",
    `- FTS passed: ${report.summary.ftsPassed}/${report.summary.totalCases}`,
    `- BM25 passed: ${report.summary.bm25Passed}/${report.summary.totalCases}`,
    `- BM25 token delta: ${report.summary.bm25TokenDelta}`,
    `- Recommendation: ${report.summary.recommendation}`,
    `- Reason: ${report.summary.reason}`,
    "",
    "## Cases",
    ""
  ];

  for (const item of report.cases) {
    lines.push(`### ${item.name} (${item.provider})`);
    lines.push(`- Passed: ${item.passed}`);
    lines.push(`- Result count: ${item.resultCount}`);
    lines.push(`- Top memory type: ${item.topMemoryType ?? "n/a"}`);
    lines.push(`- Approx tokens: ${item.approxTokens}`);
    lines.push(`- Top content: ${item.topContent ?? ""}`);
    if (item.failureReasons.length > 0) {
      lines.push(`- Failures: ${item.failureReasons.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runLexicalBenchmark(): Promise<LexicalBenchmarkReport> {
  const baseline = await runLocalEvaluation();
  const baselineFailures = baseline.checks.filter((item) => !item.passed).map((item) => item.name);
  const generatedAt = new Date().toISOString();
  const cases: BenchmarkCaseResult[] = [];

  for (const testCase of BENCHMARK_CASES) {
    cases.push(await runOne("fts", baseline.namespaceId, testCase));
    cases.push(await runOne("bm25", baseline.namespaceId, testCase));
  }

  const ftsPassed = compareCaseResults(cases, "fts");
  const bm25Passed = compareCaseResults(cases, "bm25");
  const ftsTokens = tokenSum(cases, "fts");
  const bm25Tokens = tokenSum(cases, "bm25");
  const bm25TokenDelta = bm25Tokens - ftsTokens;
  const recommendation =
    baselineFailures.length === 0 && bm25Passed >= ftsPassed && bm25TokenDelta <= 0
      ? "candidate_for_default"
      : "keep_feature_gated";

  const reason =
    recommendation === "candidate_for_default"
      ? "BM25 matched or exceeded FTS on the current benchmark set without increasing token load."
      : "Keep BM25 behind a flag until it beats or matches FTS consistently on the benchmark set and baseline eval remains clean.";

  return {
    generatedAt,
    namespaceId: baseline.namespaceId,
    baselineEvalPassed: baselineFailures.length === 0,
    baselineEvalFailures: baselineFailures,
    cases,
    summary: {
      ftsPassed,
      bm25Passed,
      totalCases: BENCHMARK_CASES.length,
      bm25TokenDelta,
      recommendation,
      reason
    }
  };
}

export async function writeLexicalBenchmarkReport(report: LexicalBenchmarkReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const outputDir = defaultOutputDir();
  await mkdir(outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `lexical-benchmark-${stamp}.json`);
  const markdownPath = path.join(outputDir, `lexical-benchmark-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "latest.md"), toMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function runAndWriteLexicalBenchmark(): Promise<{
  readonly report: LexicalBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runLexicalBenchmark();
    const output = await writeLexicalBenchmarkReport(report);
    return { report, output };
  } finally {
    await closePool();
  }
}
