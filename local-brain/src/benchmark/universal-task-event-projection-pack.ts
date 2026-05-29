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
import { hasTerm, percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

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
  readonly expectedSourceKinds: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

interface ProjectionAuditRow {
  readonly id: string;
  readonly table: "task_items" | "date_time_spans";
  readonly sourceKind: string | null;
  readonly sourceKindFamily: string | null;
  readonly sourceUri: string | null;
  readonly canonicalProjectionVersion: string | null;
  readonly projectionFamily: string | null;
  readonly sourceCaptureTime: string | null;
  readonly validTimeStart: string | null;
  readonly validTimeEnd: string | null;
  readonly temporalEdgeCount: number;
  readonly parentSourceSectionId: string | null;
}

interface QueryRow extends Scenario {
  readonly answer: string;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly actualSourceKinds: readonly string[];
  readonly missingTerms: readonly string[];
  readonly missingSourceKinds: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
  readonly passed: boolean;
}

interface UniversalTaskEventProjectionReport {
  readonly generatedAt: string;
  readonly benchmark: "universal_task_event_projection_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly sampleCount: number;
  readonly projectionRowCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly taskProjectionSourceKindCoverage: number;
    readonly eventProjectionSourceKindCoverage: number;
    readonly sourceUriCoverageRate: number;
    readonly sourceTrailCoverageRate: number;
    readonly claimAuditCoverageRate: number;
    readonly taskEventTemporalEdgeCoverageRate: number;
    readonly validTimeCoverageRate: number;
    readonly sourceCaptureTimeCoverageRate: number;
    readonly parentSourceSectionCoverageRate: number;
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly projectionRows: readonly ProjectionAuditRow[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "universal-task-event-projection-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "omi-archive/normalized/2026/05/29/2026-05-29T08-00-00Z__omi__projection.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T08:00:00.000Z",
      body: [
        "# OMI projection note",
        "",
        "I mentioned I need to call the airline about July baggage rules.",
        "I also mentioned a planning call on June 20, 2026."
      ].join("\n"),
      metadata: {
        source_kind_family: "omi",
        relative_path: "omi-archive/normalized/2026/05/29/2026-05-29T08-00-00Z__omi__projection.md"
      }
    },
    {
      relativePath: "notes/2026-05-29-project-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T08:05:00.000Z",
      body: [
        "# Cross-source project note",
        "",
        "Action items: update the temporal retrieval spec and verify the task projection source trail.",
        "Calendar note: meet the Bangkok data team on June 25, 2026."
      ].join("\n"),
      metadata: {
        source_kind_family: "markdown_note",
        relative_path: "notes/2026-05-29-project-note.md"
      }
    },
    {
      relativePath: "pdfs/temporal-memory-design.pdf",
      sourceType: "pdf",
      capturedAt: "2026-05-29T08:10:00.000Z",
      body: "%PDF-1.4\n% benchmark placeholder\n",
      sidecarText: [
        "Temporal memory design PDF.",
        "Action item: review the temporal memory PDF and add a parent section source audit.",
        "The document mentions a review block on June 21, 2026 for projection validation."
      ].join("\n"),
      metadata: {
        source_kind_family: "pdf_document",
        relative_path: "pdfs/temporal-memory-design.pdf"
      }
    },
    {
      relativePath: "screenshots/temporal-whiteboard.png",
      sourceType: "image",
      capturedAt: "2026-05-29T08:12:00.000Z",
      body: "PNG placeholder for benchmark OCR fixture.\n",
      sidecarText: [
        "Screenshot OCR: task and event projection board.",
        "Task: verify OCR task extraction coverage.",
        "Date: June 22, 2026 projection demo."
      ].join("\n"),
      metadata: {
        source_kind_family: "screenshot_ocr",
        relative_path: "screenshots/temporal-whiteboard.png"
      }
    },
    {
      relativePath: "exports/tasks/projection-tasks.json",
      sourceType: "task_list",
      capturedAt: "2026-05-29T08:15:00.000Z",
      body: JSON.stringify(
        {
          exported_at: "2026-05-29T08:15:00.000Z",
          tasks: [
            {
              title: "Add universal task projection fixture",
              status: "open",
              project: "Universal temporal task projection",
              due: "2026-06-19"
            },
            {
              title: "Verify event projection source kind coverage",
              status: "open",
              project: "Universal temporal task projection",
              due: "2026-06-20"
            }
          ]
        },
        null,
        2
      ),
      metadata: {
        source_kind_family: "task_export",
        relative_path: "exports/tasks/projection-tasks.json"
      }
    },
    {
      relativePath: "exports/calendar/projection-calendar.ics",
      sourceType: "calendar_export",
      capturedAt: "2026-05-29T08:20:00.000Z",
      body: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:projection-review",
        "DTSTART;VALUE=DATE:20260623",
        "SUMMARY:Projection review call",
        "DESCRIPTION:Review universal task and event projection coverage.",
        "END:VEVENT",
        "END:VCALENDAR"
      ].join("\n"),
      metadata: {
        source_kind_family: "calendar_export",
        relative_path: "exports/calendar/projection-calendar.ics"
      }
    },
    {
      relativePath: "codex/media-studio-session.md",
      sourceType: "project_note",
      capturedAt: "2026-05-22T08:25:00.000Z",
      body: [
        "# Codex Media Studio Session",
        "",
        "Project: Media Studio.",
        "Action items: add the Media Studio pattern audit, verify the Codex project task projection, and update the skill candidate notes.",
        "Calendar note: Media Studio review on June 24, 2026."
      ].join("\n"),
      metadata: {
        source_kind_family: "codex_session",
        relative_path: "codex/media-studio-session.md"
      }
    }
  ];
}

