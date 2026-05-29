import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import type { SourceType } from "../types.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

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
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms: readonly string[];
  readonly expectedEvidenceKinds: readonly string[];
  readonly expectAbstention?: boolean;
}

interface QueryRow extends Scenario {
  readonly answer: string;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly taskCount: number;
  readonly queryTimeModelCalls: number;
  readonly eventWindowBeforeTaskSelection: boolean;
  readonly taskEventLinkDecision: string | null;
  readonly taskEventLinkEvidenceKind: readonly string[];
  readonly taskEventLinkedTaskCount: number;
  readonly taskEventContextEventCount: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
  readonly passed: boolean;
}

interface TaskEventLinkingReport {
  readonly generatedAt: string;
  readonly benchmark: "task_event_linking_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly taskEventLinkAccuracy: number;
    readonly taskEventScopeLeakCount: number;
    readonly categoryLabelTaskFalsePositiveCount: number;
    readonly eventWindowBeforeTaskSelectionRate: number;
    readonly temporalEdgeLinkCoverageRate: number;
    readonly parentChildContextRecoveryRate: number;
    readonly typedAbstentionPassRate: number;
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "task-event-linking-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "omi-archive/normalized/2026/05/29/2026-05-29T09-00-00Z__omi__task_event.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T09:00:00.000Z",
      body: [
        "# OMI task event note",
        "",
        "I mentioned a US trip to San Francisco in mid to late July 2026.",
        "Action item: call the airline about July baggage rules before the US trip.",
        "Action item: renew travel insurance before San Francisco.",
        "Unrelated action item: update MCP gold docs."
      ].join("\n"),
      metadata: {
        source_kind_family: "omi",
        relative_path: "omi-archive/normalized/2026/05/29/2026-05-29T09-00-00Z__omi__task_event.md"
      }
    },
    {
      relativePath: "notes/2026-05-29-september-travel.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T09:05:00.000Z",
      body: [
        "# September travel note",
        "",
        "After Burning Man I plan Iceland travel in early September 2026.",
        "Task: book Iceland lodging and confirm September flight.",
        "Task: finish projection audit for unrelated benchmark work."
      ].join("\n"),
      metadata: {
        source_kind_family: "markdown_note",
        relative_path: "notes/2026-05-29-september-travel.md"
      }
    },
    {
      relativePath: "pdfs/ai-memory-review.pdf",
      sourceType: "pdf",
      capturedAt: "2026-05-29T09:10:00.000Z",
      body: "%PDF-1.4\n% task event placeholder\n",
      sidecarText: [
        "AI memory PDF review.",
        "The AI memory PDF review is scheduled for June 21, 2026.",
        "Action item: add parent section source audit for the AI memory PDF review.",
        "Task: verify temporal memory PDF review notes."
      ].join("\n"),
      metadata: {
        source_kind_family: "pdf_document",
        relative_path: "pdfs/ai-memory-review.pdf"
      }
    },
    {
      relativePath: "exports/tasks/generic-labels.json",
      sourceType: "task_list",
      capturedAt: "2026-05-29T09:15:00.000Z",
      body: JSON.stringify(
        {
          tasks: [
            { title: "Tasks", status: "open" },
            { title: "Action items", status: "open" },
            { title: "Finish unrelated database cleanup", status: "open", due: "2026-07-18" }
          ]
        },
        null,
        2
      ),
      metadata: {
        source_kind_family: "task_export",
        relative_path: "exports/tasks/generic-labels.json"
      }
    },
    {
      relativePath: "notes/2026-05-29-no-task-event.md",
      sourceType: "markdown",
      capturedAt: "2026-05-29T09:20:00.000Z",
      body: [
        "# Event without task",
        "",
        "The quiet planning check-in is on August 12, 2026.",
        "There are no action items for that check-in."
      ].join("\n"),
      metadata: {
        source_kind_family: "markdown_note",
        relative_path: "notes/2026-05-29-no-task-event.md"
      }
    }
  ];
}

