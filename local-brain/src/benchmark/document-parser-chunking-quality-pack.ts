import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { closePool, queryRows } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import type { SourceType } from "../types.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { hasTerm, payloadEvidenceCount, percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_tasks" | "memory.extract_calendar";

interface FixtureFile {
  readonly relativePath: string;
  readonly sourceType: SourceType;
  readonly capturedAt: string;
  readonly body: string;
  readonly sidecarText?: string;
  readonly metadata?: Record<string, unknown>;
}

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

interface DocumentChunkRow {
  readonly chunkId: string;
  readonly sourceUri: string;
  readonly artifactType: string;
  readonly parserProvider: string | null;
  readonly parserVersion: string | null;
  readonly chunkingStrategy: string | null;
  readonly childChunkId: string | null;
  readonly parentSourceSectionId: string | null;
  readonly pageNumber: number | null;
  readonly sectionHeading: string | null;
  readonly layoutWarningCount: number;
  readonly layoutWarningKinds: readonly string[];
  readonly textPreview: string;
}

interface QueryRow extends Scenario {
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
  readonly passed: boolean;
}

interface DocumentParserChunkingQualityReport {
  readonly generatedAt: string;
  readonly benchmark: "document_parser_chunking_quality_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly sampleCount: number;
  readonly documentChunkCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly documentParserMetadataCoverage: number;
    readonly documentChunkingStrategyCoverage: number;
    readonly parentChildChunkCoverage: number;
    readonly pageOrSectionMetadataCoverage: number;
    readonly layoutWarningCoverage: number;
    readonly documentTaskCalendarExpectedTermCoverage: number;
    readonly documentRetrievalWrongParentContextCount: number;
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly documentChunks: readonly DocumentChunkRow[];
  readonly results: readonly QueryRow[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "document-parser-chunking-quality-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "notes/2026-05-29-document-chunking-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T10:00:00.000Z",
      body: [
        "# Document chunking note",
        "",
        "Action items: update the document chunking task and verify parent-section source trails.",
        "Calendar note: document parser review on June 26, 2026.",
        "Saved document note: AI memory PDFs need hierarchical chunking and quality gates."
      ].join("\n"),
      metadata: {
        source_kind_family: "markdown_note",
        relative_path: "notes/2026-05-29-document-chunking-note.md"
      }
    },
    {
      relativePath: "pdfs/ai-memory-parser-quality.pdf",
      sourceType: "pdf",
      capturedAt: "2026-05-29T10:05:00.000Z",
      body: "%PDF-1.4\n% parser quality placeholder\n",
      sidecarText: [
        "--- page 1 ---",
        "AI memory PDF for retrieval planning. Section: Parser Quality.",
        "Action item: add parent section source audit for the document chunking task.",
        "The PDF says hierarchical chunking and page trails are required for source-bound retrieval.",
        "Table 1 | Parser | Chunking | sidecar_text_extraction | pdf_page_section_v1 |",
        "--- page 2 ---",
        "Section: Retrieval Quality.",
        "Calendar note: AI memory PDF review on June 27, 2026.",
        "Figure 2: diagram of child chunks rolling up to parent sections."
      ].join("\n"),
      metadata: {
        source_kind_family: "pdf_document",
        document_extraction_provider: "sidecar_text_extraction",
        document_extraction_provider_version: "1.0.0",
        relative_path: "pdfs/ai-memory-parser-quality.pdf"
      }
    },
    {
      relativePath: "screenshots/parser-quality-whiteboard.png",
      sourceType: "image",
      capturedAt: "2026-05-29T10:10:00.000Z",
      body: "PNG placeholder for benchmark OCR fixture.\n",
      sidecarText: [
        "Screenshot OCR block: parser quality board.",
        "Task: verify OCR layout warnings and image-region source trail.",
        "Layout warning: OCR region detected in screenshot.",
        "The board says document retrieval quality gates should expose parser, chunking, and parent section metadata."
      ].join("\n"),
      metadata: {
        source_kind_family: "screenshot_ocr",
        document_extraction_provider: "sidecar_text_extraction",
        document_extraction_provider_version: "1.0.0",
        relative_path: "screenshots/parser-quality-whiteboard.png"
      }
    },
    {
      relativePath: "exports/tasks/document-parser-tasks.json",
      sourceType: "task_list",
      capturedAt: "2026-05-29T10:15:00.000Z",
      body: JSON.stringify(
        {
          tasks: [
            {
              title: "Verify document parser metadata coverage",
              status: "open",
              project: "Document parser chunking quality",
              due: "2026-06-26"
            }
          ]
        },
        null,
        2
      ),
      metadata: {
        source_kind_family: "task_export",
        relative_path: "exports/tasks/document-parser-tasks.json"
      }
    },
    {
      relativePath: "exports/calendar/document-parser-calendar.ics",
      sourceType: "calendar_export",
      capturedAt: "2026-05-29T10:20:00.000Z",
      body: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:document-parser-review",
        "DTSTART;VALUE=DATE:20260626",
        "SUMMARY:Document parser review",
        "DESCRIPTION:Review parser metadata, chunking strategy, and parent section source trails.",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\n"),
      metadata: {
        source_kind_family: "calendar_export",
        relative_path: "exports/calendar/document-parser-calendar.ics"
      }
    }
  ];
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "tasks_notes_pdfs_exports",
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention across notes, PDFs, and task exports this week?",
      expectedTerms: ["document chunking task", "parent section source audit", "document parser metadata coverage"],
      forbiddenTerms: ["airline baggage", "Iceland lodging"]
    },
    {
      id: "calendar_notes_exports",
      toolName: "memory.extract_calendar",
      query: "What calendar commitments are in my notes and calendar exports for June 2026?",
      expectedTerms: ["Document parser review", "AI memory PDF review", "2026-06-26"],
      forbiddenTerms: ["Bangkok AI model meetup", "Burning Man"]
    },
    {
      id: "ai_memory_pdfs",
      toolName: "memory.search",
      query: "What AI memory PDFs did I save for retrieval planning?",
      expectedTerms: ["AI memory PDF", "hierarchical chunking", "page trails"],
      forbiddenTerms: ["OMI", "Chiang Mai"]
    },
    {
      id: "section_source_for_chunking_task",
      toolName: "memory.search",
      query: "Show me the section source for the document chunking task.",
      expectedTerms: ["parent section source audit", "document chunking task", "source"],
      forbiddenTerms: ["Iceland", "driver"]
    },
    {
      id: "layout_warnings",
      toolName: "memory.search",
      query: "Which saved documents have table, OCR, or layout warnings?",
      expectedTerms: ["Table", "OCR", "layout warning"],
      forbiddenTerms: ["Gummi", "Well Inked"]
    }
  ];
}

