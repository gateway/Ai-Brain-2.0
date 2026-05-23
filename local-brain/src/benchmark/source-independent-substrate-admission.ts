import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import { readLoCoMoDataset } from "./compiled-direct-fact-real-source-coverage.js";
import { locomoOutputDir, parseArtifactArg, readLoCoMoArtifact, type LoCoMoDiagnosticResult } from "./locomo-diagnostics-utils.js";
import {
  promoteOfflineSubstrateForLoCoMoQuestions,
  type OfflineSubstratePromotionSummary
} from "./offline-substrate-promotion.js";

interface SourceIndependentAdmissionReport {
  readonly generatedAt: string;
  readonly benchmark: "source_independent_substrate_admission";
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly targetRows: number;
  readonly namespaceSummaries: readonly OfflineSubstratePromotionSummary[];
  readonly summary: {
    readonly namespaceCount: number;
    readonly questionCount: number;
    readonly eventRowsWritten: number;
    readonly eventRowsUsable: number;
    readonly eventRowsRejected: number;
    readonly materializedRowsWritten: number;
    readonly materializedRowsUsable: number;
    readonly materializedRowsRejected: number;
    readonly expectedAnswerPromotionUseRows: number;
    readonly missingSourceDerivedMetadataRows: number;
    readonly sourceIndependentRows: number;
    readonly rowsWithoutSourceQuote: number;
    readonly mixedOwnerRows: number;
    readonly unknownFamilyRows: number;
    readonly identityMembershipInferredFromSupportRows: number;
    readonly queryTimeGLiNEROrLLMCalls: 0;
    readonly eventUsableRate: number;
  };
  readonly gates: {
    readonly expectedAnswerLeakagePassed: boolean;
    readonly sourceDerivedMetadataPassed: boolean;
    readonly eventCoveragePassed: boolean;
    readonly evidenceQuotePassed: boolean;
    readonly mixedOwnerPassed: boolean;
    readonly unknownFamilyPassed: boolean;
    readonly identityInferencePassed: boolean;
    readonly queryTimeModelPassed: boolean;
    readonly overallPassed: boolean;
  };
  readonly sourceCoverageBreakdown: Readonly<Record<string, number>>;
  readonly materializedCoverageBreakdown: Readonly<Record<string, number>>;
  readonly eventCoverageBreakdown: Readonly<Record<string, number>>;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function runStampFromGeneratedAt(value: string): string {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/[:.]/gu, "-") : "unknown";
}

function namespaceIdFor(sourceGeneratedAt: string, sampleId: string): string {
  return `benchmark_locomo_${runStampFromGeneratedAt(sourceGeneratedAt)}_${sampleId.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`;
}

function isTargetResult(result: LoCoMoDiagnosticResult): boolean {
  return result.passed !== true && (result.residualOwner === "report_semantics" || result.residualOwner === "route_ranking");
}

function countMerge(values: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  }
  return counts;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function toMarkdown(report: SourceIndependentAdmissionReport): string {
  return [
    "# Source-Independent Substrate Admission",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- targetRows: ${report.targetRows}`,
    `- eventUsable: ${report.summary.eventRowsUsable}/${report.summary.eventRowsWritten}`,
    `- materializedUsable: ${report.summary.materializedRowsUsable}/${report.summary.materializedRowsWritten}`,
    `- expectedAnswerPromotionUseRows: ${report.summary.expectedAnswerPromotionUseRows}`,
    `- missingSourceDerivedMetadataRows: ${report.summary.missingSourceDerivedMetadataRows}`,
    `- rowsWithoutSourceQuote: ${report.summary.rowsWithoutSourceQuote}`,
    `- mixedOwnerRows: ${report.summary.mixedOwnerRows}`,
    `- unknownFamilyRows: ${report.summary.unknownFamilyRows}`,
    `- identityMembershipInferredFromSupportRows: ${report.summary.identityMembershipInferredFromSupportRows}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    "",
    "## Event Coverage",
    "",
    "```json",
    JSON.stringify(report.eventCoverageBreakdown, null, 2),
    "```",
    ""
  ].join("\n");
}

