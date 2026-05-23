import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
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
  readonly sourceKindFamily: "task" | "temporal" | "dossier";
  readonly expectedTerms: readonly string[];
  readonly expectedSourceKinds: readonly string[];
  readonly forbiddenSourceKinds?: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

interface Row extends Scenario {
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly actualSourceKinds: readonly string[];
  readonly missingTerms: readonly string[];
  readonly missingSourceKinds: readonly string[];
  readonly forbiddenSourceKindHits: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly passed: boolean;
  readonly residualOwner: "none" | "source_kind_missing" | "missing_terms" | "empty_source_trail" | "unsupported_no_evidence" | "query_time_model_call" | "scope_leak";
}

export interface MultiSourceIngestionPackReport {
  readonly generatedAt: string;
  readonly benchmark: "multi_source_ingestion_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly sourceReferences: readonly {
    readonly title: string;
    readonly url: string;
    readonly sourceKind: string;
    readonly fixture: string;
  }[];
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly sourceKindCoverageCount: number;
    readonly crossSourceTemporalPassRate: number;
    readonly crossSourceTaskPassRate: number;
    readonly crossSourceDossierPassRate: number;
    readonly sourceTrailCoverageRate: number;
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "multi-source-ingestion-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "notes/2026-05-23-phase-14-ai-reading-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-23T08:00:00.000Z",
      body: [
        "# Phase 14 AI reading note",
        "",
        "I am tracking AI memory papers for retrieval planning this week.",
        "Action items: review the Schema-Grounded Memory PDF, compare xMemory chunking against our source envelope, and update the Phase 14 retrieval spec.",
        "Calendar note: attend the Bangkok AI model meetup on June 15, 2026."
      ].join("\n"),
      metadata: {
        phase: "14",
        source_kind_family: "markdown_note"
      }
    },
    {
      relativePath: "pdfs/schema-grounded-memory-2604.27906.pdf",
      sourceType: "pdf",
      capturedAt: "2026-05-23T08:05:00.000Z",
      body: "%PDF-1.4\n% AI Brain benchmark PDF placeholder; extracted text is stored in the sidecar.\n",
      sidecarText: [
        "From Unstructured Recall to Schema-Grounded Memory: Reliable AI Memory via Iterative, Schema-Aware Extraction.",
        "The paper argues that reliable AI memory should not be only embeddings; it should preserve schema-aware extraction, provenance, and verifiable source-bound fields.",
        "For Phase 14, this PDF is evidence for case-by-case chunking, extracted text sidecars, document source trails, and schema-grounded retrieval planning."
      ].join("\n"),
      metadata: {
        phase: "14",
        source_kind_family: "pdf_document",
        source_url: "https://arxiv.org/abs/2604.27906",
        source_pdf_url: "https://arxiv.org/pdf/2604.27906"
      }
    },
    {
      relativePath: "pdfs/xmemory-2602.02007.pdf",
      sourceType: "pdf",
      capturedAt: "2026-05-23T08:10:00.000Z",
      body: "%PDF-1.4\n% AI Brain benchmark PDF placeholder; extracted text is stored in the sidecar.\n",
      sidecarText: [
        "xMemory: Beyond RAG for Agent Memory by retrieval decoupling and aggregation.",
        "The document describes hierarchical memory, component-based retrieval, decoupled recall, and aggregation to reduce redundancy.",
        "For our system, xMemory supports testing hybrid recall, reranking support, and chunk aggregation across PDF and markdown notes."
      ].join("\n"),
      metadata: {
        phase: "14",
        source_kind_family: "pdf_document",
        source_url: "https://arxiv.org/abs/2602.02007",
        source_pdf_url: "https://arxiv.org/pdf/2602.02007"
      }
    },
    {
      relativePath: "exports/tasks/phase-14-tasks.json",
      sourceType: "task_list",
      capturedAt: "2026-05-23T08:15:00.000Z",
      body: JSON.stringify(
        {
          exported_at: "2026-05-23T08:15:00.000Z",
          tasks: [
            {
              title: "Review Schema-Grounded Memory PDF",
              status: "open",
              project: "Phase 14 multi-source ingestion",
              due: "2026-05-24"
            },
            {
              title: "Add document chunking fixture",
              status: "open",
              project: "Phase 14 multi-source ingestion",
              due: "2026-05-24"
            },
            {
              title: "Archive stale mock PDF fixtures after benchmark run",
              status: "open",
              project: "Phase 14 multi-source ingestion"
            }
          ]
        },
        null,
        2
      ),
      metadata: {
        phase: "14",
        source_kind_family: "task_export",
        source_type_hint: "task_list"
      }
    },
    {
      relativePath: "exports/calendar/phase-14-ai-calendar.ics",
      sourceType: "calendar_export",
      capturedAt: "2026-05-23T08:20:00.000Z",
      body: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:phase14-bangkok-ai-model-meetup",
        "DTSTART;VALUE=DATE:20260615",
        "SUMMARY:Bangkok AI model meetup",
        "DESCRIPTION:Discuss latest AI model PDFs, memory retrieval, and chunking strategy.",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:phase14-pdf-review-block",
        "DTSTART;VALUE=DATE:20260616",
        "SUMMARY:AI memory PDF review block",
        "DESCRIPTION:Review Schema-Grounded Memory and xMemory papers for Phase 14 retrieval planning.",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\n"),
      metadata: {
        phase: "14",
        source_kind_family: "calendar_export",
        source_type_hint: "calendar_export"
      }
    }
  ];
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "tasks_across_notes_docs_exports",
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention across notes, PDFs, and task exports this week?",
      sourceKindFamily: "task",
      expectedTerms: ["Schema-Grounded Memory PDF", "document chunking fixture", "Phase 14 retrieval spec"],
      expectedSourceKinds: ["markdown", "task_list"],
      forbiddenTerms: ["driver's license", "Jeep", "RV"]
    },
    {
      id: "travel_commitments_notes_calendar",
      toolName: "memory.extract_calendar",
      query: "What travel or calendar commitments are in my notes and calendar exports for June 2026?",
      sourceKindFamily: "temporal",
      expectedTerms: ["Bangkok AI model meetup", "2026-06-15", "AI memory PDF review"],
      expectedSourceKinds: ["markdown", "calendar_export"],
      forbiddenTerms: ["Iceland", "San Francisco", "Burning Man"]
    },
    {
      id: "ai_memory_pdf_retrieval_planning",
      toolName: "memory.search",
      query: "What AI memory PDFs did I save for retrieval planning?",
      sourceKindFamily: "dossier",
      expectedTerms: ["Schema-Grounded Memory", "xMemory", "chunking"],
      expectedSourceKinds: ["pdf"],
      forbiddenSourceKinds: ["markdown", "task_list", "calendar_export"],
      forbiddenTerms: ["OMI", "Chiang Mai friends"]
    },
    {
      id: "project_specs_cross_source",
      toolName: "memory.search",
      query: "What project specs mention Phase 14 retrieval planning across notes and PDFs?",
      sourceKindFamily: "dossier",
      expectedTerms: ["Phase 14", "retrieval planning", "source envelope"],
      expectedSourceKinds: ["markdown", "pdf"],
      forbiddenSourceKinds: ["task_list", "calendar_export"],
      forbiddenTerms: ["Well Inked", "Lauren left Thailand"]
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
      sourceChannel: "benchmark:multi_source_ingestion_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      skipExternalRelationCandidates: true,
      skipVectorActivation: true,
      metadata: {
        benchmark: "multi_source_ingestion_pack",
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

function sourceKindsFromPayload(payload: any): readonly string[] {
  const kinds = new Set<string>();
  for (const entry of sourceTrailEntries(payload)) {
    const uri = typeof entry?.sourceUri === "string" ? entry.sourceUri : "";
    if (typeof entry?.sourceKind === "string") kinds.add(entry.sourceKind);
    if (uri.endsWith(".md")) kinds.add("markdown");
    if (uri.endsWith(".pdf")) kinds.add("pdf");
    if (uri.endsWith(".json")) kinds.add("task_list");
    if (uri.endsWith(".ics")) kinds.add("calendar_export");
  }
  const text = payloadText(payload);
  if (text.includes(".md")) kinds.add("markdown");
  if (text.includes(".pdf")) kinds.add("pdf");
  if (text.includes(".json")) kinds.add("task_list");
  if (text.includes(".ics")) kinds.add("calendar_export");
  return [...kinds].sort();
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function sourceTrailCount(payload: any): number {
  return sourceTrailEntries(payload).length;
}

function classifyResidual(row: Omit<Row, "residualOwner" | "passed">): Row["residualOwner"] {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (row.evidenceCount === 0) return "unsupported_no_evidence";
  if (row.sourceTrailCount === 0) return "empty_source_trail";
  if (row.missingSourceKinds.length > 0) return "source_kind_missing";
  if (row.forbiddenSourceKindHits.length > 0) return "scope_leak";
  if (row.forbiddenHits.length > 0) return "scope_leak";
  if (row.missingTerms.length > 0) return "missing_terms";
  return "none";
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<Row> {
  const startedAt = performance.now();
  const args: Record<string, unknown> = {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full",
    detailMode: "full",
    reference_now: "2026-05-23T08:30:00.000Z",
    limit: 10
  };
  const wrapped = (await executeMcpTool(scenario.toolName, args)) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const text = payloadText(payload);
  const actualSourceKinds = sourceKindsFromPayload(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasComparableTerm(text, term));
  const missingSourceKinds = scenario.expectedSourceKinds.filter((kind) => !actualSourceKinds.includes(kind));
  const forbiddenSourceKindHits = (scenario.forbiddenSourceKinds ?? []).filter((kind) => actualSourceKinds.includes(kind));
  const evidenceCount = payloadEvidenceCount(payload);
  const rowBase = {
    ...scenario,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    actualSourceKinds,
    missingTerms,
    missingSourceKinds,
    forbiddenSourceKindHits,
    forbiddenHits,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyResidual(rowBase);
  const passed = residualOwner === "none";
  return {
    ...rowBase,
    residualOwner,
    passed
  };
}

function metricsFromRows(rows: readonly Row[], sourceKindCoverageCount: number): MultiSourceIngestionPackReport["metrics"] {
  const taskRows = rows.filter((row) => row.sourceKindFamily === "task");
  const temporalRows = rows.filter((row) => row.sourceKindFamily === "temporal");
  const dossierRows = rows.filter((row) => row.sourceKindFamily === "dossier");
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  return {
    sourceKindCoverageCount,
    crossSourceTemporalPassRate: rate(temporalRows.filter((row) => row.passed).length, temporalRows.length),
    crossSourceTaskPassRate: rate(taskRows.filter((row) => row.passed).length, taskRows.length),
    crossSourceDossierPassRate: rate(dossierRows.filter((row) => row.passed).length, dossierRows.length),
    sourceTrailCoverageRate: rate(supportedRows.filter((row) => row.sourceTrailCount > 0).length, supportedRows.length),
    supportedZeroEvidenceCount: rows.filter((row) => row.evidenceCount === 0).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
}

function sourceReferences(rootPath: string): MultiSourceIngestionPackReport["sourceReferences"] {
  return [
    {
      title: "From Unstructured Recall to Schema-Grounded Memory",
      url: "https://arxiv.org/abs/2604.27906",
      sourceKind: "pdf",
      fixture: path.join(rootPath, "pdfs/schema-grounded-memory-2604.27906.pdf")
    },
    {
      title: "xMemory: Beyond RAG for Agent Memory",
      url: "https://arxiv.org/abs/2602.02007",
      sourceKind: "pdf",
      fixture: path.join(rootPath, "pdfs/xmemory-2602.02007.pdf")
    }
  ];
}

function toMarkdown(report: MultiSourceIngestionPackReport): string {
  const lines = [
    "# Multi-Source Ingestion Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- sourceKindCoverageCount: ${report.metrics.sourceKindCoverageCount}`,
    `- crossSourceTemporalPassRate: ${report.metrics.crossSourceTemporalPassRate}`,
    `- crossSourceTaskPassRate: ${report.metrics.crossSourceTaskPassRate}`,
    `- crossSourceDossierPassRate: ${report.metrics.crossSourceDossierPassRate}`,
    `- sourceTrailCoverageRate: ${report.metrics.sourceTrailCoverageRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Source References",
    "",
    ...report.sourceReferences.map((source) => `- ${source.title}: ${source.url} (${source.sourceKind})`),
    "",
    "## Rows",
    "",
    ...report.results.map(
      (row) =>
        `- ${row.id}: passed=${row.passed} residual=${row.residualOwner} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} kinds=${row.actualSourceKinds.join(",")} missingTerms=${row.missingTerms.join("|")}`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMultiSourceIngestionPack(): Promise<{
  readonly report: MultiSourceIngestionPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_multi_source_ingestion_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });

  const rows: Row[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(namespaceId, scenario));
  }

  const sourceKindCoverageCount = new Set(files.map((fixture) => fixture.sourceType)).size;
  const metrics = metricsFromRows(rows, sourceKindCoverageCount);
  const report: MultiSourceIngestionPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "multi_source_ingestion_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: rows.length,
        namespaceId,
        sourceKindCoverageCount
      }
    }),
    namespaceId,
    sourceReferences: sourceReferences(rootPath),
    sampleCount: rows.length,
    passed:
      rows.every((row) => row.passed) &&
      metrics.sourceKindCoverageCount >= 4 &&
      metrics.crossSourceTemporalPassRate >= 0.95 &&
      metrics.crossSourceTaskPassRate >= 0.95 &&
      metrics.crossSourceDossierPassRate >= 0.95 &&
      metrics.sourceTrailCoverageRate === 1 &&
      metrics.supportedZeroEvidenceCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };

  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `multi-source-ingestion-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `multi-source-ingestion-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMultiSourceIngestionPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteMultiSourceIngestionPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
