import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LongMemEvalReport } from "./longmemeval.js";
import type { LoCoMoReport } from "./locomo.js";

export interface PublicBenchmarkReviewReport {
  readonly generatedAt: string;
  readonly datasetFiles: {
    readonly longMemEvalRawPath: string;
    readonly loCoMoRawPath: string;
  };
  readonly summaries: readonly {
    readonly benchmark: "longmemeval" | "locomo";
    readonly artifactPath: string;
    readonly benchmarkMode?: string;
    readonly fastScorerVersion?: string;
    readonly officialishScorerVersion?: string;
    readonly retrievalFusionVersion?: string;
    readonly rerankerVersion?: string;
    readonly relationIeSchemaVersion?: string;
    readonly sampleCount: number;
    readonly passRate: number;
    readonly passed: boolean;
    readonly diagnostics?: Record<string, unknown>;
    readonly misses: readonly {
      readonly id: string;
      readonly failureClass: string;
      readonly question: string;
      readonly expectedAnswer: string;
      readonly confidence: string | null;
      readonly sufficiency?: string | null;
      readonly subjectMatch?: string | null;
      readonly synthesisMode?: string | null;
      readonly globalQueryRouted?: boolean;
      readonly summaryRoutingUsed?: boolean;
      readonly evidenceCount: number;
      readonly sourceCount: number;
      readonly answerSnippet?: string;
    }[];
  }[];
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

function rawDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare", "raw");
}

async function latestArtifactPath(prefix: string): Promise<string> {
  const entries = await readdir(outputDir());
  const matches = entries
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".json"))
    .sort();
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(`No ${prefix} artifact found.`);
  }
  return path.join(outputDir(), latest);
}

