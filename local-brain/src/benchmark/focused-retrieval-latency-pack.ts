import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  answerTextFromPayload,
  hasTerm,
  payloadEvidenceCount,
  queryTimeModelCallsFromPayload,
  rate
} from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_calendar" | "memory.extract_tasks" | "memory.recap";

interface Scenario {
  readonly id: string;
  readonly owner: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly allowSourceMissing?: boolean;
}

interface RunRow extends Scenario {
  readonly iteration: number;
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly selectedReader: string | null;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly stageTimedTotalMs: number | null;
  readonly latencyUnaccountedMs: number | null;
  readonly latencyTelemetryMismatch: boolean;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly passed: boolean;
}

interface LatencyStats {
  readonly count: number;
  readonly p50Ms: number;
  readonly p75Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "source_topic_preset_kitchen_recent",
    owner: "source_topic_sql_hybrid_fallback",
    toolName: "memory.search",
    query: "What have I said about Preset Kitchen recently?",
    expectedTerms: ["Preset Kitchen"],
    allowSourceMissing: true
  },
  {
    id: "calendar_september_2026",
    owner: "calendar_extraction_pipeline",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for September 2026?",
    expectedTerms: ["September"]
  },
  {
    id: "calendar_after_burning_man",
    owner: "calendar_extraction_pipeline",
    toolName: "memory.extract_calendar",
    query: "What was I planning after Burning Man?",
    expectedTerms: ["Burning Man"],
    allowSourceMissing: true
  },
  {
    id: "calendar_mid_late_july",
    owner: "calendar_extraction_pipeline",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    expectedTerms: ["July", "US"]
  },
  {
    id: "calendar_july_september_change",
    owner: "temporal_change_calendar_extraction",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September travel plans?",
    expectedTerms: ["July", "September"]
  },
  {
    id: "tasks_latest_omi_note",
    owner: "task_extraction_pipeline",
    toolName: "memory.extract_tasks",
    query: "What tasks did I mention in my most recent OMI note?",
    expectedTerms: ["task"]
  },
  {
    id: "tasks_recent_travel_open",
    owner: "task_extraction_pipeline",
    toolName: "memory.extract_tasks",
    query: "What tasks are still open from my recent travel planning notes?",
    expectedTerms: ["Store Jeep", "RV", "driver"]
  },
  {
    id: "tasks_hybrid_temporal_project",
    owner: "project_scoped_task_extraction",
    toolName: "memory.extract_tasks",
    query: "What open tasks remain from the hybrid temporal memory retrieval work?",
    expectedTerms: ["Hybrid Temporal Memory Retrieval"],
    forbiddenTerms: ["Store Jeep", "RV", "Reno", "Iceland"]
  },
  {
    id: "friends_chiang_mai",
    owner: "shared_social_graph",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"]
  },
  {
    id: "dan_intro_chiang_mai",
    owner: "shared_social_graph",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Chiang Mai, and where did we meet?",
    expectedTerms: ["Dan", "Chiang Mai"]
  },
  {
    id: "source_audit_chiang_mai_friends",
    owner: "source_audit_binding",
    toolName: "memory.search",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"]
  },
  {
    id: "career_roles_dates",
    owner: "work_history_report_direct_read_model",
    toolName: "memory.search",
    query: "Give me my full work history with roles and dates.",
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "career_id_software_carmack",
    owner: "work_history_report_direct_read_model",
    toolName: "memory.search",
    query: "What did I do when I worked with id Software and John Carmack?",
    expectedTerms: ["id Software", "John Carmack"]
  },
  {
    id: "preference_coffee_now",
    owner: "preference_fact_procedural_truth_timeline",
    toolName: "memory.search",
    query: "What coffee do I prefer now?",
    expectedTerms: ["coffee"]
  },
  {
    id: "preference_spicy_now",
    owner: "preference_fact_procedural_truth_timeline",
    toolName: "memory.search",
    query: "Can I have spicy food now?",
    expectedTerms: ["spicy"]
  },
  {
    id: "repo_hybrid_spec",
    owner: "repo_doc_lookup",
    toolName: "memory.search",
    query: "What is the current spec or plan for hybrid temporal memory retrieval?",
    expectedTerms: ["MemoryQueryPlan", "benchmark"]
  },
  {
    id: "procedure_mcp_gold",
    owner: "procedure_command",
    toolName: "memory.search",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain"]
  },
  {
    id: "projects_two_way_work",
    owner: "multi_lane_project_work",
    toolName: "memory.search",
    query: "What is Two Way and what work am I doing there?",
    expectedTerms: ["Two Way", "Project / org", "My role"]
  },
  {
    id: "projects_active_now",
    owner: "source_topic_report",
    toolName: "memory.search",
    query: "What am I actively building now?",
    expectedTerms: ["AI Brain"]
  },
  {
    id: "multi_gummi_twoway_istanbul",
    owner: "multi_entity_synthesis",
    toolName: "memory.search",
    query: "What do I know about Gummi, Two Way, and the Istanbul trip?",
    expectedTerms: ["Gummi", "Two Way", "Istanbul"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function stats(values: readonly number[]): LatencyStats {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p75Ms: percentile(values, 75),
    p90Ms: percentile(values, 90),
    p95Ms: percentile(values, 95),
    maxMs: Number(Math.max(0, ...values).toFixed(2))
  };
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function metaFromPayload(payload: any): Record<string, any> {
  if (typeof payload?.meta === "object" && payload.meta) return payload.meta;
  if (typeof payload?.retrievalPlan === "object" && payload.retrievalPlan) return payload.retrievalPlan;
  return {};
}

function numberFromMeta(meta: Record<string, any>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function stageTimedTotalMs(meta: Record<string, any>): number | null {
  const explicitTotal = meta.stageTimingsMs?.total;
  if (typeof explicitTotal === "number" && Number.isFinite(explicitTotal)) return Number(explicitTotal.toFixed(2));
  return numberFromMeta(meta, "topStageMs");
}

function finalClaimSource(payload: any): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  return null;
}

async function runScenario(scenario: Scenario, iteration: number): Promise<RunRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaFromPayload(payload);
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const timedTotalMs = stageTimedTotalMs(meta);
  const latencyUnaccountedMs =
    timedTotalMs === null ? null : Number(Math.max(0, latencyMs - timedTotalMs).toFixed(2));
  const evidenceCount = payloadEvidenceCount(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(payload, term));
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const sourceTrailTotal = sourceTrailCount(payload);
  const claimAuditTotal = claimAuditCount(payload);
  const sourceMissingAllowed = scenario.allowSourceMissing === true && evidenceCount === 0;
  const supportedAnswer = evidenceCount > 0;
  return {
    ...scenario,
    iteration,
    finalClaimSource: finalClaimSource(payload),
    queryContract: typeof payload?.queryContract === "string" ? payload.queryContract : typeof meta.queryContractName === "string" ? meta.queryContractName : null,
    selectedReader: typeof meta.selectedReader === "string" ? meta.selectedReader : null,
    dominantStage: typeof meta.dominantStage === "string" ? meta.dominantStage : null,
    topStageMs: numberFromMeta(meta, "topStageMs"),
    stageTimedTotalMs: timedTotalMs,
    latencyUnaccountedMs,
    latencyTelemetryMismatch: timedTotalMs !== null && latencyMs > 1000 && (latencyMs - timedTotalMs) > 500 && timedTotalMs < latencyMs * 0.8,
    stageTimingsMs: typeof meta.stageTimingsMs === "object" && meta.stageTimingsMs ? meta.stageTimingsMs : null,
    evidenceCount,
    sourceTrailCount: sourceTrailTotal,
    claimAuditCount: claimAuditTotal,
    missingTerms,
    forbiddenHits,
    queryTimeModelCalls,
    latencyMs,
    answerPreview: answerTextFromPayload(payload, scenario.toolName).slice(0, 500),
    passed:
      (sourceMissingAllowed || missingTerms.length === 0) &&
      forbiddenHits.length === 0 &&
      queryTimeModelCalls === 0 &&
      (!supportedAnswer || (sourceTrailTotal > 0 && claimAuditTotal > 0)) &&
      timedTotalMs !== null
  };
}

function groupStats(rows: readonly RunRow[], keyFor: (row: RunRow) => string) {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        {
          ...stats(value.map((row) => row.latencyMs)),
          passRate: rate(value.filter((row) => row.passed).length, value.length),
          maxUnaccountedMs: Number(Math.max(0, ...value.map((row) => row.latencyUnaccountedMs ?? 0)).toFixed(2)),
          telemetryMismatchRows: value.filter((row) => row.latencyTelemetryMismatch).length
        }
      ])
  );
}