function rawOmiConversation(): string {
  return JSON.stringify(
    {
      started_at: "2026-05-29T08:00:00.000Z",
      finished_at: "2026-05-29T08:03:00.000Z",
      structured: {
        action_items: [
          {
            description: "Call the airline about July baggage rules.",
            completed: false,
            created_at: "2026-05-29T08:01:00.000Z",
            due_at: "2026-06-17"
          }
        ],
        events: [
          {
            title: "Planning call",
            description: "Planning call on June 20, 2026",
            start: "2026-06-20",
            created: true,
            location: "online"
          }
        ]
      }
    },
    null,
    2
  );
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
  const rawPath = path.join(rootPath, "omi-archive/raw/2026/05/29/2026-05-29T08-00-00Z__omi__projection.json");
  await mkdir(path.dirname(rawPath), { recursive: true });
  await writeFile(rawPath, rawOmiConversation(), "utf8");
  return { rootPath, files: fixtures() };
}

async function ingestFixtures(namespaceId: string, rootPath: string, files: readonly FixtureFile[]): Promise<void> {
  for (const fixture of files) {
    const inputUri = path.join(rootPath, fixture.relativePath);
    await ingestArtifact({
      namespaceId,
      inputUri,
      sourceType: fixture.sourceType,
      sourceChannel: "benchmark:universal_task_event_projection_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      skipExternalRelationCandidates: true,
      skipVectorActivation: true,
      metadata: {
        benchmark: "universal_task_event_projection_pack",
        fixture: fixture.relativePath,
        extracted_text_path: fixture.sidecarText ? `${inputUri}.txt` : undefined,
        ...(fixture.metadata ?? {})
      }
    });
  }
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "latest_omi_tasks",
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention in my most recent OMI note?",
      expectedTerms: ["airline", "July baggage"],
      expectedSourceKinds: ["omi"]
    },
    {
      id: "cross_source_tasks_this_week",
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention across notes, PDFs, and task exports this week?",
      expectedTerms: ["temporal retrieval spec", "temporal memory PDF", "universal task projection fixture"],
      expectedSourceKinds: ["markdown_note", "pdf_document", "task_export"]
    },
    {
      id: "june_calendar_commitments",
      toolName: "memory.extract_calendar",
      query: "What calendar commitments are in my notes and calendar exports for June 2026?",
      expectedTerms: ["Bangkok data team", "Projection review", "2026-06-23"],
      expectedSourceKinds: ["markdown_note", "calendar_export"]
    },
    {
      id: "codex_project_tasks_last_week",
      toolName: "memory.extract_tasks",
      query: "What Codex project tasks did I create last week?",
      expectedTerms: ["Media Studio pattern audit", "Codex project task projection"],
      expectedSourceKinds: ["codex_session"]
    },
    {
      id: "documents_tasks_dates",
      toolName: "memory.extract_tasks",
      query: "What documents mention tasks or dates I should act on?",
      expectedTerms: ["temporal memory PDF", "OCR task extraction"],
      expectedSourceKinds: ["pdf_document", "screenshot_ocr"]
    }
  ];
}

function sourceTrailEntries(payload: any): readonly any[] {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((item: any) => (Array.isArray(item?.sourceTrail) ? item.sourceTrail : []))
    : [];
  return [...topLevel, ...tasks, ...commitments];
}

function payloadText(payload: any): string {
  return JSON.stringify(payload ?? null);
}

