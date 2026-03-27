import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoCoMoReport } from "./locomo.js";
import type { LongMemEvalReport } from "./longmemeval.js";

export interface PublicMemoryCompareReport {
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly benchmarks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly artifactPath: string;
    readonly passRate?: number;
    readonly benchmarkMode?: string;
    readonly retrievalFusionVersion?: string;
    readonly rerankerVersion?: string;
    readonly relationIeSchemaVersion?: string;
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

async function latestArtifactPath(prefix: string): Promise<string> {
  const entries = await readdir(outputDir());
  const matches = entries
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".json"))
    .sort();
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(`No ${prefix} benchmark artifact found. Run npm run benchmark:${prefix} first.`);
  }
  return path.join(outputDir(), latest);
}

function toMarkdown(report: PublicMemoryCompareReport): string {
  const lines = [
    "# Public Memory Compare Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Benchmarks",
    ""
  ];
  for (const benchmark of report.benchmarks) {
    lines.push(
      `- ${benchmark.name}: ${benchmark.passed ? "pass" : "fail"} | passRate=${benchmark.passRate ?? "n/a"} | mode=${benchmark.benchmarkMode ?? "n/a"} | reranker=${benchmark.rerankerVersion ?? "n/a"} | ${benchmark.artifactPath}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWritePublicMemoryCompareBenchmark(): Promise<{
  readonly report: PublicMemoryCompareReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const longMemEvalArtifact = await latestArtifactPath("longmemeval");
  const locomoArtifact = await latestArtifactPath("locomo");
  const longMemEval = JSON.parse(await readFile(longMemEvalArtifact, "utf8")) as LongMemEvalReport;
  const locomo = JSON.parse(await readFile(locomoArtifact, "utf8")) as LoCoMoReport;
  const report: PublicMemoryCompareReport = {
    generatedAt: new Date().toISOString(),
    passed: longMemEval.passed && locomo.passed,
    benchmarks: [
      {
        name: "longmemeval",
        passed: longMemEval.passed,
        artifactPath: longMemEvalArtifact,
        passRate: longMemEval.passRate,
        benchmarkMode: longMemEval.runtime?.benchmarkMode,
        retrievalFusionVersion: longMemEval.runtime?.retrievalFusionVersion,
        rerankerVersion: longMemEval.runtime?.rerankerVersion,
        relationIeSchemaVersion: longMemEval.runtime?.relationIeSchemaVersion
      },
      {
        name: "locomo",
        passed: locomo.passed,
        artifactPath: locomoArtifact,
        passRate: locomo.passRate,
        benchmarkMode: locomo.runtime?.benchmarkMode,
        retrievalFusionVersion: locomo.runtime?.retrievalFusionVersion,
        rerankerVersion: locomo.runtime?.rerankerVersion,
        relationIeSchemaVersion: locomo.runtime?.relationIeSchemaVersion
      }
    ]
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `public-memory-compare-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `public-memory-compare-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runPublicMemoryCompareBenchmarkCli(): Promise<void> {
  const { output } = await runAndWritePublicMemoryCompareBenchmark();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
