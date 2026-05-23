import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAndWriteLoCoMoBenchmark, type LoCoMoReport } from "./locomo.js";
import { runAndWritePublicMemoryMissRegressionsBenchmark } from "./public-memory-miss-regressions.js";

const OWNER_PACK_KEYS = [
  "conv-26#9",
  "conv-30#7",
  "conv-30#12",
  "conv-42#2",
  "conv-44#2",
  "conv-44#11",
  "conv-50#1",
  "conv-50#10"
] as const;

interface LoCoMoOwnerPackFailureRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly answerSnippet: string;
  readonly residualOwner: string;
  readonly finalClaimSource: string | null;
  readonly renderContract: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly subjectMatch: string | null;
  readonly sufficiency: string | null;
}

export interface LoCoMoOwnerPackReport {
  readonly generatedAt: string;
  readonly benchmark: "locomo_owner_pack";
  readonly locomoArtifactPath: string;
  readonly publicMissArtifactPath: string;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly ownerBreakdown: Readonly<Record<string, number>>;
  readonly routeRankingFailCount: number;
  readonly reportSemanticsFailCount: number;
  readonly sourceMissingCount: number;
  readonly unsupportedNoEvidenceSuccessCount: number;
  readonly unknownOwnerCount: number;
  readonly publicMissPassed: boolean;
  readonly failingRows: readonly LoCoMoOwnerPackFailureRow[];
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

async function withTemporaryEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function toMarkdown(report: LoCoMoOwnerPackReport): string {
  const lines = [
    "# LoCoMo Owner Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- locomoArtifactPath: ${report.locomoArtifactPath}`,
    `- publicMissArtifactPath: ${report.publicMissArtifactPath}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passRate: ${report.passRate}`,
    `- ownerBreakdown: ${JSON.stringify(report.ownerBreakdown)}`,
    `- routeRankingFailCount: ${report.routeRankingFailCount}`,
    `- reportSemanticsFailCount: ${report.reportSemanticsFailCount}`,
    `- sourceMissingCount: ${report.sourceMissingCount}`,
    `- unsupportedNoEvidenceSuccessCount: ${report.unsupportedNoEvidenceSuccessCount}`,
    `- unknownOwnerCount: ${report.unknownOwnerCount}`,
    `- publicMissPassed: ${report.publicMissPassed}`,
    `- passed: ${report.passed}`,
    "",
    "## Failing Rows",
    ""
  ];
  for (const row of report.failingRows) {
    lines.push(
      `- ${row.sampleId}#${row.questionIndex} owner=${row.residualOwner} final=${row.finalClaimSource ?? "n/a"} render=${row.renderContract ?? "n/a"} evidence=${row.evidenceCount}/${row.sourceCount}`
    );
    lines.push(`  - q: ${row.question}`);
    lines.push(`  - expected: ${row.expectedAnswer}`);
    lines.push(`  - answer: ${row.answerSnippet}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoOwnerPack(): Promise<{
  readonly report: LoCoMoOwnerPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const sampleIds = [...new Set(OWNER_PACK_KEYS.map((key) => key.split("#")[0] ?? "").filter(Boolean))];
  const locomoRun = await withTemporaryEnv(
    {
      BRAIN_LOCOMO_SAMPLE_IDS: sampleIds.join(","),
      BRAIN_LOCOMO_QUESTION_KEYS: OWNER_PACK_KEYS.join(","),
      BRAIN_LOCOMO_SAMPLE_QUESTIONS: "full",
      BRAIN_LOCOMO_STRATIFIED: "0",
      BRAIN_LOCOMO_SAMPLE_CONVERSATIONS: String(sampleIds.length)
    },
    async () => runAndWriteLoCoMoBenchmark()
  );
  const publicMissRun = await runAndWritePublicMemoryMissRegressionsBenchmark();
  const locomoReport: LoCoMoReport = locomoRun.report;
  const failingRows = locomoReport.results
    .filter((row) => row.passed !== true)
    .map(
      (row): LoCoMoOwnerPackFailureRow => ({
        sampleId: row.sampleId,
        questionIndex: row.questionIndex,
        question: row.question,
        expectedAnswer: row.expectedAnswer,
        answerSnippet: row.answerSnippet,
        residualOwner: row.residualOwner,
        finalClaimSource: row.finalClaimSource,
        renderContract: row.renderContract ?? null,
        evidenceCount: row.evidenceCount,
        sourceCount: row.sourceCount,
        subjectMatch: row.subjectMatch,
        sufficiency: row.sufficiency
      })
    );
  const ownerBreakdown = locomoReport.diagnostics.residualOwnerBreakdown ?? {};
  const routeRankingFailCount = ownerBreakdown.route_ranking ?? 0;
  const reportSemanticsFailCount = ownerBreakdown.report_semantics ?? 0;
  const sourceMissingCount = ownerBreakdown.source_missing ?? 0;
  const unsupportedNoEvidenceSuccessCount = locomoReport.diagnostics.unsupportedNoEvidenceSuccessCount ?? 0;
  const unknownOwnerCount = failingRows.filter((row) => !row.residualOwner || row.residualOwner === "unknown").length;
  const report: LoCoMoOwnerPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "locomo_owner_pack",
    locomoArtifactPath: locomoRun.output.jsonPath,
    publicMissArtifactPath: publicMissRun.output.jsonPath,
    sampleCount: locomoReport.sampleCount,
    passRate: locomoReport.passRate,
    ownerBreakdown,
    routeRankingFailCount,
    reportSemanticsFailCount,
    sourceMissingCount,
    unsupportedNoEvidenceSuccessCount,
    unknownOwnerCount,
    publicMissPassed: publicMissRun.report.passed,
    failingRows,
    passed:
      routeRankingFailCount === 0 &&
      reportSemanticsFailCount === 0 &&
      unknownOwnerCount === 0 &&
      unsupportedNoEvidenceSuccessCount === 0 &&
      locomoReport.passRate >= 0.95 &&
      publicMissRun.report.passed
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir(), `locomo-owner-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `locomo-owner-pack-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLoCoMoOwnerPackCli(): Promise<void> {
  const { output } = await runAndWriteLoCoMoOwnerPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
