import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarDocumentExtractionProvider } from "../artifacts/document-extraction.js";
import { buildIngestionRouterV2Packet } from "../ingest/router-v2.js";
import type { SourceType } from "../types.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { rate } from "./query-benchmark-utils.js";

interface DocumentFixture {
  readonly id: string;
  readonly relativePath: string;
  readonly sourceType: SourceType;
  readonly body: string;
  readonly extractedText: string;
  readonly expectedTerms: readonly string[];
  readonly expectedCapabilityKind: string;
  readonly expectsTable: boolean;
  readonly expectsFigure: boolean;
  readonly expectsPage: boolean;
}

interface Row {
  readonly id: string;
  readonly sourceType: SourceType;
  readonly capabilityKind: string;
  readonly providerName: string | null;
  readonly hasExtractedText: boolean;
  readonly pageCount: number;
  readonly tableCount: number;
  readonly figureCount: number;
  readonly ocrBlockCount: number;
  readonly sourceCapabilityUnsupported: readonly string[];
  readonly missingTerms: readonly string[];
  readonly passed: boolean;
  readonly residualOwner:
    | "none"
    | "provider_extraction_missing"
    | "capability_kind_wrong"
    | "page_provenance_missing"
    | "table_missing"
    | "figure_missing"
    | "missing_terms"
    | "unsupported_capability";
}

export interface DocumentIngestionQualityReport {
  readonly generatedAt: string;
  readonly benchmark: "document_ingestion_quality_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly sourceCapabilityCoverageRate: number;
    readonly pdfTextExtractionCoverageRate: number;
    readonly imageOcrExtractionCoverageRate: number;
    readonly tableExtractionCoverageRate: number;
    readonly figureCaptionCoverageRate: number;
    readonly pageSourceTrailCoverageRate: number;
    readonly documentQuestionPassRate: number;
    readonly documentUnsupportedSilentSuccessCount: number;
    readonly queryTimeModelCalls: 0;
  };
  readonly results: readonly Row[];
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

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "document-ingestion-quality-pack");
}