function sourceKindsFromPayload(payload: any): readonly string[] {
  const text = payloadText(payload).toLowerCase();
  const kinds = new Set<string>();
  for (const kind of ["omi", "markdown_note", "pdf_document", "screenshot_ocr", "task_export", "calendar_export", "codex_session"]) {
    if (text.includes(kind)) kinds.add(kind);
  }
  for (const entry of sourceTrailEntries(payload)) {
    const uri = typeof entry?.sourceUri === "string" ? entry.sourceUri.toLowerCase() : "";
    if (uri.includes("/omi-archive/")) kinds.add("omi");
    if (uri.endsWith(".md") && uri.includes("/notes/")) kinds.add("markdown_note");
    if (uri.endsWith(".pdf")) kinds.add("pdf_document");
    if (uri.endsWith(".png")) kinds.add("screenshot_ocr");
    if (uri.endsWith(".json")) kinds.add("task_export");
    if (uri.endsWith(".ics")) kinds.add("calendar_export");
    if (uri.includes("/codex/")) kinds.add("codex_session");
  }
  return [...kinds].sort();
}

function evidenceCount(payload: any): number {
  if (typeof payload?.evidenceCount === "number") return payload.evidenceCount;
  if (Array.isArray(payload?.evidence)) return payload.evidence.length;
  if (Array.isArray(payload?.tasks)) return payload.tasks.length;
  if (Array.isArray(payload?.commitments)) return payload.commitments.length;
  return 0;
}

function answerText(payload: any): string {
  if (typeof payload?.answer === "string") return payload.answer;
  if (Array.isArray(payload?.tasks)) return payload.tasks.map((task: any) => task.title).filter(Boolean).join("; ");
  if (Array.isArray(payload?.commitments)) return payload.commitments.map((item: any) => item.title).filter(Boolean).join("; ");
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  return "";
}

