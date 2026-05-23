import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runAndWriteMultiSourceIngestionPack, type MultiSourceIngestionPackReport } from "./multi-source-ingestion-pack.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface CleanReplayCertificationReport {
  readonly generatedAt: string;
  readonly benchmark: "clean_db_replay_certification";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly baselineArtifactPath: string;
  readonly replayArtifactPath: string;
  readonly metrics: {
    readonly cleanDbReplayPassRate: number;
    readonly projectionReplayParityRate: number;
    readonly cleanReplayAnswerParityRate: number;
    readonly sourceCapabilityParityRate: number;
    readonly queryTimeModelCalls: number;
  };
  readonly mismatches: readonly string[];
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

function comparableRows(report: MultiSourceIngestionPackReport): readonly string[] {
  return report.results.map((row) =>
    [
      row.id,
      row.passed,
      row.residualOwner,
      row.missingTerms.join("|"),
      row.missingSourceKinds.join("|"),
      row.forbiddenHits.join("|"),
      row.forbiddenSourceKindHits.join("|"),
      row.evidenceCount > 0,
      row.sourceTrailCount > 0,
      row.claimAuditCount > 0,
      row.actualSourceKinds.join("|")
    ].join("::")
  );
}

function parityRate(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const denominator = Math.max(left.length, right.length);
  let matched = 0;
  for (let index = 0; index < denominator; index += 1) {
    if (left[index] === right[index]) matched += 1;
  }
  return Number((matched / denominator).toFixed(4));
}

function compareReports(baseline: MultiSourceIngestionPackReport, replay: MultiSourceIngestionPackReport): readonly string[] {
  const mismatches: string[] = [];
  const baselineRows = comparableRows(baseline);
  const replayRows = comparableRows(replay);
  for (let index = 0; index < Math.max(baselineRows.length, replayRows.length); index += 1) {
    if (baselineRows[index] !== replayRows[index]) {
      mismatches.push(`row_${index}:${baselineRows[index] ?? "missing"} != ${replayRows[index] ?? "missing"}`);
    }
  }
  if (baseline.metrics.sourceKindCoverageCount !== replay.metrics.sourceKindCoverageCount) mismatches.push("source_kind_coverage_changed");
  if (baseline.metrics.sourceCapabilityCoverageRate !== replay.metrics.sourceCapabilityCoverageRate) mismatches.push("source_capability_coverage_changed");
  if (baseline.metrics.unsupportedSourceCapabilityCount !== replay.metrics.unsupportedSourceCapabilityCount) mismatches.push("unsupported_source_capability_changed");
  return mismatches;
}

function toMarkdown(report: CleanReplayCertificationReport): string {
  return [
    "# Clean DB Replay Certification",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- baselineArtifactPath: ${report.baselineArtifactPath}`,
    `- replayArtifactPath: ${report.replayArtifactPath}`,
    `- cleanDbReplayPassRate: ${report.metrics.cleanDbReplayPassRate}`,
    `- projectionReplayParityRate: ${report.metrics.projectionReplayParityRate}`,
    `- cleanReplayAnswerParityRate: ${report.metrics.cleanReplayAnswerParityRate}`,
    `- sourceCapabilityParityRate: ${report.metrics.sourceCapabilityParityRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Mismatches",
    "",
    ...report.mismatches.map((mismatch) => `- ${mismatch}`),
    ""
  ].join("\n");
}

export async function runAndWriteCleanDbReplayCertification(): Promise<{
  readonly report: CleanReplayCertificationReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const baseline = await runAndWriteMultiSourceIngestionPack();
  const replay = await runAndWriteMultiSourceIngestionPack();
  const mismatches = compareReports(baseline.report, replay.report);
  const answerParity = parityRate(comparableRows(baseline.report), comparableRows(replay.report));
  const sourceCapabilityParityRate =
    baseline.report.metrics.sourceCapabilityCoverageRate === replay.report.metrics.sourceCapabilityCoverageRate &&
    baseline.report.metrics.unsupportedSourceCapabilityCount === replay.report.metrics.unsupportedSourceCapabilityCount
      ? 1
      : 0;
  const queryTimeModelCalls = baseline.report.metrics.queryTimeModelCalls + replay.report.metrics.queryTimeModelCalls;
  const report: CleanReplayCertificationReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "clean_db_replay_certification",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        baselineNamespaceId: baseline.report.namespaceId,
        replayNamespaceId: replay.report.namespaceId
      }
    }),
    passed:
      baseline.report.passed &&
      replay.report.passed &&
      answerParity >= 0.98 &&
      sourceCapabilityParityRate === 1 &&
      queryTimeModelCalls === 0 &&
      mismatches.length === 0,
    baselineArtifactPath: baseline.output.jsonPath,
    replayArtifactPath: replay.output.jsonPath,
    metrics: {
      cleanDbReplayPassRate: baseline.report.passed && replay.report.passed ? 1 : 0,
      projectionReplayParityRate: answerParity,
      cleanReplayAnswerParityRate: answerParity,
      sourceCapabilityParityRate,
      queryTimeModelCalls
    },
    mismatches
  };
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `clean-db-replay-certification-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `clean-db-replay-certification-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCleanDbReplayCertificationCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteCleanDbReplayCertification();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}