function toMarkdown(report: PublicBenchmarkReviewReport): string {
  const lines = [
    "# Public Benchmark Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- longMemEvalRawPath: ${report.datasetFiles.longMemEvalRawPath}`,
    `- loCoMoRawPath: ${report.datasetFiles.loCoMoRawPath}`,
    ""
  ];

  for (const summary of report.summaries) {
    lines.push(`## ${summary.benchmark}`);
    lines.push("");
    lines.push(`- artifactPath: ${summary.artifactPath}`);
    lines.push(`- benchmarkMode: ${summary.benchmarkMode ?? "n/a"}`);
    lines.push(`- fastScorerVersion: ${summary.fastScorerVersion ?? "n/a"}`);
    lines.push(`- officialishScorerVersion: ${summary.officialishScorerVersion ?? "n/a"}`);
    lines.push(`- retrievalFusionVersion: ${summary.retrievalFusionVersion ?? "n/a"}`);
    lines.push(`- rerankerVersion: ${summary.rerankerVersion ?? "n/a"}`);
    lines.push(`- relationIeSchemaVersion: ${summary.relationIeSchemaVersion ?? "n/a"}`);
    lines.push(`- sampleCount: ${summary.sampleCount}`);
    lines.push(`- passRate: ${summary.passRate}`);
    lines.push(`- passed: ${summary.passed}`);
    if (summary.diagnostics) {
      lines.push(`- diagnostics: ${JSON.stringify(summary.diagnostics)}`);
    }
    lines.push("");
    lines.push("### Misses");
    lines.push("");
    for (const miss of summary.misses) {
      lines.push(`- ${miss.id} | class=${miss.failureClass} | confidence=${miss.confidence ?? "n/a"} | evidence=${miss.evidenceCount} | sources=${miss.sourceCount}`);
      lines.push(`  - sufficiency=${miss.sufficiency ?? "n/a"} | subjectMatch=${miss.subjectMatch ?? "n/a"} | synthesisMode=${miss.synthesisMode ?? "n/a"} | global=${miss.globalQueryRouted ? "yes" : "no"} | summaryRoute=${miss.summaryRoutingUsed ? "yes" : "no"}`);
      lines.push(`  - q: ${miss.question}`);
      lines.push(`  - expected: ${miss.expectedAnswer}`);
      if (miss.answerSnippet) {
        lines.push(`  - actual: ${miss.answerSnippet}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runAndWritePublicBenchmarkReview(): Promise<{
  readonly report: PublicBenchmarkReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const longMemEvalArtifact = await latestArtifactPath("longmemeval");
  const locomoArtifact = await latestArtifactPath("locomo");
  const longMemEval = JSON.parse(await readFile(longMemEvalArtifact, "utf8")) as LongMemEvalReport;
  const locomo = JSON.parse(await readFile(locomoArtifact, "utf8")) as LoCoMoReport;

  const report: PublicBenchmarkReviewReport = {
    generatedAt: new Date().toISOString(),
    datasetFiles: {
      longMemEvalRawPath: path.join(rawDir(), "longmemeval_s_cleaned.json"),
      loCoMoRawPath: path.join(rawDir(), "locomo10.json")
    },
    summaries: [
      {
        benchmark: "longmemeval",
        artifactPath: longMemEvalArtifact,
        benchmarkMode: longMemEval.runtime?.benchmarkMode,
        fastScorerVersion: longMemEval.runtime?.fastScorerVersion,
        officialishScorerVersion: longMemEval.runtime?.officialishScorerVersion,
        retrievalFusionVersion: longMemEval.runtime?.retrievalFusionVersion,
        rerankerVersion: longMemEval.runtime?.rerankerVersion,
        relationIeSchemaVersion: longMemEval.runtime?.relationIeSchemaVersion,
        sampleCount: longMemEval.sampleCount,
        passRate: longMemEval.passRate,
        passed: longMemEval.passed,
        diagnostics: longMemEval.diagnostics as Record<string, unknown> | undefined,
        misses: longMemEval.results
          .filter((result) => !result.passed)
          .map((result) => ({
            id: result.questionId,
            failureClass: result.failureClass,
            question: result.question,
            expectedAnswer: result.expectedAnswer,
            confidence: result.confidence,
            sufficiency: result.sufficiency,
            subjectMatch: result.subjectMatch,
            synthesisMode: result.synthesisMode,
            globalQueryRouted: result.globalQueryRouted,
            summaryRoutingUsed: result.summaryRoutingUsed,
            evidenceCount: result.evidenceCount,
            sourceCount: result.sourceCount,
            answerSnippet: result.answerSnippet
          }))
      },
      {
        benchmark: "locomo",
        artifactPath: locomoArtifact,
        benchmarkMode: locomo.runtime?.benchmarkMode,
        fastScorerVersion: locomo.runtime?.fastScorerVersion,
        officialishScorerVersion: locomo.runtime?.officialishScorerVersion,
        retrievalFusionVersion: locomo.runtime?.retrievalFusionVersion,
        rerankerVersion: locomo.runtime?.rerankerVersion,
        relationIeSchemaVersion: locomo.runtime?.relationIeSchemaVersion,
        sampleCount: locomo.sampleCount,
        passRate: locomo.passRate,
        passed: locomo.passed,
        diagnostics: locomo.diagnostics as Record<string, unknown> | undefined,
        misses: locomo.results
          .filter((result) => !result.passed)
          .map((result) => ({
            id: `${result.sampleId}#${result.questionIndex}`,
            failureClass: result.failureClass,
            question: result.question,
            expectedAnswer: result.expectedAnswer,
            confidence: result.confidence,
            sufficiency: result.sufficiency,
            subjectMatch: result.subjectMatch,
            synthesisMode: result.synthesisMode,
            globalQueryRouted: result.globalQueryRouted,
            summaryRoutingUsed: result.summaryRoutingUsed,
            evidenceCount: result.evidenceCount,
            sourceCount: result.sourceCount,
            answerSnippet: result.answerSnippet
          }))
      }
    ]
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `public-benchmark-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `public-benchmark-review-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runPublicBenchmarkReviewCli(): Promise<void> {
  const { output } = await runAndWritePublicBenchmarkReview();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
