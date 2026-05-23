import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAndWriteLongMemEvalBenchmark, type LongMemEvalReport } from "./longmemeval.js";

interface LongMemWarmProofRunSummary {
  readonly label: "baseline" | "same_process_warm" | "fresh_process_warm";
  readonly generatedAt: string;
  readonly artifactJsonPath: string;
  readonly artifactMarkdownPath: string;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly manifestHitRate: number;
  readonly sessionManifestHitRate: number;
  readonly warmSnapshotHitRate: number;
  readonly coldRebuildCount: number;
  readonly staleManifestMismatchCount: number;
  readonly answerParityMismatchCount: number;
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly manifestDecisionBreakdown: Readonly<Record<string, number>>;
  readonly snapshotDecisionBreakdown: Readonly<Record<string, number>>;
  readonly parityStatusBreakdown: Readonly<Record<string, number>>;
  readonly passed: boolean;
}

interface LongMemWarmProofParityMismatch {
  readonly questionId: string;
  readonly baselinePassed: boolean;
  readonly rerunPassed: boolean;
  readonly baselineAnswerSnippet: string;
  readonly rerunAnswerSnippet: string;
}

export interface LongMemWarmProofReport {
  readonly generatedAt: string;
  readonly benchmark: "longmem_warm_proof";
  readonly baseline: LongMemWarmProofRunSummary;
  readonly sameProcessWarm: LongMemWarmProofRunSummary;
  readonly freshProcessWarm: LongMemWarmProofRunSummary;
  readonly sameProcessParityMismatchCount: number;
  readonly freshProcessParityMismatchCount: number;
  readonly sameProcessParityMismatches: readonly LongMemWarmProofParityMismatch[];
  readonly freshProcessParityMismatches: readonly LongMemWarmProofParityMismatch[];
  readonly passed: boolean;
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

function benchmarkCliPath(): string {
  return path.resolve(localBrainRoot(), "dist/cli/benchmark-longmemeval.js");
}

function summarizeRun(label: LongMemWarmProofRunSummary["label"], report: LongMemEvalReport, artifactJsonPath: string, artifactMarkdownPath: string): LongMemWarmProofRunSummary {
  return {
    label,
    generatedAt: report.generatedAt,
    artifactJsonPath,
    artifactMarkdownPath,
    sampleCount: report.sampleCount,
    passRate: report.passRate,
    manifestHitRate: report.productionReadiness.cache.manifestHitRate,
    sessionManifestHitRate: report.productionReadiness.cache.sessionManifestHitRate ?? 0,
    warmSnapshotHitRate: report.productionReadiness.cache.warmSnapshotHitRate,
    coldRebuildCount: report.productionReadiness.cache.coldRebuildCount,
    staleManifestMismatchCount: report.productionReadiness.cache.staleManifestMismatchCount ?? 0,
    answerParityMismatchCount: report.productionReadiness.cache.answerParityMismatchCount ?? 0,
    latency: report.latency,
    manifestDecisionBreakdown: report.productionReadiness.cache.manifestDecisionBreakdown ?? {},
    snapshotDecisionBreakdown: report.productionReadiness.cache.snapshotDecisionBreakdown ?? {},
    parityStatusBreakdown: report.productionReadiness.cache.parityStatusBreakdown ?? {},
    passed: report.passed
  };
}

export function isLongMemAnswerQualityGreen(run: LongMemWarmProofRunSummary): boolean {
  return (
    run.passRate === 1 &&
    run.latency.p95Ms <= 5000 &&
    run.latency.maxMs <= 6000 &&
    run.staleManifestMismatchCount === 0 &&
    run.answerParityMismatchCount === 0
  );
}

export function isLongMemWarmReuseGreen(run: LongMemWarmProofRunSummary): boolean {
  return (
    isLongMemAnswerQualityGreen(run) &&
    run.manifestHitRate === 1 &&
    run.sessionManifestHitRate === 1 &&
    run.warmSnapshotHitRate === 1 &&
    run.coldRebuildCount === 0
  );
}

function compareRunParity(baseline: LongMemEvalReport, rerun: LongMemEvalReport): readonly LongMemWarmProofParityMismatch[] {
  const rerunByQuestionId = new Map(rerun.results.map((result) => [result.questionId, result]));
  const mismatches: LongMemWarmProofParityMismatch[] = [];
  for (const base of baseline.results) {
    const next = rerunByQuestionId.get(base.questionId);
    if (!next) {
      mismatches.push({
        questionId: base.questionId,
        baselinePassed: base.passed,
        rerunPassed: false,
        baselineAnswerSnippet: base.answerSnippet,
        rerunAnswerSnippet: ""
      });
      continue;
    }
    if (base.passed !== next.passed || base.answerSnippet !== next.answerSnippet) {
      mismatches.push({
        questionId: base.questionId,
        baselinePassed: base.passed,
        rerunPassed: next.passed,
        baselineAnswerSnippet: base.answerSnippet,
        rerunAnswerSnippet: next.answerSnippet
      });
    }
  }
  return mismatches;
}

export function isLongMemWarmProofPassed(params: {
  readonly baseline: LongMemWarmProofRunSummary;
  readonly sameProcessWarm: LongMemWarmProofRunSummary;
  readonly freshProcessWarm: LongMemWarmProofRunSummary;
  readonly sameProcessParityMismatchCount: number;
  readonly freshProcessParityMismatchCount: number;
}): boolean {
  return (
    isLongMemAnswerQualityGreen(params.baseline) &&
    isLongMemWarmReuseGreen(params.sameProcessWarm) &&
    isLongMemWarmReuseGreen(params.freshProcessWarm) &&
    params.sameProcessParityMismatchCount === 0 &&
    params.freshProcessParityMismatchCount === 0
  );
}

async function runFreshProcessLongMemEval(): Promise<{ readonly report: LongMemEvalReport; readonly jsonPath: string; readonly markdownPath: string }> {
  const cliPath = benchmarkCliPath();
  const env = {
    ...process.env
  };
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: localBrainRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`fresh LongMemEval process failed with exit code ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonPath = lines.find((line) => line.endsWith(".json"));
  const markdownPath = lines.find((line) => line.endsWith(".md"));
  if (!jsonPath || !markdownPath) {
    throw new Error(`fresh LongMemEval process did not return artifact paths: ${output}`);
  }
  const report = JSON.parse(await readFile(jsonPath, "utf8")) as LongMemEvalReport;
  return { report, jsonPath, markdownPath };
}

function toMarkdown(report: LongMemWarmProofReport): string {
  const lines = [
    "# LongMem Warm Proof",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- sameProcessParityMismatchCount: ${report.sameProcessParityMismatchCount}`,
    `- freshProcessParityMismatchCount: ${report.freshProcessParityMismatchCount}`,
    "",
    "## Runs",
    ""
  ];
  for (const run of [report.baseline, report.sameProcessWarm, report.freshProcessWarm]) {
    lines.push(`### ${run.label}`, "");
    lines.push(`- sampleCount: ${run.sampleCount}`);
    lines.push(`- passRate: ${run.passRate}`);
    lines.push(`- manifestHitRate: ${run.manifestHitRate}`);
    lines.push(`- sessionManifestHitRate: ${run.sessionManifestHitRate}`);
    lines.push(`- warmSnapshotHitRate: ${run.warmSnapshotHitRate}`);
    lines.push(`- coldRebuildCount: ${run.coldRebuildCount}`);
    lines.push(`- staleManifestMismatchCount: ${run.staleManifestMismatchCount}`);
    lines.push(`- answerParityMismatchCount: ${run.answerParityMismatchCount}`);
    lines.push(`- latency: ${JSON.stringify(run.latency)}`);
    lines.push(`- manifestDecisionBreakdown: ${JSON.stringify(run.manifestDecisionBreakdown)}`);
    lines.push(`- snapshotDecisionBreakdown: ${JSON.stringify(run.snapshotDecisionBreakdown)}`);
    lines.push(`- parityStatusBreakdown: ${JSON.stringify(run.parityStatusBreakdown)}`);
    lines.push(`- artifactJsonPath: ${run.artifactJsonPath}`);
    lines.push(`- artifactMarkdownPath: ${run.artifactMarkdownPath}`);
    lines.push("");
  }
  if (report.sameProcessParityMismatches.length > 0 || report.freshProcessParityMismatches.length > 0) {
    lines.push("## Parity Mismatches", "");
    for (const [label, mismatches] of [
      ["same_process_warm", report.sameProcessParityMismatches],
      ["fresh_process_warm", report.freshProcessParityMismatches]
    ] as const) {
      if (mismatches.length === 0) {
        continue;
      }
      lines.push(`### ${label}`, "");
      for (const mismatch of mismatches) {
        lines.push(`- ${mismatch.questionId}: baselinePassed=${mismatch.baselinePassed} rerunPassed=${mismatch.rerunPassed}`);
        lines.push(`  - baseline: ${mismatch.baselineAnswerSnippet}`);
        lines.push(`  - rerun: ${mismatch.rerunAnswerSnippet}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLongMemWarmProof(): Promise<{
  readonly report: LongMemWarmProofReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const baseline = await runAndWriteLongMemEvalBenchmark();
  const sameProcessWarm = await runAndWriteLongMemEvalBenchmark();
  const freshProcessWarm = await runFreshProcessLongMemEval();
  const sameProcessParityMismatches = compareRunParity(baseline.report, sameProcessWarm.report);
  const freshProcessParityMismatches = compareRunParity(baseline.report, freshProcessWarm.report);
  const baselineSummary = summarizeRun("baseline", baseline.report, baseline.output.jsonPath, baseline.output.markdownPath);
  const sameProcessWarmSummary = summarizeRun(
    "same_process_warm",
    sameProcessWarm.report,
    sameProcessWarm.output.jsonPath,
    sameProcessWarm.output.markdownPath
  );
  const freshProcessWarmSummary = summarizeRun("fresh_process_warm", freshProcessWarm.report, freshProcessWarm.jsonPath, freshProcessWarm.markdownPath);
  const report: LongMemWarmProofReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "longmem_warm_proof",
    baseline: baselineSummary,
    sameProcessWarm: sameProcessWarmSummary,
    freshProcessWarm: freshProcessWarmSummary,
    sameProcessParityMismatchCount: sameProcessParityMismatches.length,
    freshProcessParityMismatchCount: freshProcessParityMismatches.length,
    sameProcessParityMismatches,
    freshProcessParityMismatches,
    passed: isLongMemWarmProofPassed({
      baseline: baselineSummary,
      sameProcessWarm: sameProcessWarmSummary,
      freshProcessWarm: freshProcessWarmSummary,
      sameProcessParityMismatchCount: sameProcessParityMismatches.length,
      freshProcessParityMismatchCount: freshProcessParityMismatches.length
    })
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir(), `longmem-warm-proof-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `longmem-warm-proof-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLongMemWarmProofCli(): Promise<void> {
  const { output } = await runAndWriteLongMemWarmProof();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
