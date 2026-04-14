import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";
import { runAndWritePersonalOmiReview } from "./personal-omi-review.js";
import { runAndWritePersonalOpenClawReviewBenchmark } from "./personal-openclaw-review.js";

export interface PrivateTransferBaselineReport {
  readonly generatedAt: string;
  readonly suites: {
    readonly omiWatch: {
      readonly passed: boolean;
      readonly queryPassCount: number;
      readonly queryCount: number;
      readonly jsonPath: string;
      readonly markdownPath: string;
    };
    readonly personalOmi: {
      readonly pass: number;
      readonly warning: number;
      readonly fail: number;
      readonly jsonPath: string;
      readonly markdownPath: string;
    };
    readonly personalOpenClaw: {
      readonly pass: number;
      readonly fail: number;
      readonly jsonPath: string;
      readonly markdownPath: string;
    };
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

function toMarkdown(report: PrivateTransferBaselineReport): string {
  return [
    "# Private Transfer Baseline",
    "",
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## OMI Watch",
    "",
    `- passed: ${report.suites.omiWatch.passed}`,
    `- queryPassCount: ${report.suites.omiWatch.queryPassCount}/${report.suites.omiWatch.queryCount}`,
    `- jsonPath: ${report.suites.omiWatch.jsonPath}`,
    `- markdownPath: ${report.suites.omiWatch.markdownPath}`,
    "",
    "## Personal OMI",
    "",
    `- pass/warning/fail: ${report.suites.personalOmi.pass}/${report.suites.personalOmi.warning}/${report.suites.personalOmi.fail}`,
    `- jsonPath: ${report.suites.personalOmi.jsonPath}`,
    `- markdownPath: ${report.suites.personalOmi.markdownPath}`,
    "",
    "## Personal OpenClaw",
    "",
    `- pass/fail: ${report.suites.personalOpenClaw.pass}/${report.suites.personalOpenClaw.fail}`,
    `- jsonPath: ${report.suites.personalOpenClaw.jsonPath}`,
    `- markdownPath: ${report.suites.personalOpenClaw.markdownPath}`,
    ""
  ].join("\n");
}

export async function runAndWritePrivateTransferBaseline(): Promise<{
  readonly report: PrivateTransferBaselineReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  // These child suites all take the maintenance lock, so the transfer baseline
  // must run them sequentially to avoid turning the harness itself into the
  // bottleneck or a false failure source.
  const omiWatch = await runAndWriteOmiWatchSmokeBenchmark();
  const personalOmi = await runAndWritePersonalOmiReview();
  const personalOpenClaw = await runAndWritePersonalOpenClawReviewBenchmark();

  const report: PrivateTransferBaselineReport = {
    generatedAt,
    suites: {
      omiWatch: {
        passed: omiWatch.report.passed,
        queryPassCount: omiWatch.report.queries.filter((query) => query.passed).length,
        queryCount: omiWatch.report.queries.length,
        jsonPath: omiWatch.output.jsonPath,
        markdownPath: omiWatch.output.markdownPath
      },
      personalOmi: {
        pass: personalOmi.report.summary.pass,
        warning: personalOmi.report.summary.warning,
        fail: personalOmi.report.summary.fail,
        jsonPath: personalOmi.jsonPath,
        markdownPath: personalOmi.markdownPath
      },
      personalOpenClaw: {
        pass: personalOpenClaw.report.summary.pass,
        fail: personalOpenClaw.report.summary.fail,
        jsonPath: personalOpenClaw.output.jsonPath,
        markdownPath: personalOpenClaw.output.markdownPath
      }
    }
  };

  const stamp = generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `private-transfer-baseline-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `private-transfer-baseline-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return {
    report,
    output: { jsonPath, markdownPath }
  };
}

export async function runPrivateTransferBaselineCli(): Promise<void> {
  try {
    const result = await runAndWritePrivateTransferBaseline();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}