function rawOmiConversation(): string {
  return JSON.stringify(
    {
      started_at: "2026-05-29T09:00:00.000Z",
      finished_at: "2026-05-29T09:04:00.000Z",
      structured: {
        action_items: [
          {
            description: "Call the airline about July baggage rules before the US trip.",
            completed: false,
            created_at: "2026-05-29T09:01:00.000Z",
            due_at: "2026-07-10"
          },
          {
            description: "Renew travel insurance before San Francisco.",
            completed: false,
            created_at: "2026-05-29T09:02:00.000Z",
            due_at: "2026-07-11"
          }
        ],
        events: [
          {
            title: "US trip to San Francisco",
            description: "US trip to San Francisco in mid to late July 2026.",
            start: "2026-07-15",
            end: "2026-07-28",
            created: true,
            location: "San Francisco"
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
  const rawPath = path.join(rootPath, "omi-archive/raw/2026/05/29/2026-05-29T09-00-00Z__omi__task_event.json");
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
      sourceChannel: "benchmark:task_event_linking_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      skipExternalRelationCandidates: true,
      skipVectorActivation: true,
      metadata: {
        benchmark: "task_event_linking_pack",
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
      id: "july_travel_tasks",
      query: "What tasks are tied to July travel?",
      expectedTerms: ["airline", "travel insurance"],
      forbiddenTerms: ["MCP gold", "projection audit", "database cleanup"],
      expectedEvidenceKinds: ["temporal_edge"]
    },
    {
      id: "before_us_trip_tasks",
      query: "What do I need to do before my US trip?",
      expectedTerms: ["airline", "travel insurance"],
      forbiddenTerms: ["MCP gold", "projection audit", "database cleanup"],
      expectedEvidenceKinds: ["temporal_edge"]
    },
    {
      id: "september_travel_tasks",
      query: "What tasks are connected to September travel?",
      expectedTerms: ["Iceland lodging", "September flight"],
      forbiddenTerms: ["airline", "MCP gold", "projection audit", "database cleanup"],
      expectedEvidenceKinds: ["temporal_edge"]
    },
    {
      id: "pdf_review_tasks",
      query: "What open tasks are connected to the AI memory PDF review?",
      expectedTerms: ["parent section source audit", "temporal memory PDF"],
      forbiddenTerms: ["airline", "projection audit", "database cleanup"],
      expectedEvidenceKinds: ["parent_source_section", "temporal_edge"]
    },
    {
      id: "travel_change_tasks",
      query: "What changed about my July and September travel plans, and what do I need to do?",
      expectedTerms: ["airline", "travel insurance", "Iceland lodging", "September flight"],
      forbiddenTerms: ["MCP gold", "projection audit", "database cleanup"],
      expectedEvidenceKinds: ["temporal_edge"]
    },
    {
      id: "event_without_tasks_abstention",
      query: "What tasks are connected to the quiet planning check-in?",
      expectedTerms: [],
      forbiddenTerms: ["database cleanup", "airline", "Iceland lodging"],
      expectedEvidenceKinds: [],
      expectAbstention: true
    }
  ];
}

function payloadText(payload: any): string {
  return JSON.stringify(payload ?? null);
}

function answerText(payload: any): string {
  if (typeof payload?.answer === "string") return payload.answer;
  if (Array.isArray(payload?.tasks)) return payload.tasks.map((task: any) => `${task.title ?? ""} ${task.description ?? ""}`).filter(Boolean).join("; ");
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  return "";
}

function answerHasTerm(answer: string, term: string): boolean {
  return answer.toLowerCase().includes(term.toLowerCase());
}

function sourceTrailEntries(payload: any): readonly any[] {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  return [...topLevel, ...tasks];
}

function evidenceCount(payload: any): number {
  if (typeof payload?.evidenceCount === "number") return payload.evidenceCount;
  if (Array.isArray(payload?.evidence)) return payload.evidence.length;
  if (Array.isArray(payload?.tasks)) return payload.tasks.length;
  return 0;
}

function classifyQueryRow(row: Omit<QueryRow, "residualOwner" | "passed">): string | null {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (!row.eventWindowBeforeTaskSelection) return "event_window_not_resolved_first";
  if (!row.expectAbstention && row.evidenceCount === 0) return "unsupported_no_evidence";
  if (!row.expectAbstention && row.sourceTrailCount === 0) return "empty_source_trail";
  if (!row.expectAbstention && row.claimAuditCount === 0) return "missing_claim_audit";
  if (row.forbiddenHits.length > 0) return "task_event_scope_leak";
  if (row.answer.match(/\b(?:Tasks|Action items)\b/iu) && row.taskCount <= 2 && row.missingTerms.length > 0) return "category_label_false_positive";
  if (row.expectAbstention) return row.taskCount === 0 && row.taskEventLinkDecision === "event_context_without_linked_task_support" ? null : "typed_abstention_miss";
  if (row.missingTerms.length > 0) return "missing_linked_task_terms";
  if (row.taskEventLinkedTaskCount === 0) return "linked_task_count_zero";
  if (!row.expectedEvidenceKinds.every((kind) => row.taskEventLinkEvidenceKind.includes(kind))) return "missing_link_evidence_kind";
  return null;
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<QueryRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.extract_tasks", {
    namespace_id: namespaceId,
    query: scenario.query,
    detailMode: "full",
    detail_mode: "full",
    referenceNow: "2026-05-29T09:30:00.000Z",
    reference_now: "2026-05-29T09:30:00.000Z",
    limit: 12
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const retrievalPlan = payload.retrievalPlan ?? {};
  const answer = answerText(payload);
  const rowBase = {
    ...scenario,
    answer,
    evidenceCount: evidenceCount(payload),
    sourceTrailCount: sourceTrailEntries(payload).length,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    missingTerms: scenario.expectedTerms.filter((term) => !answerHasTerm(answer, term)),
    forbiddenHits: scenario.forbiddenTerms.filter((term) => answerHasTerm(answer, term)),
    taskCount: Array.isArray(payload.tasks) ? payload.tasks.length : 0,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    eventWindowBeforeTaskSelection: retrievalPlan.eventWindowBeforeTaskSelection === true,
    taskEventLinkDecision: typeof retrievalPlan.taskEventLinkDecision === "string" ? retrievalPlan.taskEventLinkDecision : null,
    taskEventLinkEvidenceKind: Array.isArray(retrievalPlan.taskEventLinkEvidenceKind)
      ? retrievalPlan.taskEventLinkEvidenceKind.filter((value: unknown): value is string => typeof value === "string")
      : [],
    taskEventLinkedTaskCount: typeof retrievalPlan.taskEventLinkedTaskCount === "number" ? retrievalPlan.taskEventLinkedTaskCount : 0,
    taskEventContextEventCount: typeof retrievalPlan.taskEventContextEventCount === "number" ? retrievalPlan.taskEventContextEventCount : 0,
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyQueryRow(rowBase);
  return { ...rowBase, residualOwner, passed: residualOwner === null };
}

function metrics(rows: readonly QueryRow[]): TaskEventLinkingReport["metrics"] {
  const supported = rows.filter((row) => !row.expectAbstention);
  return {
    taskEventLinkAccuracy: rate(rows.filter((row) => row.passed).length, rows.length),
    taskEventScopeLeakCount: rows.filter((row) => row.forbiddenHits.length > 0).length,
    categoryLabelTaskFalsePositiveCount: rows.filter((row) => row.residualOwner === "category_label_false_positive").length,
    eventWindowBeforeTaskSelectionRate: rate(rows.filter((row) => row.eventWindowBeforeTaskSelection).length, rows.length),
    temporalEdgeLinkCoverageRate: rate(supported.filter((row) => row.taskEventLinkEvidenceKind.includes("temporal_edge")).length, supported.length),
    parentChildContextRecoveryRate: rate(rows.filter((row) => row.id !== "pdf_review_tasks" || row.taskEventLinkEvidenceKind.includes("parent_source_section")).length, rows.length),
    typedAbstentionPassRate: rate(rows.filter((row) => !row.expectAbstention || row.passed).length, rows.length),
    supportedZeroEvidenceCount: supported.filter((row) => row.evidenceCount === 0).length,
    supportedEmptySourceTrailCount: supported.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supported.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
}

function markdownReport(report: TaskEventLinkingReport): string {
  return [
    "# Task Event Linking Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- taskEventLinkAccuracy: ${report.metrics.taskEventLinkAccuracy}`,
    `- taskEventScopeLeakCount: ${report.metrics.taskEventScopeLeakCount}`,
    `- eventWindowBeforeTaskSelectionRate: ${report.metrics.eventWindowBeforeTaskSelectionRate}`,
    `- temporalEdgeLinkCoverageRate: ${report.metrics.temporalEdgeLinkCoverageRate}`,
    `- parentChildContextRecoveryRate: ${report.metrics.parentChildContextRecoveryRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Query Rows",
    "",
    ...report.results.map(
      (row) =>
        `- ${row.id}: passed=${row.passed} residual=${row.residualOwner ?? "none"} tasks=${row.taskCount} evidence=${row.evidenceCount} kinds=${row.taskEventLinkEvidenceKind.join(",")} decision=${row.taskEventLinkDecision ?? "none"} answer=${row.answer.slice(0, 180)}`
    ),
    ""
  ].join("\n");
}

export async function runAndWriteTaskEventLinkingPack(): Promise<{
  readonly report: TaskEventLinkingReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `benchmark_task_event_linking_${stamp.replace(/[^0-9A-Za-z]/gu, "_")}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: QueryRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const computedMetrics = metrics(results);
  const report: TaskEventLinkingReport = {
    generatedAt,
    benchmark: "task_event_linking_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        scenarioCount: results.length
      }
    }),
    namespaceId,
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      computedMetrics.taskEventLinkAccuracy >= 0.95 &&
      computedMetrics.taskEventScopeLeakCount === 0 &&
      computedMetrics.categoryLabelTaskFalsePositiveCount === 0 &&
      computedMetrics.eventWindowBeforeTaskSelectionRate === 1 &&
      computedMetrics.temporalEdgeLinkCoverageRate >= 0.95 &&
      computedMetrics.parentChildContextRecoveryRate >= 0.95 &&
      computedMetrics.supportedZeroEvidenceCount === 0 &&
      computedMetrics.supportedEmptySourceTrailCount === 0 &&
      computedMetrics.supportedMissingClaimAuditCount === 0 &&
      computedMetrics.queryTimeModelCalls === 0,
    metrics: computedMetrics,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `task-event-linking-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `task-event-linking-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdownReport(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTaskEventLinkingPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTaskEventLinkingPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