function markdownFor(report: any): string {
  const lines = [
    "# Focused Retrieval Latency Pack",
    "",
    `- passed: ${report.passed}`,
    `- repeatCount: ${report.repeatCount}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- passRate: ${report.metrics.passRate}`,
    `- p95LatencyMs: ${report.metrics.latency.p95Ms}`,
    `- maxLatencyMs: ${report.metrics.latency.maxMs}`,
    `- missingLatencyTelemetryRows: ${report.metrics.missingLatencyTelemetryRows}`,
    `- latencyTelemetryMismatchRows: ${report.metrics.latencyTelemetryMismatchRows}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Top Slow Rows",
    ...report.topSlowRows.map((row: RunRow) => `- ${row.id}#${row.iteration}: ${row.latencyMs}ms (${row.dominantStage ?? "missing"})`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteFocusedRetrievalLatencyPack(repeatCount = 3): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: RunRow[] = [];
  for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
    for (const scenario of SCENARIOS) {
      process.stderr.write(`[focused-retrieval-latency-pack] ${scenario.id} iteration ${iteration}/${repeatCount}\n`);
      rows.push(await runScenario(scenario, iteration));
    }
  }
  const latency = stats(rows.map((row) => row.latencyMs));
  const metrics = {
    totalRows: rows.length,
    scenarioCount: SCENARIOS.length,
    repeatCount,
    passRate: rate(rows.filter((row) => row.passed).length, rows.length),
    latency,
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0 && !(row.allowSourceMissing && row.evidenceCount === 0)).length,
    forbiddenHitRows: rows.filter((row) => row.forbiddenHits.length > 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    missingLatencyTelemetryRows: rows.filter((row) => !row.stageTimingsMs).length,
    latencyTelemetryMismatchRows: rows.filter((row) => row.latencyTelemetryMismatch).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0)
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "focused_retrieval_latency_pack",
    namespaceId: "personal",
    repeatCount,
    passed:
      rows.every((row) => row.passed) &&
      metrics.latency.p95Ms <= 5000 &&
      metrics.latency.maxMs <= 10000 &&
      metrics.queryTimeModelCalls === 0 &&
      metrics.missingLatencyTelemetryRows === 0 &&
      metrics.latencyTelemetryMismatchRows === 0,
    budgets: {
      p95LatencyMs: 5000,
      maxLatencyMs: 10000,
      queryTimeModelCalls: 0,
      missingLatencyTelemetryRows: 0,
      latencyTelemetryMismatchRows: 0
    },
    metrics,
    byScenario: groupStats(rows, (row) => row.id),
    byOwner: groupStats(rows, (row) => row.owner),
    byDominantStage: groupStats(rows, (row) => row.dominantStage ?? "missing"),
    topSlowRows: [...rows].sort((left, right) => right.latencyMs - left.latencyMs).slice(0, 12),
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `focused-retrieval-latency-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `focused-retrieval-latency-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runFocusedRetrievalLatencyPackCli(): Promise<void> {
  try {
    const repeatCount = Number.parseInt(process.env.BRAIN_RETRIEVAL_LATENCY_REPEAT_COUNT ?? "3", 10);
    const normalizedRepeatCount = Number.isFinite(repeatCount) && repeatCount > 0 ? repeatCount : 3;
    const { report, output } = await runAndWriteFocusedRetrievalLatencyPack(normalizedRepeatCount);
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