async function writeFixtures(namespaceId: string): Promise<{ readonly rootPath: string; readonly files: readonly FixtureFile[] }> {
  const rootPath = path.join(generatedRoot(), namespaceId);
  await rm(rootPath, { recursive: true, force: true });
  for (const fixture of fixtures()) {
    const filePath = path.join(rootPath, fixture.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fixture.body, "utf8");
    if (fixture.sidecarText) {
      await writeFile(`${filePath}.txt`, fixture.sidecarText, "utf8");
    }
  }
  return { rootPath, files: fixtures() };
}

async function ingestFixtures(namespaceId: string, rootPath: string, files: readonly FixtureFile[]): Promise<void> {
  for (const fixture of files) {
    const inputUri = path.join(rootPath, fixture.relativePath);
    await ingestArtifact({
      namespaceId,
      inputUri,
      sourceType: fixture.sourceType,
      sourceChannel: "benchmark:document_parser_chunking_quality_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      skipExternalRelationCandidates: true,
      skipVectorActivation: true,
      metadata: {
        benchmark: "document_parser_chunking_quality_pack",
        fixture: fixture.relativePath,
        extracted_text_path: fixture.sidecarText ? `${inputUri}.txt` : undefined,
        ...(fixture.metadata ?? {})
      }
    });
  }
}

