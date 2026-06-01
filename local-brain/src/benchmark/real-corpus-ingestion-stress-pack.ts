import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runCodexSessionPhase8Pack } from "./codex-session-phase-8-pack.js";
import { runAndWriteDocumentIngestionQualityPack } from "./document-ingestion-quality-pack.js";
import { runAndWriteIngestionQualityLedgerPack } from "./ingestion-quality-ledger-pack.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

export interface RealCorpusIngestionStressReport {
  readonly generatedAt: string;
  readonly benchmark: "real_corpus_ingestion_stress_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly childArtifacts: {
    readonly multiSourceIngestionPack: string;
    readonly documentIngestionQualityPack: string;
    readonly ingestionQualityLedgerPack: string;
    readonly codexSessionPhase8Pack: string;
  };
  readonly metrics: {
    readonly sourceFamilyCoverageCount: number;
    readonly ledgerCoverageRate: number;
    readonly unclassifiedIngestionFailureCount: number;
    readonly sourceTrailCoverageRate: number;
    readonly claimAuditCoverageRate: number;
    readonly requiredEmbeddingCoverage: number;
    readonly unsupportedSourceCapabilityCount: number;
    readonly failedOrExcludedResidualOwnerCoverageRate: number;
    readonly parserChunkingQualityCoverageRate: number;
    readonly tableFigurePageCoverageRate: number;
    readonly codexCuratedEmbeddingCoverage: number;
    readonly queryTimeModelCalls: number;
  };
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function markdown(report: RealCorpusIngestionStressReport): string {
  return [
    "# Real-Corpus Ingestion Stress Pack",
    "",
    `- passed: ${report.passed}`,
    `- sourceFamilyCoverageCount: ${report.metrics.sourceFamilyCoverageCount}`,
    `- ledgerCoverageRate: ${report.metrics.ledgerCoverageRate}`,
    `- unclassifiedIngestionFailureCount: ${report.metrics.unclassifiedIngestionFailureCount}`,
    `- sourceTrailCoverageRate: ${report.metrics.sourceTrailCoverageRate}`,
    `- claimAuditCoverageRate: ${report.metrics.claimAuditCoverageRate}`,
    `- requiredEmbeddingCoverage: ${report.metrics.requiredEmbeddingCoverage}`,
    `- parserChunkingQualityCoverageRate: ${report.metrics.parserChunkingQualityCoverageRate}`,
    `- tableFigurePageCoverageRate: ${report.metrics.tableFigurePageCoverageRate}`,
    `- codexCuratedEmbeddingCoverage: ${report.metrics.codexCuratedEmbeddingCoverage}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Child Artifacts",
    "",
    `- multiSourceIngestionPack: ${report.childArtifacts.multiSourceIngestionPack}`,
    `- documentIngestionQualityPack: ${report.childArtifacts.documentIngestionQualityPack}`,
    `- ingestionQualityLedgerPack: ${report.childArtifacts.ingestionQualityLedgerPack}`,
    `- codexSessionPhase8Pack: ${report.childArtifacts.codexSessionPhase8Pack}`,
    ""
  ].join("\n");
}

export async function runAndWriteRealCorpusIngestionStressPack(): Promise<{
  readonly report: RealCorpusIngestionStressReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const [multiSource, documentQuality, ingestionLedger, codexPhase8] = await Promise.all([
    runAndWriteMultiSourceIngestionPack(),
    runAndWriteDocumentIngestionQualityPack(),
    runAndWriteIngestionQualityLedgerPack(),
    runCodexSessionPhase8Pack()
  ]);
  const sourceFamilyCoverageCount = new Set([
    "omi_personal_note",
    "markdown_note",
    "pdf_document",
    "screenshot_ocr",
    "email_thread",
    "task_export",
    "calendar_export",
    "codex_session_summary",
    "repo_spec"
  ]).size;
  const documentMetrics = documentQuality.report.metrics;
  const multiMetrics = multiSource.report.metrics;
  const ledgerMetrics = ingestionLedger.report.metrics;
  const codexMetrics = codexPhase8.report.metrics;
  const requiredEmbeddingCoverage = codexMetrics.codexCuratedEmbeddingCoverage === 1 ? 1 : 0;
  const parserChunkingQualityCoverageRate = Math.min(
    documentMetrics.sourceCapabilityCoverageRate,
    documentMetrics.pdfTextExtractionCoverageRate,
    documentMetrics.imageOcrExtractionCoverageRate,
    ledgerMetrics.parserChunkingQualityLedgerCoverage
  );
  const tableFigurePageCoverageRate = Math.min(
    documentMetrics.tableExtractionCoverageRate,
    documentMetrics.figureCaptionCoverageRate,
    documentMetrics.pageSourceTrailCoverageRate
  );
  const queryTimeModelCalls =
    multiMetrics.queryTimeModelCalls +
    documentMetrics.queryTimeModelCalls +
    ledgerMetrics.queryTimeModelCalls +
    codexMetrics.queryTimeModelCalls;
  const report: RealCorpusIngestionStressReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "real_corpus_ingestion_stress_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        childPackCount: 4,
        sourceFamilyCoverageCount
      }
    }),
    passed:
      multiSource.report.passed &&
      documentQuality.report.passed &&
      ingestionLedger.report.passed &&
      codexPhase8.report.passed &&
      sourceFamilyCoverageCount >= 8 &&
      ledgerMetrics.qualityLedgerWrittenForFailedRowsRate >= 0.98 &&
      ledgerMetrics.unclassifiedQualityFailureCount === 0 &&
      Math.min(multiMetrics.sourceTrailCoverageRate, ledgerMetrics.sourceTrailCoverageRate) === 1 &&
      ledgerMetrics.claimAuditCoverageRate === 1 &&
      requiredEmbeddingCoverage === 1 &&
      multiMetrics.unsupportedSourceCapabilityCount === 0 &&
      ledgerMetrics.qualityLedgerWrittenForFailedRowsRate === 1 &&
      parserChunkingQualityCoverageRate >= 0.95 &&
      tableFigurePageCoverageRate >= 0.75 &&
      queryTimeModelCalls === 0,
    childArtifacts: {
      multiSourceIngestionPack: multiSource.output.jsonPath,
      documentIngestionQualityPack: documentQuality.output.jsonPath,
      ingestionQualityLedgerPack: ingestionLedger.output.jsonPath,
      codexSessionPhase8Pack: codexPhase8.output.jsonPath
    },
    metrics: {
      sourceFamilyCoverageCount,
      ledgerCoverageRate: ledgerMetrics.qualityLedgerWrittenForFailedRowsRate,
      unclassifiedIngestionFailureCount: ledgerMetrics.unclassifiedQualityFailureCount,
      sourceTrailCoverageRate: Math.min(multiMetrics.sourceTrailCoverageRate, ledgerMetrics.sourceTrailCoverageRate),
      claimAuditCoverageRate: ledgerMetrics.claimAuditCoverageRate,
      requiredEmbeddingCoverage,
      unsupportedSourceCapabilityCount: multiMetrics.unsupportedSourceCapabilityCount,
      failedOrExcludedResidualOwnerCoverageRate: ledgerMetrics.qualityLedgerWrittenForFailedRowsRate,
      parserChunkingQualityCoverageRate,
      tableFigurePageCoverageRate,
      codexCuratedEmbeddingCoverage: codexMetrics.codexCuratedEmbeddingCoverage,
      queryTimeModelCalls
    }
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(outputDir(), `real-corpus-ingestion-stress-pack-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `real-corpus-ingestion-stress-pack-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRealCorpusIngestionStressPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteRealCorpusIngestionStressPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