function fixtures(): readonly DocumentFixture[] {
  return [
    {
      id: "pdf_tables_figures",
      relativePath: "pdfs/agent-memory-layout.pdf",
      sourceType: "pdf",
      body: "%PDF-1.4\n% placeholder; provider sidecar owns benchmark text\n",
      extractedText: [
        "--- page 1 ---",
        "Agent memory layout report. The document says production RAG needs source capability profiles and hierarchical chunking.",
        "Table 1 | Source Type | Required Provenance | PDF | page and block provenance | Screenshot | OCR block provenance |",
        "--- page 2 ---",
        "Figure 2: A retrieval pipeline diagram shows metadata filtering before vector recall and reranking.",
        "The conclusion says document retrieval quality gates must cover tables, figures, and page trails."
      ].join("\n"),
      expectedTerms: ["source capability profiles", "hierarchical chunking", "metadata filtering", "page trails"],
      expectedCapabilityKind: "pdf_document",
      expectsTable: true,
      expectsFigure: true,
      expectsPage: true
    },
    {
      id: "screenshot_ocr",
      relativePath: "images/task-whiteboard.png",
      sourceType: "image",
      body: "PNG placeholder; OCR text is sidecar-owned.\n",
      extractedText: [
        "Screenshot OCR block: Sub-8 production lift.",
        "Tasks: add source capability profiles, test screenshot OCR, verify no silent unsupported binary ingest.",
        "The whiteboard includes a document retrieval quality gate."
      ].join("\n"),
      expectedTerms: ["screenshot OCR", "source capability profiles", "no silent unsupported binary ingest"],
      expectedCapabilityKind: "image_ocr",
      expectsTable: false,
      expectsFigure: false,
      expectsPage: false
    },
    {
      id: "email_thread_document",
      relativePath: "threads/ingestion-thread.txt",
      sourceType: "text",
      body: [
        "From: Steve",
        "Subject: Ingestion pilot",
        "We should test email-like threads, task exports, calendar exports, PDFs, screenshots, and repo specs.",
        "Acceptance criteria: every supported answer needs source trail coverage and source capability metadata."
      ].join("\n"),
      extractedText: "",
      expectedTerms: ["email-like threads", "task exports", "source capability metadata"],
      expectedCapabilityKind: "document",
      expectsTable: false,
      expectsFigure: false,
      expectsPage: false
    }
  ];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function containsTerm(text: string, term: string): boolean {
  return ` ${normalize(text)} `.includes(` ${normalize(term)} `);
}

async function writeFixtures(stamp: string): Promise<string> {
  const root = path.join(generatedRoot(), stamp);
  await rm(root, { recursive: true, force: true });
  for (const fixture of fixtures()) {
    const filePath = path.join(root, fixture.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fixture.body, "utf8");
    if (fixture.extractedText) {
      await writeFile(`${filePath}.txt`, fixture.extractedText, "utf8");
    }
  }
  return root;
}

async function rowForFixture(root: string, fixture: DocumentFixture): Promise<Row> {
  const absolutePath = path.join(root, fixture.relativePath);
  const extraction = await sidecarDocumentExtractionProvider.extract({
    absolutePath,
    metadata: fixture.extractedText
      ? {
          extracted_text_path: `${absolutePath}.txt`,
          document_extraction_provider: "sidecar_text_extraction"
        }
      : {
          source_kind_family: "email_thread"
        }
  });
  const rawText = extraction?.extractedText || fixture.body;
  const packet = buildIngestionRouterV2Packet({
    namespaceId: "document_ingestion_quality_preview",
    sourceType: fixture.sourceType,
    sourceUri: absolutePath,
    capturedAt: "2026-05-23T12:00:00.000Z",
    rawText,
    metadata: {
      source_kind_family: fixture.id === "email_thread_document" ? "email_thread" : fixture.sourceType === "image" ? "screenshot_ocr" : "pdf_document",
      extracted_text_path: fixture.extractedText ? `${absolutePath}.txt` : undefined,
      document_extraction_provider: fixture.extractedText ? "sidecar_text_extraction" : undefined
    }
  });
  const missingTerms = fixture.expectedTerms.filter((term) => !containsTerm(rawText, term));
  const pageCount = extraction?.qualityMetrics.pageCount ?? (packet.adapter?.artifactChunks.some((chunk) => typeof chunk.metadata.page === "number") ? 1 : 0);
  const tableCount = extraction?.qualityMetrics.tableCount ?? 0;
  const figureCount = extraction?.qualityMetrics.figureCount ?? 0;
  const ocrBlockCount = extraction?.qualityMetrics.ocrBlockCount ?? 0;
  const residualOwner: Row["residualOwner"] =
    fixture.extractedText && !extraction?.qualityMetrics.hasText
      ? "provider_extraction_missing"
      : packet.sourceCapabilityProfile.sourceKind !== fixture.expectedCapabilityKind
        ? "capability_kind_wrong"
        : packet.sourceCapabilityProfile.unsupportedCapabilities.length > 0
          ? "unsupported_capability"
          : fixture.expectsPage && pageCount === 0
            ? "page_provenance_missing"
            : fixture.expectsTable && tableCount === 0
              ? "table_missing"
              : fixture.expectsFigure && figureCount === 0
                ? "figure_missing"
                : missingTerms.length > 0
                  ? "missing_terms"
                  : "none";
  return {
    id: fixture.id,
    sourceType: fixture.sourceType,
    capabilityKind: packet.sourceCapabilityProfile.sourceKind,
    providerName: extraction?.providerName ?? null,
    hasExtractedText: extraction?.qualityMetrics.hasText ?? packet.sourceCapabilityProfile.quality.hasTextContent,
    pageCount,
    tableCount,
    figureCount,
    ocrBlockCount,
    sourceCapabilityUnsupported: packet.sourceCapabilityProfile.unsupportedCapabilities,
    missingTerms,
    passed: residualOwner === "none",
    residualOwner
  };
}

function metrics(rows: readonly Row[]): DocumentIngestionQualityReport["metrics"] {
  const pdfRows = rows.filter((row) => row.sourceType === "pdf");
  const imageRows = rows.filter((row) => row.sourceType === "image");
  const tableRows = rows.filter((row) => row.id.includes("tables"));
  const figureRows = rows.filter((row) => row.id.includes("figures") || row.figureCount > 0);
  const pageRows = rows.filter((row) => row.sourceType === "pdf");
  return {
    sourceCapabilityCoverageRate: rate(rows.filter((row) => row.sourceCapabilityUnsupported.length === 0).length, rows.length),
    pdfTextExtractionCoverageRate: rate(pdfRows.filter((row) => row.hasExtractedText).length, pdfRows.length),
    imageOcrExtractionCoverageRate: rate(imageRows.filter((row) => row.hasExtractedText && row.ocrBlockCount > 0).length, imageRows.length),
    tableExtractionCoverageRate: rate(tableRows.filter((row) => row.tableCount > 0).length, tableRows.length),
    figureCaptionCoverageRate: rate(figureRows.filter((row) => row.figureCount > 0).length, figureRows.length),
    pageSourceTrailCoverageRate: rate(pageRows.filter((row) => row.pageCount > 0).length, pageRows.length),
    documentQuestionPassRate: rate(rows.filter((row) => row.missingTerms.length === 0).length, rows.length),
    documentUnsupportedSilentSuccessCount: rows.filter((row) => row.sourceCapabilityUnsupported.length > 0 && row.passed).length,
    queryTimeModelCalls: 0
  };
}

function toMarkdown(report: DocumentIngestionQualityReport): string {
  return [
    "# Document Ingestion Quality Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- sourceCapabilityCoverageRate: ${report.metrics.sourceCapabilityCoverageRate}`,
    `- pdfTextExtractionCoverageRate: ${report.metrics.pdfTextExtractionCoverageRate}`,
    `- imageOcrExtractionCoverageRate: ${report.metrics.imageOcrExtractionCoverageRate}`,
    `- tableExtractionCoverageRate: ${report.metrics.tableExtractionCoverageRate}`,
    `- figureCaptionCoverageRate: ${report.metrics.figureCaptionCoverageRate}`,
    `- pageSourceTrailCoverageRate: ${report.metrics.pageSourceTrailCoverageRate}`,
    `- documentQuestionPassRate: ${report.metrics.documentQuestionPassRate}`,
    "",
    "## Rows",
    "",
    ...report.results.map((row) => `- ${row.id}: passed=${row.passed} residual=${row.residualOwner} capability=${row.capabilityKind} provider=${row.providerName ?? "-"} missing=${row.missingTerms.join("|")}`),
    ""
  ].join("\n");
}

export async function runAndWriteDocumentIngestionQualityPack(): Promise<{
  readonly report: DocumentIngestionQualityReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = await writeFixtures(stamp);
  const results: Row[] = [];
  for (const fixture of fixtures()) {
    results.push(await rowForFixture(root, fixture));
  }
  const reportMetrics = metrics(results);
  const report: DocumentIngestionQualityReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "document_ingestion_quality_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        fixtureCount: results.length
      }
    }),
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      reportMetrics.sourceCapabilityCoverageRate >= 0.95 &&
      reportMetrics.pdfTextExtractionCoverageRate >= 0.95 &&
      reportMetrics.imageOcrExtractionCoverageRate >= 0.95 &&
      reportMetrics.tableExtractionCoverageRate >= 0.8 &&
      reportMetrics.figureCaptionCoverageRate >= 0.75 &&
      reportMetrics.pageSourceTrailCoverageRate === 1 &&
      reportMetrics.documentQuestionPassRate >= 0.85 &&
      reportMetrics.documentUnsupportedSilentSuccessCount === 0 &&
      reportMetrics.queryTimeModelCalls === 0,
    metrics: reportMetrics,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `document-ingestion-quality-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `document-ingestion-quality-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runDocumentIngestionQualityPackCli(): Promise<void> {
  const { report, output } = await runAndWriteDocumentIngestionQualityPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  if (!report.passed) process.exitCode = 1;
}
