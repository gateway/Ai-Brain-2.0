import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { hasTerm, payloadEvidenceCount, percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ToolName = "memory.extract_tasks" | "memory.extract_calendar";
type ExpectedMode = "supported" | "clarification" | "abstention";

interface Scenario {
  readonly id: string;
  readonly namespaceId: "personal" | "multi_source_fixture";
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedMode: ExpectedMode;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly expectedScopeMode?: "source_scope" | "event_window_scope" | "lifecycle_scope";
  readonly requiresEventWindow?: boolean;
  readonly expectsNoTasks?: boolean;
}

interface Row extends Scenario {
  readonly actualNamespaceId: string;
  readonly answer: string;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly itemCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly wrongTemporalScope: boolean;
  readonly usedEventWindow: boolean;
  readonly usedCapturedAtOnly: boolean;
  readonly ambiguousClarification: boolean;
  readonly taskScopeLeak: boolean;
  readonly staleOpenLeak: boolean;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: "none" | "missing_terms" | "wrong_temporal_scope" | "missing_clarification" | "task_scope_leak" | "stale_open_leak" | "source_trail_missing" | "claim_audit_missing" | "query_time_model_call";
  readonly passed: boolean;
}

export interface TemporalAmbiguityHardQueryReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_ambiguity_hard_query_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly personalNamespaceId: "personal";
  readonly multiSourceNamespaceId: string;
  readonly multiSourceArtifactPath: string;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly wrongTemporalScopeCount: number;
    readonly ambiguousMonthClarificationRate: number;
    readonly eventWindowFilterRate: number;
    readonly taskScopeLeakCount: number;
    readonly staleOpenLeakCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly Row[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "ambiguous_july_tasks",
    namespaceId: "personal",
    toolName: "memory.extract_tasks",
    query: "What do I need to do in July?",
    expectedMode: "clarification",
    expectedTerms: ["Which July", "July 2026"],
    expectedScopeMode: "lifecycle_scope",
    expectsNoTasks: true
  },
  {
    id: "clarification_prompt_july",
    namespaceId: "personal",
    toolName: "memory.extract_tasks",
    query: "Which July do you mean?",
    expectedMode: "clarification",
    expectedTerms: ["Which July", "another July", "all July mentions"],
    expectedScopeMode: "lifecycle_scope",
    expectsNoTasks: true
  },
  {
    id: "july_september_change",
    namespaceId: "personal",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September plans?",
    expectedMode: "supported",
    expectedTerms: ["July", "September", "Iceland"],
    expectedScopeMode: "event_window_scope",
    requiresEventWindow: true
  },
  {
    id: "recent_travel_open_tasks",
    namespaceId: "personal",
    toolName: "memory.extract_tasks",
    query: "What tasks are still open from recent travel planning notes?",
    expectedMode: "supported",
    expectedTerms: ["RV", "Jeep", "driver"],
    forbiddenTerms: ["query contract", "MCP Studio", "projection audit"],
    expectedScopeMode: "lifecycle_scope"
  },
  {
    id: "summer_mentions",
    namespaceId: "personal",
    toolName: "memory.extract_calendar",
    query: "What did I mention for this summer?",
    expectedMode: "supported",
    expectedTerms: ["mid-to-late July", "US"],
    expectedScopeMode: "event_window_scope",
    requiresEventWindow: true
  },
  {
    id: "project_notes_due_next_week",
    namespaceId: "personal",
    toolName: "memory.extract_tasks",
    query: "What is due next week from my project notes?",
    expectedMode: "abstention",
    expectedTerms: ["No task items"],
    forbiddenTerms: ["figure out how to slow down", "do on my task list"],
    expectedScopeMode: "lifecycle_scope",
    expectsNoTasks: true
  },
  {
    id: "cross_source_calendar_dates",
    namespaceId: "multi_source_fixture",
    toolName: "memory.extract_calendar",
    query: "What dates should go on my calendar from PDFs or Codex notes?",
    expectedMode: "supported",
    expectedTerms: ["Bangkok AI model meetup", "2026-06-15", "AI memory PDF review"],
    expectedScopeMode: "event_window_scope",
    requiresEventWindow: true
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function payloadText(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

function sourceTrailCount(payload: any): number {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((commitment: any) => (Array.isArray(commitment?.sourceTrail) ? commitment.sourceTrail : []))
    : [];
  return [...topLevel, ...tasks, ...commitments].length;
}

function itemCountForPayload(toolName: ToolName, payload: any): number {
  return toolName === "memory.extract_tasks"
    ? Array.isArray(payload?.tasks) ? payload.tasks.length : 0
    : Array.isArray(payload?.commitments) ? payload.commitments.length : 0;
}

function answerFromPayload(payload: any): string {
  return String(payload?.humanReadable?.answer ?? payload?.answer ?? "");
}

function metaForPayload(payload: any): Record<string, unknown> {
  return payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
}

function classifyResidual(row: Omit<Row, "residualOwner" | "passed">): Row["residualOwner"] {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (row.wrongTemporalScope) return "wrong_temporal_scope";
  if (row.expectedMode === "clarification" && !row.ambiguousClarification) return "missing_clarification";
  if (row.taskScopeLeak) return "task_scope_leak";
  if (row.staleOpenLeak) return "stale_open_leak";
  if (row.missingTerms.length > 0) return "missing_terms";
  if (row.expectedMode === "supported" && row.sourceTrailCount === 0) return "source_trail_missing";
  if (row.expectedMode === "supported" && row.claimAuditCount === 0) return "claim_audit_missing";
  return "none";
}

async function runScenario(scenario: Scenario, multiSourceNamespaceId: string): Promise<Row> {
  const namespaceId = scenario.namespaceId === "personal" ? "personal" : multiSourceNamespaceId;
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "compact",
    reference_now: "2026-06-01T00:00:00.000Z",
    limit: 10
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaForPayload(payload);
  const text = payloadText(payload);
  const answer = answerFromPayload(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term) && !hasTerm(answer, term));
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(text, term));
  const itemCount = itemCountForPayload(scenario.toolName, payload);
  const usedEventWindow = meta.usedEventWindow === true || meta.scopeMode === "event_window_scope" || meta.memoryQueryPlanTimeWindow !== null;
  const usedCapturedAtOnly = meta.usedCapturedAtOnly === true;
  const actualScopeMode = typeof meta.scopeMode === "string" ? meta.scopeMode : null;
  const ambiguousClarification = payload.followUpAction === "route_to_clarifications" || /which\s+july/iu.test(answer) || meta.temporalClarificationRequired === true;
  const wrongTemporalScope = Boolean(
    (scenario.expectedScopeMode && actualScopeMode && actualScopeMode !== scenario.expectedScopeMode) ||
      (scenario.requiresEventWindow && !usedEventWindow) ||
      (scenario.requiresEventWindow && usedCapturedAtOnly)
  );
  const taskScopeLeak = forbiddenHits.length > 0;
  const staleOpenLeak =
    scenario.toolName === "memory.extract_tasks" &&
    Array.isArray(payload.tasks) &&
    payload.tasks.some((task: any) => task?.lifecycleStatus === "stale_open" || /\bstale\b/iu.test(`${task?.title ?? ""} ${task?.description ?? ""}`));
  const rowBase = {
    ...scenario,
    actualNamespaceId: namespaceId,
    answer,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    itemCount,
    missingTerms,
    forbiddenHits,
    wrongTemporalScope,
    usedEventWindow,
    usedCapturedAtOnly,
    ambiguousClarification,
    taskScopeLeak,
    staleOpenLeak,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyResidual(rowBase);
  const passed =
    residualOwner === "none" &&
    (scenario.expectedMode !== "supported" || rowBase.evidenceCount > 0) &&
    (!scenario.expectsNoTasks || itemCount === 0);
  return {
    ...rowBase,
    residualOwner,
    passed
  };
}

function markdown(report: TemporalAmbiguityHardQueryReport): string {
  return [
    "# Temporal Ambiguity Hard Query Pack",
    "",
    `- passed: ${report.passed}`,
    `- multiSourceNamespaceId: ${report.multiSourceNamespaceId}`,
    `- wrongTemporalScopeCount: ${report.metrics.wrongTemporalScopeCount}`,
    `- ambiguousMonthClarificationRate: ${report.metrics.ambiguousMonthClarificationRate}`,
    `- eventWindowFilterRate: ${report.metrics.eventWindowFilterRate}`,
    `- taskScopeLeakCount: ${report.metrics.taskScopeLeakCount}`,
    `- staleOpenLeakCount: ${report.metrics.staleOpenLeakCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Rows",
    "",
    ...report.results.map((row) => `- ${row.id}: passed=${row.passed} residual=${row.residualOwner} evidence=${row.evidenceCount} sources=${row.sourceTrailCount} items=${row.itemCount} missing=${row.missingTerms.join("|") || "none"} answer="${row.answer.slice(0, 220)}"`),
    ""
  ].join("\n");
}

export async function runAndWriteTemporalAmbiguityHardQueryPack(): Promise<{
  readonly report: TemporalAmbiguityHardQueryReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const multiSource = await runAndWriteMultiSourceIngestionPack();
  const multiSourceNamespaceId = multiSource.report.namespaceId;
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    rows.push(await runScenario(scenario, multiSourceNamespaceId));
  }
  const clarificationRows = rows.filter((row) => row.expectedMode === "clarification");
  const eventRows = rows.filter((row) => row.requiresEventWindow === true);
  const supportedRows = rows.filter((row) => row.expectedMode === "supported");
  const metrics = {
    wrongTemporalScopeCount: rows.filter((row) => row.wrongTemporalScope).length,
    ambiguousMonthClarificationRate: rate(clarificationRows.filter((row) => row.ambiguousClarification).length, clarificationRows.length),
    eventWindowFilterRate: rate(eventRows.filter((row) => row.usedEventWindow && !row.usedCapturedAtOnly).length, eventRows.length),
    taskScopeLeakCount: rows.filter((row) => row.taskScopeLeak).length,
    staleOpenLeakCount: rows.filter((row) => row.staleOpenLeak).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
  const report: TemporalAmbiguityHardQueryReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_ambiguity_hard_query_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        personalRows: rows.filter((row) => row.actualNamespaceId === "personal").length,
        multiSourceNamespaceId
      }
    }),
    personalNamespaceId: "personal",
    multiSourceNamespaceId,
    multiSourceArtifactPath: multiSource.output.jsonPath,
    sampleCount: rows.length,
    passed:
      rows.every((row) => row.passed) &&
      metrics.wrongTemporalScopeCount === 0 &&
      metrics.ambiguousMonthClarificationRate === 1 &&
      metrics.eventWindowFilterRate === 1 &&
      metrics.taskScopeLeakCount === 0 &&
      metrics.staleOpenLeakCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `temporal-ambiguity-hard-query-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-ambiguity-hard-query-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalAmbiguityHardQueryPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalAmbiguityHardQueryPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