function classifyQueryRow(row: Omit<QueryRow, "residualOwner" | "passed">): string | null {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (/\bcould not find authoritative evidence\b|\bno authoritative evidence\b/iu.test(row.answer)) return "unsupported_answer";
  if (row.evidenceCount === 0) return "unsupported_no_evidence";
  if (row.sourceTrailCount === 0) return "empty_source_trail";
  if (row.claimAuditCount === 0) return "missing_claim_audit";
  if (row.missingSourceKinds.length > 0) return "source_kind_missing";
  if (row.missingTerms.length > 0) return "missing_terms";
  if (row.forbiddenHits.length > 0) return "scope_leak";
  return null;
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<QueryRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: namespaceId,
    query: scenario.query,
    detailMode: "full",
    detail_mode: "full",
    referenceNow: "2026-05-29T08:30:00.000Z",
    reference_now: "2026-05-29T08:30:00.000Z",
    limit: 12
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const actualSourceKinds = sourceKindsFromPayload(payload);
  const rowBase = {
    ...scenario,
    answer: answerText(payload),
    evidenceCount: evidenceCount(payload),
    sourceTrailCount: sourceTrailEntries(payload).length,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    actualSourceKinds,
    missingTerms: scenario.expectedTerms.filter((term) => !hasTerm(payload, term)),
    missingSourceKinds: scenario.expectedSourceKinds.filter((kind) => !actualSourceKinds.includes(kind)),
    forbiddenHits: (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(payload, term)),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyQueryRow(rowBase);
  return { ...rowBase, residualOwner, passed: residualOwner === null };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function edgeCount(value: unknown): number {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0).length : 0;
}

async function loadProjectionRows(namespaceId: string): Promise<readonly ProjectionAuditRow[]> {
  const taskRows = await queryRows<{
    readonly id: string;
    readonly source_uri: string | null;
    readonly metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT source_memory_id::text AS id, provenance->>'source_uri' AS source_uri, metadata
      FROM task_items
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const dateRows = await queryRows<{
    readonly id: string;
    readonly source_uri: string | null;
    readonly metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT id::text, provenance->>'source_uri' AS source_uri, metadata
      FROM date_time_spans
      WHERE namespace_id = $1
        AND (
          metadata->>'source_kind' IN ('omi_structured_event', 'temporal_commitment_sentence', 'explicit_date_mention')
          OR metadata ? 'window_start'
          OR metadata ? 'temporal_anchor_reference'
        )
    `,
    [namespaceId]
  );
  const mapRow = (table: "task_items" | "date_time_spans", row: { readonly id: string; readonly source_uri: string | null; readonly metadata: Record<string, unknown> | null }): ProjectionAuditRow => {
    const metadata = row.metadata ?? {};
    return {
      id: row.id,
      table,
      sourceKind: readString(metadata.source_kind),
      sourceKindFamily: readString(metadata.source_kind_family),
      sourceUri: readString(metadata.source_uri) ?? row.source_uri,
      canonicalProjectionVersion: readString(metadata.canonical_projection_version),
      projectionFamily: readString(metadata.projection_family),
      sourceCaptureTime: readString(metadata.source_capture_time),
      validTimeStart: readString(metadata.valid_time_start),
      validTimeEnd: readString(metadata.valid_time_end),
      temporalEdgeCount: edgeCount(metadata.temporal_edge_ids),
      parentSourceSectionId: readString(metadata.parent_source_section_id)
    };
  };
  return [...taskRows.map((row) => mapRow("task_items", row)), ...dateRows.map((row) => mapRow("date_time_spans", row))];
}

function projectionMetrics(rows: readonly ProjectionAuditRow[], queryRows: readonly QueryRow[]): UniversalTaskEventProjectionReport["metrics"] {
  const taskRows = rows.filter((row) => row.table === "task_items");
  const eventRows = rows.filter((row) => row.table === "date_time_spans");
  const supportedQueryRows = queryRows.filter((row) => row.evidenceCount > 0);
  return {
    taskProjectionSourceKindCoverage: rate(taskRows.filter((row) => row.sourceKind && row.sourceUri && row.canonicalProjectionVersion === "universal_task_event_projection_v1").length, taskRows.length),
    eventProjectionSourceKindCoverage: rate(eventRows.filter((row) => row.sourceKind && row.sourceUri && row.canonicalProjectionVersion === "universal_task_event_projection_v1").length, eventRows.length),
    sourceUriCoverageRate: rate(rows.filter((row) => row.sourceUri).length, rows.length),
    sourceTrailCoverageRate: rate(supportedQueryRows.filter((row) => row.sourceTrailCount > 0).length, supportedQueryRows.length),
    claimAuditCoverageRate: rate(supportedQueryRows.filter((row) => row.claimAuditCount > 0).length, supportedQueryRows.length),
    taskEventTemporalEdgeCoverageRate: rate(rows.filter((row) => row.temporalEdgeCount > 0).length, rows.length),
    validTimeCoverageRate: rate(rows.filter((row) => row.validTimeStart || row.validTimeEnd).length, rows.length),
    sourceCaptureTimeCoverageRate: rate(rows.filter((row) => row.sourceCaptureTime).length, rows.length),
    parentSourceSectionCoverageRate: rate(rows.filter((row) => row.parentSourceSectionId).length, rows.length),
    supportedZeroEvidenceCount: queryRows.filter((row) => row.evidenceCount === 0).length,
    supportedEmptySourceTrailCount: supportedQueryRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedQueryRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: queryRows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(queryRows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...queryRows.map((row) => row.latencyMs)).toFixed(2))
  };
}

function markdownReport(report: UniversalTaskEventProjectionReport): string {
  const lines = [
    "# Universal Task Event Projection Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- projectionRowCount: ${report.projectionRowCount}`,
    `- taskProjectionSourceKindCoverage: ${report.metrics.taskProjectionSourceKindCoverage}`,
    `- eventProjectionSourceKindCoverage: ${report.metrics.eventProjectionSourceKindCoverage}`,
    `- taskEventTemporalEdgeCoverageRate: ${report.metrics.taskEventTemporalEdgeCoverageRate}`,
    `- validTimeCoverageRate: ${report.metrics.validTimeCoverageRate}`,
    `- sourceTrailCoverageRate: ${report.metrics.sourceTrailCoverageRate}`,
    `- claimAuditCoverageRate: ${report.metrics.claimAuditCoverageRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Query Rows",
    "",
    ...report.results.map((row) => `- ${row.id}: passed=${row.passed} residual=${row.residualOwner ?? "none"} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} claimAudit=${row.claimAuditCount} sourceKinds=${row.actualSourceKinds.join(",")} answer=${row.answer.slice(0, 180)}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteUniversalTaskEventProjectionPack(): Promise<{
  readonly report: UniversalTaskEventProjectionReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `benchmark_universal_task_event_projection_${stamp.replace(/[^0-9A-Za-z]/gu, "_")}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: QueryRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const projectionRows = await loadProjectionRows(namespaceId);
  const metrics = projectionMetrics(projectionRows, results);
  const report: UniversalTaskEventProjectionReport = {
    generatedAt,
    benchmark: "universal_task_event_projection_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        scenarioCount: results.length,
        projectionRowCount: projectionRows.length
      }
    }),
    namespaceId,
    sampleCount: results.length,
    projectionRowCount: projectionRows.length,
    passed:
      results.every((row) => row.passed) &&
      metrics.taskProjectionSourceKindCoverage === 1 &&
      metrics.eventProjectionSourceKindCoverage === 1 &&
      metrics.sourceUriCoverageRate === 1 &&
      metrics.sourceTrailCoverageRate === 1 &&
      metrics.claimAuditCoverageRate === 1 &&
      metrics.taskEventTemporalEdgeCoverageRate >= 0.95 &&
      metrics.validTimeCoverageRate >= 0.95 &&
      metrics.sourceCaptureTimeCoverageRate >= 0.95 &&
      metrics.parentSourceSectionCoverageRate >= 0.95 &&
      metrics.supportedZeroEvidenceCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    projectionRows,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `universal-task-event-projection-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `universal-task-event-projection-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runUniversalTaskEventProjectionPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteUniversalTaskEventProjectionPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