function payloadText(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasComparableTerm(text: string, term: string): boolean {
  return ` ${normalizeComparable(text)} `.includes(` ${normalizeComparable(term)} `);
}

function sourceTrailEntries(payload: any): readonly any[] {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((item: any) => (Array.isArray(item?.sourceTrail) ? item.sourceTrail : []))
    : [];
  return [...topLevel, ...tasks, ...commitments];
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function classifyQueryRow(row: Omit<QueryRow, "residualOwner" | "passed">): string | null {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (row.evidenceCount === 0) return "unsupported_no_evidence";
  if (row.sourceTrailCount === 0) return "empty_source_trail";
  if (row.claimAuditCount === 0) return "missing_claim_audit";
  if (row.forbiddenHits.length > 0) return "wrong_parent_context";
  if (row.missingTerms.length > 0) return "missing_terms";
  return null;
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<QueryRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full",
    detailMode: "full",
    reference_now: "2026-05-29T10:30:00.000Z",
    referenceNow: "2026-05-29T10:30:00.000Z",
    limit: 12
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const rowBase = {
    ...scenario,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: sourceTrailEntries(payload).length,
    claimAuditCount: claimAuditCount(payload),
    missingTerms: scenario.expectedTerms.filter((term) => !hasTerm(payload, term)),
    forbiddenHits: (scenario.forbiddenTerms ?? []).filter((term) => hasComparableTerm(payloadText(payload), term)),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyQueryRow(rowBase);
  return { ...rowBase, residualOwner, passed: residualOwner === null };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

async function loadDocumentChunks(namespaceId: string): Promise<readonly DocumentChunkRow[]> {
  const rows = await queryRows<{
    readonly chunk_id: string;
    readonly uri: string;
    readonly artifact_type: string;
    readonly text_content: string;
    readonly metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        ac.id::text AS chunk_id,
        a.uri,
        a.artifact_type,
        ac.text_content,
        ac.metadata
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      WHERE a.namespace_id = $1
        AND (
          a.artifact_type IN ('markdown', 'pdf', 'image')
          OR a.uri LIKE '%.pdf'
          OR a.uri LIKE '%.png'
          OR a.uri LIKE '%.md'
        )
      ORDER BY a.uri, ac.chunk_index
    `,
    [namespaceId]
  );
  return rows.map((row) => {
    const metadata = row.metadata ?? {};
    return {
      chunkId: row.chunk_id,
      sourceUri: row.uri,
      artifactType: row.artifact_type,
      parserProvider: readString(metadata.document_parser_provider),
      parserVersion: readString(metadata.document_parser_version),
      chunkingStrategy: readString(metadata.document_chunking_strategy),
      childChunkId: readString(metadata.child_chunk_id),
      parentSourceSectionId: readString(metadata.parent_source_section_id),
      pageNumber: typeof metadata.page_number === "number" ? metadata.page_number : null,
      sectionHeading: readString(metadata.section_heading),
      layoutWarningCount: typeof metadata.layout_warning_count === "number" ? metadata.layout_warning_count : 0,
      layoutWarningKinds: readStringArray(metadata.layout_warning_kinds),
      textPreview: row.text_content.slice(0, 240)
    };
  });
}

function metrics(chunks: readonly DocumentChunkRow[], rows: readonly QueryRow[]): DocumentParserChunkingQualityReport["metrics"] {
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const warningExpectedRows = chunks.filter((chunk) => /\b(?:table|figure|diagram|ocr|screenshot|layout warning)\b/iu.test(chunk.textPreview));
  return {
    documentParserMetadataCoverage: rate(chunks.filter((chunk) => chunk.parserProvider && chunk.parserVersion).length, chunks.length),
    documentChunkingStrategyCoverage: rate(chunks.filter((chunk) => chunk.chunkingStrategy).length, chunks.length),
    parentChildChunkCoverage: rate(chunks.filter((chunk) => chunk.childChunkId && chunk.parentSourceSectionId).length, chunks.length),
    pageOrSectionMetadataCoverage: rate(chunks.filter((chunk) => chunk.pageNumber || chunk.sectionHeading || chunk.parentSourceSectionId).length, chunks.length),
    layoutWarningCoverage: rate(warningExpectedRows.filter((chunk) => chunk.layoutWarningCount > 0 && chunk.layoutWarningKinds.length > 0).length, warningExpectedRows.length),
    documentTaskCalendarExpectedTermCoverage: rate(rows.filter((row) => row.missingTerms.length === 0).length, rows.length),
    documentRetrievalWrongParentContextCount: rows.filter((row) => row.forbiddenHits.length > 0).length,
    supportedZeroEvidenceCount: rows.filter((row) => row.evidenceCount === 0).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
}

function markdownReport(report: DocumentParserChunkingQualityReport): string {
  return [
    "# Document Parser Chunking Quality Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- documentParserMetadataCoverage: ${report.metrics.documentParserMetadataCoverage}`,
    `- documentChunkingStrategyCoverage: ${report.metrics.documentChunkingStrategyCoverage}`,
    `- parentChildChunkCoverage: ${report.metrics.parentChildChunkCoverage}`,
    `- layoutWarningCoverage: ${report.metrics.layoutWarningCoverage}`,
    `- documentTaskCalendarExpectedTermCoverage: ${report.metrics.documentTaskCalendarExpectedTermCoverage}`,
    `- documentRetrievalWrongParentContextCount: ${report.metrics.documentRetrievalWrongParentContextCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Query Rows",
    "",
    ...report.results.map((row) => `- ${row.id}: passed=${row.passed} residual=${row.residualOwner ?? "none"} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} missing=${row.missingTerms.join("|")}`),
    "",
    "## Document Chunks",
    "",
    ...report.documentChunks.map((chunk) => `- ${path.basename(chunk.sourceUri)}: parser=${chunk.parserProvider ?? "-"} strategy=${chunk.chunkingStrategy ?? "-"} parent=${chunk.parentSourceSectionId ?? "-"} page=${chunk.pageNumber ?? "-"} warnings=${chunk.layoutWarningKinds.join("|") || "-"}`),
    ""
  ].join("\n");
}

export async function runAndWriteDocumentParserChunkingQualityPack(): Promise<{
  readonly report: DocumentParserChunkingQualityReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `benchmark_document_parser_chunking_quality_${stamp.replace(/[^0-9A-Za-z]/gu, "_")}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: QueryRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const documentChunks = await loadDocumentChunks(namespaceId);
  const computedMetrics = metrics(documentChunks, results);
  const report: DocumentParserChunkingQualityReport = {
    generatedAt,
    benchmark: "document_parser_chunking_quality_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        scenarioCount: results.length,
        documentChunkCount: documentChunks.length
      }
    }),
    namespaceId,
    sampleCount: results.length,
    documentChunkCount: documentChunks.length,
    passed:
      results.every((row) => row.passed) &&
      computedMetrics.documentParserMetadataCoverage === 1 &&
      computedMetrics.documentChunkingStrategyCoverage === 1 &&
      computedMetrics.parentChildChunkCoverage >= 0.95 &&
      computedMetrics.layoutWarningCoverage >= 0.95 &&
      computedMetrics.documentTaskCalendarExpectedTermCoverage === 1 &&
      computedMetrics.documentRetrievalWrongParentContextCount === 0 &&
      computedMetrics.supportedZeroEvidenceCount === 0 &&
      computedMetrics.supportedEmptySourceTrailCount === 0 &&
      computedMetrics.supportedMissingClaimAuditCount === 0 &&
      computedMetrics.queryTimeModelCalls === 0,
    metrics: computedMetrics,
    documentChunks,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `document-parser-chunking-quality-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `document-parser-chunking-quality-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdownReport(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runDocumentParserChunkingQualityPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteDocumentParserChunkingQualityPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