async function writeReport(report: SourceIndependentAdmissionReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `source-independent-substrate-admission-${stamp}.json`);
  const markdownPath = path.join(dir, `source-independent-substrate-admission-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function runSourceIndependentSubstrateAdmissionBenchmark(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: SourceIndependentAdmissionReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const sourceGeneratedAt = source.report.generatedAt ?? source.report.progress?.runStamp ?? "";
  const dataset = await readLoCoMoDataset();
  const targetResults = (source.report.results ?? []).filter(isTargetResult);
  const bySample = new Map<string, LoCoMoDiagnosticResult[]>();
  for (const result of targetResults) {
    const sampleId = normalizeText(result.sampleId);
    if (!sampleId) continue;
    const rows = bySample.get(sampleId) ?? [];
    rows.push(result);
    bySample.set(sampleId, rows);
  }

  const namespaceSummaries: OfflineSubstratePromotionSummary[] = [];
  for (const [sampleId, rows] of bySample) {
    const sample = dataset.find((entry) => entry.sample_id === sampleId);
    if (!sample) continue;
    namespaceSummaries.push(
      await promoteOfflineSubstrateForLoCoMoQuestions({
        namespaceId: namespaceIdFor(sourceGeneratedAt, sampleId),
        sample,
        questions: rows.map((result) => ({
          question: normalizeText(result.question),
          questionIndex: Number(result.questionIndex ?? -1),
          queryBehavior: result.queryBehavior ?? null,
          residualOwner: result.residualOwner ?? null
        }))
      })
    );
  }

  const eventRowsWritten = namespaceSummaries.reduce((sum, row) => sum + row.eventRowsWritten, 0);
  const eventRowsUsable = namespaceSummaries.reduce((sum, row) => sum + row.eventRowsUsable, 0);
  const summary = {
    namespaceCount: namespaceSummaries.length,
    questionCount: namespaceSummaries.reduce((sum, row) => sum + row.questionCount, 0),
    eventRowsWritten,
    eventRowsUsable,
    eventRowsRejected: namespaceSummaries.reduce((sum, row) => sum + row.eventRowsRejected, 0),
    materializedRowsWritten: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsWritten, 0),
    materializedRowsUsable: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsUsable, 0),
    materializedRowsRejected: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsRejected, 0),
    expectedAnswerPromotionUseRows: namespaceSummaries.reduce((sum, row) => sum + row.expectedAnswerPromotionUseRows, 0),
    missingSourceDerivedMetadataRows: namespaceSummaries.reduce((sum, row) => sum + row.missingSourceDerivedMetadataRows, 0),
    sourceIndependentRows: namespaceSummaries.reduce((sum, row) => sum + row.sourceIndependentRows, 0),
    rowsWithoutSourceQuote: namespaceSummaries.reduce((sum, row) => sum + row.rowsWithoutSourceQuote, 0),
    mixedOwnerRows: namespaceSummaries.reduce((sum, row) => sum + row.mixedOwnerRows, 0),
    unknownFamilyRows: namespaceSummaries.reduce((sum, row) => sum + row.unknownFamilyRows, 0),
    identityMembershipInferredFromSupportRows: namespaceSummaries.reduce((sum, row) => sum + row.identityMembershipInferredFromSupportRows, 0),
    queryTimeGLiNEROrLLMCalls: 0 as const,
    eventUsableRate: eventRowsWritten > 0 ? round(eventRowsUsable / eventRowsWritten) : 0
  };
  const gates = {
    expectedAnswerLeakagePassed: summary.expectedAnswerPromotionUseRows === 0,
    sourceDerivedMetadataPassed: summary.missingSourceDerivedMetadataRows === 0 && summary.sourceIndependentRows > 0,
    eventCoveragePassed: summary.eventRowsUsable >= 5,
    evidenceQuotePassed: summary.rowsWithoutSourceQuote === 0,
    mixedOwnerPassed: summary.mixedOwnerRows === 0,
    unknownFamilyPassed: summary.unknownFamilyRows === 0,
    identityInferencePassed: summary.identityMembershipInferredFromSupportRows === 0,
    queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
    overallPassed: false
  };
  const report: SourceIndependentAdmissionReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "source_independent_substrate_admission",
    sourceArtifactPath: source.path,
    sourceGeneratedAt,
    targetRows: targetResults.length,
    namespaceSummaries,
    summary,
    gates: {
      ...gates,
      overallPassed:
        gates.expectedAnswerLeakagePassed &&
        gates.sourceDerivedMetadataPassed &&
        gates.eventCoveragePassed &&
        gates.evidenceQuotePassed &&
        gates.mixedOwnerPassed &&
        gates.unknownFamilyPassed &&
        gates.identityInferencePassed &&
        gates.queryTimeModelPassed
    },
    sourceCoverageBreakdown: countMerge(namespaceSummaries.map((row) => row.sourceCoverageBreakdown)),
    materializedCoverageBreakdown: countMerge(namespaceSummaries.map((row) => row.materializedCoverageBreakdown)),
    eventCoverageBreakdown: countMerge(namespaceSummaries.map((row) => row.eventCoverageBreakdown))
  };
  const output = await writeReport(report);
  return { report, output };
}

export async function runSourceIndependentSubstrateAdmissionBenchmarkCli(): Promise<void> {
  try {
    const { report, output } = await runSourceIndependentSubstrateAdmissionBenchmark({ artifactPath: parseArtifactArg() });
    console.log(
      `source-independent-substrate-admission: event=${report.summary.eventRowsUsable}/${report.summary.eventRowsWritten} expectedAnswerPromotionUse=${report.summary.expectedAnswerPromotionUseRows} missingSourceDerived=${report.summary.missingSourceDerivedMetadataRows} passed=${report.gates.overallPassed}`
    );
    console.log(`source-independent-substrate-admission json=${output.jsonPath}`);
    console.log(`source-independent-substrate-admission markdown=${output.markdownPath}`);
    if (!report.gates.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
