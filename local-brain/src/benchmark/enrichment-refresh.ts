import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAndWriteLongMemEvalBenchmark, type LongMemEvalReport } from "./longmemeval.js";
import { runAndWriteLoCoMoBenchmark, type LoCoMoReport } from "./locomo.js";
import { runAndWritePublicBenchmarkReview } from "./public-benchmark-review.js";
import { runAndWritePublicMemoryCompareBenchmark } from "./public-memory-compare.js";
import { runAndWritePublicMemoryMissRegressionsBenchmark } from "./public-memory-miss-regressions.js";
import { runAndWriteRelationBakeoffBenchmark, type RelationBakeoffReport } from "./relation-bakeoff.js";
import { runAndWriteSharedCausalReviewBenchmark } from "./shared-causal-review.js";

export interface EnrichmentRefreshReport {
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly artifacts: {
    readonly relationBakeoff: string;
    readonly publicMissRegressions: string;
    readonly longMemEval: string;
    readonly loCoMo: string;
    readonly publicReview: string;
    readonly publicCompare: string;
    readonly sharedCausalReview: string;
  };
  readonly deltas: {
    readonly longMemEvalPassRateDelta: number | null;
    readonly loCoMoPassRateDelta: number | null;
    readonly glinerRelexF1Delta: number | null;
  };
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

async function latestArtifactPath(prefix: string, excludePath?: string): Promise<string | null> {
  const entries = await readdir(outputDir());
  const matches = entries
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(outputDir(), entry))
    .filter((entry) => entry !== excludePath);
  return matches.at(-1) ?? null;
}

async function readOptionalJson<T>(artifactPath: string | null): Promise<T | null> {
  if (!artifactPath) {
    return null;
  }
  return JSON.parse(await readFile(artifactPath, "utf8")) as T;
}

function glinerF1(report: RelationBakeoffReport | null): number | null {
  if (!report) {
    return null;
  }
  const score = report.extractorScores.find((item) => item.extractor === "gliner_relex");
  return typeof score?.f1 === "number" ? score.f1 : null;
}

function delta(current: number, previous: number | null): number | null {
  if (previous === null || !Number.isFinite(previous)) {
    return null;
  }
  return Number((current - previous).toFixed(3));
}

function toMarkdown(report: EnrichmentRefreshReport): string {
  const lines = [
    "# Enrichment Refresh Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Artifacts",
    "",
    `- relationBakeoff: ${report.artifacts.relationBakeoff}`,
    `- publicMissRegressions: ${report.artifacts.publicMissRegressions}`,
    `- longMemEval: ${report.artifacts.longMemEval}`,
    `- loCoMo: ${report.artifacts.loCoMo}`,
    `- publicReview: ${report.artifacts.publicReview}`,
    `- publicCompare: ${report.artifacts.publicCompare}`,
    `- sharedCausalReview: ${report.artifacts.sharedCausalReview}`,
    "",
    "## Deltas",
    "",
    `- longMemEvalPassRateDelta: ${report.deltas.longMemEvalPassRateDelta ?? "n/a"}`,
    `- loCoMoPassRateDelta: ${report.deltas.loCoMoPassRateDelta ?? "n/a"}`,
    `- glinerRelexF1Delta: ${report.deltas.glinerRelexF1Delta ?? "n/a"}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteEnrichmentRefreshBenchmark(): Promise<{
  readonly report: EnrichmentRefreshReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const previousLongMemEval = await readOptionalJson<LongMemEvalReport>(await latestArtifactPath("longmemeval"));
  const previousLoCoMo = await readOptionalJson<LoCoMoReport>(await latestArtifactPath("locomo"));
  const previousRelationBakeoff = await readOptionalJson<RelationBakeoffReport>(await latestArtifactPath("relation-bakeoff"));

  const relationBakeoff = await runAndWriteRelationBakeoffBenchmark();
  const publicMissRegressions = await runAndWritePublicMemoryMissRegressionsBenchmark();
  const longMemEval = await runAndWriteLongMemEvalBenchmark();
  const loCoMo = await runAndWriteLoCoMoBenchmark();
  const publicReview = await runAndWritePublicBenchmarkReview();
  const publicCompare = await runAndWritePublicMemoryCompareBenchmark();
  const sharedCausalReview = await runAndWriteSharedCausalReviewBenchmark();

  const report: EnrichmentRefreshReport = {
    generatedAt: new Date().toISOString(),
    passed:
      relationBakeoff.report.passed &&
      publicMissRegressions.report.passed &&
      longMemEval.report.passed &&
      loCoMo.report.passed &&
      sharedCausalReview.report.summary.fail === 0 &&
      publicCompare.report.passed,
    artifacts: {
      relationBakeoff: relationBakeoff.output.jsonPath,
      publicMissRegressions: publicMissRegressions.output.jsonPath,
      longMemEval: longMemEval.output.jsonPath,
      loCoMo: loCoMo.output.jsonPath,
      publicReview: publicReview.output.jsonPath,
      publicCompare: publicCompare.output.jsonPath,
      sharedCausalReview: sharedCausalReview.output.jsonPath
    },
    deltas: {
      longMemEvalPassRateDelta: delta(longMemEval.report.passRate, previousLongMemEval?.passRate ?? null),
      loCoMoPassRateDelta: delta(loCoMo.report.passRate, previousLoCoMo?.passRate ?? null),
      glinerRelexF1Delta: delta(glinerF1(relationBakeoff.report) ?? 0, glinerF1(previousRelationBakeoff))
    }
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `enrichment-refresh-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `enrichment-refresh-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runEnrichmentRefreshBenchmarkCli(): Promise<void> {
  const { report, output } = await runAndWriteEnrichmentRefreshBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
}
