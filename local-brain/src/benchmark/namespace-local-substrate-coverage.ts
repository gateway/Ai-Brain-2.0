import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import { readLoCoMoDataset } from "./compiled-direct-fact-real-source-coverage.js";
import { locomoOutputDir, parseArtifactArg, readLoCoMoArtifact, type LoCoMoDiagnosticResult } from "./locomo-diagnostics-utils.js";
import {
  promoteOfflineSubstrateForLoCoMoQuestions,
  type OfflineSubstratePromotionSummary
} from "./offline-substrate-promotion.js";

interface NamespaceLocalSubstrateCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "namespace_local_substrate_coverage";
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly targetRows: number;
  readonly namespaceSummaries: readonly OfflineSubstratePromotionSummary[];
  readonly summary: {
    readonly namespaceCount: number;
    readonly questionCount: number;
    readonly materializedRowsWritten: number;
    readonly materializedRowsUsable: number;
    readonly materializedRowsRejected: number;
    readonly eventRowsWritten: number;
    readonly eventRowsUsable: number;
    readonly eventRowsRejected: number;
    readonly rowsWithoutSourceQuote: number;
    readonly expectedAnswerPromotionUseRows: number;
    readonly missingSourceDerivedMetadataRows: number;
    readonly sourceIndependentRows: number;
    readonly mixedOwnerRows: number;
    readonly unknownFamilyRows: number;
    readonly identityMembershipInferredFromSupportRows: number;
    readonly queryTimeGLiNEROrLLMCalls: 0;
    readonly eventUsableRate: number;
  };
  readonly gates: {
    readonly namespaceRowsPresent: boolean;
    readonly eventCoveragePassed: boolean;
    readonly evidenceQuotePassed: boolean;
    readonly expectedAnswerLeakagePassed: boolean;
    readonly sourceDerivedMetadataPassed: boolean;
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

function toMarkdown(report: NamespaceLocalSubstrateCoverageReport): string {
  const lines = [
    "# Namespace-Local Substrate Coverage",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- targetRows: ${report.targetRows}`,
    `- namespaces: ${report.summary.namespaceCount}`,
    `- eventUsable: ${report.summary.eventRowsUsable}/${report.summary.eventRowsWritten}`,
    `- materializedUsable: ${report.summary.materializedRowsUsable}/${report.summary.materializedRowsWritten}`,
    `- rowsWithoutSourceQuote: ${report.summary.rowsWithoutSourceQuote}`,
    `- expectedAnswerPromotionUseRows: ${report.summary.expectedAnswerPromotionUseRows}`,
    `- missingSourceDerivedMetadataRows: ${report.summary.missingSourceDerivedMetadataRows}`,
    `- sourceIndependentRows: ${report.summary.sourceIndependentRows}`,
    `- mixedOwnerRows: ${report.summary.mixedOwnerRows}`,
    `- unknownFamilyRows: ${report.summary.unknownFamilyRows}`,
    `- identityMembershipInferredFromSupportRows: ${report.summary.identityMembershipInferredFromSupportRows}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    "",
    "## Namespaces",
    ""
  ];
  for (const namespaceSummary of report.namespaceSummaries) {
    lines.push(
      `- ${namespaceSummary.namespaceId}: sample=${namespaceSummary.sampleId} questions=${namespaceSummary.questionCount} materialized=${namespaceSummary.materializedRowsUsable}/${namespaceSummary.materializedRowsWritten} event=${namespaceSummary.eventRowsUsable}/${namespaceSummary.eventRowsWritten} withoutQuote=${namespaceSummary.rowsWithoutSourceQuote}`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeReport(report: NamespaceLocalSubstrateCoverageReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `namespace-local-substrate-coverage-${stamp}.json`);
  const markdownPath = path.join(dir, `namespace-local-substrate-coverage-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function runNamespaceLocalSubstrateCoverageBenchmark(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: NamespaceLocalSubstrateCoverageReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
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
    const namespaceId = namespaceIdFor(sourceGeneratedAt, sampleId);
    namespaceSummaries.push(
      await promoteOfflineSubstrateForLoCoMoQuestions({
        namespaceId,
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

  const summary = {
    namespaceCount: namespaceSummaries.length,
    questionCount: namespaceSummaries.reduce((sum, row) => sum + row.questionCount, 0),
    materializedRowsWritten: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsWritten, 0),
    materializedRowsUsable: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsUsable, 0),
    materializedRowsRejected: namespaceSummaries.reduce((sum, row) => sum + row.materializedRowsRejected, 0),
    eventRowsWritten: namespaceSummaries.reduce((sum, row) => sum + row.eventRowsWritten, 0),
    eventRowsUsable: namespaceSummaries.reduce((sum, row) => sum + row.eventRowsUsable, 0),
    eventRowsRejected: namespaceSummaries.reduce((sum, row) => sum + row.eventRowsRejected, 0),
    rowsWithoutSourceQuote: namespaceSummaries.reduce((sum, row) => sum + row.rowsWithoutSourceQuote, 0),
    expectedAnswerPromotionUseRows: namespaceSummaries.reduce((sum, row) => sum + row.expectedAnswerPromotionUseRows, 0),
    missingSourceDerivedMetadataRows: namespaceSummaries.reduce((sum, row) => sum + row.missingSourceDerivedMetadataRows, 0),
    sourceIndependentRows: namespaceSummaries.reduce((sum, row) => sum + row.sourceIndependentRows, 0),
    mixedOwnerRows: namespaceSummaries.reduce((sum, row) => sum + row.mixedOwnerRows, 0),
    unknownFamilyRows: namespaceSummaries.reduce((sum, row) => sum + row.unknownFamilyRows, 0),
    identityMembershipInferredFromSupportRows: namespaceSummaries.reduce((sum, row) => sum + row.identityMembershipInferredFromSupportRows, 0),
    queryTimeGLiNEROrLLMCalls: 0 as const,
    eventUsableRate: namespaceSummaries.reduce((sum, row) => sum + row.eventRowsWritten, 0) > 0
      ? round(namespaceSummaries.reduce((sum, row) => sum + row.eventRowsUsable, 0) / namespaceSummaries.reduce((sum, row) => sum + row.eventRowsWritten, 0))
      : 0
  };
  const gates = {
    namespaceRowsPresent: namespaceSummaries.length > 0 && summary.eventRowsWritten > 0,
    eventCoveragePassed: summary.eventRowsUsable >= 5,
    evidenceQuotePassed: summary.rowsWithoutSourceQuote === 0,
    expectedAnswerLeakagePassed: summary.expectedAnswerPromotionUseRows === 0,
    sourceDerivedMetadataPassed: summary.missingSourceDerivedMetadataRows === 0,
    mixedOwnerPassed: summary.mixedOwnerRows === 0,
    unknownFamilyPassed: summary.unknownFamilyRows === 0,
    identityInferencePassed: summary.identityMembershipInferredFromSupportRows === 0,
    queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
    overallPassed: false
  };
  const report: NamespaceLocalSubstrateCoverageReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "namespace_local_substrate_coverage",
    sourceArtifactPath: source.path,
    sourceGeneratedAt,
    targetRows: targetResults.length,
    namespaceSummaries,
    summary,
    gates: {
      ...gates,
      overallPassed:
        gates.namespaceRowsPresent &&
        gates.eventCoveragePassed &&
        gates.evidenceQuotePassed &&
        gates.expectedAnswerLeakagePassed &&
        gates.sourceDerivedMetadataPassed &&
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

export async function runNamespaceLocalSubstrateCoverageBenchmarkCli(): Promise<void> {
  try {
    const { report, output } = await runNamespaceLocalSubstrateCoverageBenchmark({ artifactPath: parseArtifactArg() });
    console.log(
      `namespace-local-substrate-coverage: event=${report.summary.eventRowsUsable}/${report.summary.eventRowsWritten} materialized=${report.summary.materializedRowsUsable}/${report.summary.materializedRowsWritten} passed=${report.gates.overallPassed}`
    );
    console.log(`namespace-local-substrate-coverage json=${output.jsonPath}`);
    console.log(`namespace-local-substrate-coverage markdown=${output.markdownPath}`);
    if (!report.gates.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
