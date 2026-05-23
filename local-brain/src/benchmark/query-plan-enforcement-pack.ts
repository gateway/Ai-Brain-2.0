import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_calendar" | "memory.extract_tasks";

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedIntent: string;
  readonly expectedCorpus: string;
  readonly expectedReader?: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly allowSourceMissing?: boolean;
}

interface Row extends Scenario {
  readonly selectedIntent: string | null;
  readonly selectedCorpus: string | null;
  readonly selectedReader: string | null;
  readonly blockedEarlyRoutes: readonly string[];
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly wrongRoute: boolean;
  readonly wrongCorpus: boolean;
  readonly scopeLeak: boolean;
  readonly wrongShape: boolean;
  readonly supportedButBadAnswer: boolean;
  readonly sourceMissing: boolean;
  readonly residualOwner: string;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly passed: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "career_id_carmack",
    toolName: "memory.search",
    query: "What did I do when I worked with id Software and John Carmack?",
    expectedIntent: "career_history",
    expectedCorpus: "career_projection",
    expectedReader: "career_history_trusted_reader",
    expectedTerms: ["id Software", "John Carmack"]
  },
  {
    id: "career_short_roles_dates",
    toolName: "memory.search",
    query: "Give me the short version of my work history with roles and dates.",
    expectedIntent: "career_history",
    expectedCorpus: "career_projection",
    expectedReader: "career_history_trusted_reader",
    expectedTerms: ["work", "role"],
    forbiddenTerms: ["Lauren left Thailand", "mid-to-late July"]
  },
  {
    id: "repo_spec_hybrid_temporal",
    toolName: "memory.search",
    query: "What is the current spec or plan for hybrid temporal memory retrieval?",
    expectedIntent: "document_spec",
    expectedCorpus: "repo_docs",
    expectedReader: "repo_doc_trusted_reader",
    expectedTerms: ["MemoryQueryPlan", "source-bound", "benchmark"]
  },
  {
    id: "procedure_mcp_gold",
    toolName: "memory.search",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    expectedIntent: "procedure_command",
    expectedCorpus: "package_scripts",
    expectedReader: "package_script_trusted_reader",
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain", "package.json"]
  },
  {
    id: "project_scoped_tasks",
    toolName: "memory.extract_tasks",
    query: "What open tasks remain from the hybrid temporal memory retrieval work?",
    expectedIntent: "project_task_scope",
    expectedCorpus: "task_items",
    expectedReader: "project_scoped_task_reader",
    expectedTerms: ["Hybrid Temporal Memory Retrieval"],
    forbiddenTerms: ["Store Jeep", "driver's license", "RV", "Reno", "Iceland"]
  },
  {
    id: "temporal_change_travel",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September travel plans?",
    expectedIntent: "temporal_change",
    expectedCorpus: "temporal_events",
    expectedTerms: ["July", "September"]
  },
  {
    id: "source_audit_chiang_mai_friends",
    toolName: "memory.search",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    expectedIntent: "source_audit",
    expectedCorpus: "source_topic_report",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    forbiddenTerms: ["movie", "red carpet"]
  },
  {
    id: "dan_introduction_place",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Chiang Mai, and where did we meet?",
    expectedIntent: "relationship_friend_set",
    expectedCorpus: "relationship_graph",
    expectedTerms: ["Dan", "Chiang Mai"]
  },
  {
    id: "two_way_work_context",
    toolName: "memory.search",
    query: "What is Two Way and what work am I doing there?",
    expectedIntent: "multi_entity_work_context",
    expectedCorpus: "source_topic_report",
    expectedReader: "multi_lane_project_work_reader",
    expectedTerms: ["Two Way", "Project / org", "My role"]
  },
  {
    id: "current_coffee_preference",
    toolName: "memory.search",
    query: "What coffee do I prefer now?",
    expectedIntent: "direct_fact",
    expectedCorpus: "omi_personal_note",
    expectedTerms: ["coffee"],
    allowSourceMissing: true
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function payloadText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function hasTerm(payload: any, term: string): boolean {
  return payloadText(payload).includes(term.toLowerCase());
}

function metaFromPayload(payload: any): Record<string, any> {
  if (typeof payload?.meta === "object" && payload.meta) return payload.meta;
  if (typeof payload?.retrievalPlan === "object" && payload.retrievalPlan) return payload.retrievalPlan;
  return {};
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
}

function classifyResidual(row: Omit<Row, "residualOwner" | "passed">): string {
  if (row.sourceMissing) return "source_missing";
  if (row.wrongRoute) return "planner_intent_miss";
  if (row.wrongCorpus) return "corpus_capability_miss";
  if (row.scopeLeak) return row.id === "project_scoped_tasks" ? "task_scope_leak" : "route_arbitration_miss";
  if (row.wrongShape) return row.id === "procedure_mcp_gold" ? "document_procedure_shape_miss" : "presenter_shape_miss";
  if (row.supportedButBadAnswer) {
    if (row.id.startsWith("career")) return "career_history_scope_miss";
    if (row.id === "two_way_work_context") return "multi_lane_synthesis_missing";
    return "trusted_reader_missing";
  }
  return "none";
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detailMode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaFromPayload(payload);
  const selectedIntent = typeof meta.memoryQueryPlanIntent === "string" ? meta.memoryQueryPlanIntent : null;
  const selectedCorpus = typeof meta.selectedCorpusCapability === "string" ? meta.selectedCorpusCapability : null;
  const selectedReader = typeof meta.selectedReader === "string" ? meta.selectedReader : null;
  const blockedEarlyRoutes = Array.isArray(meta.blockedEarlyRoutes) ? meta.blockedEarlyRoutes.filter((value: unknown): value is string => typeof value === "string") : [];
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(payload, term));
  const evidenceCount = payloadEvidenceCount(payload);
  const rowBase = {
    ...scenario,
    selectedIntent,
    selectedCorpus,
    selectedReader,
    blockedEarlyRoutes,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : typeof meta.finalClaimSource === "string" ? meta.finalClaimSource : null,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    missingTerms,
    forbiddenHits,
    wrongRoute: selectedIntent !== scenario.expectedIntent,
    wrongCorpus: selectedCorpus !== scenario.expectedCorpus,
    scopeLeak: forbiddenHits.length > 0,
    wrongShape: Boolean(scenario.expectedReader && selectedReader !== scenario.expectedReader),
    supportedButBadAnswer: evidenceCount > 0 && missingTerms.length > 0,
    sourceMissing: evidenceCount === 0,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyResidual(rowBase);
  const sourceMissingAllowed = rowBase.sourceMissing && scenario.allowSourceMissing === true;
  const passed =
    !rowBase.wrongRoute &&
    !rowBase.wrongCorpus &&
    !rowBase.scopeLeak &&
    !rowBase.wrongShape &&
    (missingTerms.length === 0 || sourceMissingAllowed) &&
    (evidenceCount > 0 || sourceMissingAllowed) &&
    rowBase.queryTimeModelCalls === 0;
  return { ...rowBase, residualOwner, passed };
}

function metricsFromRows(rows: readonly Row[]) {
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  return {
    wrongRouteCount: rows.filter((row) => row.wrongRoute).length,
    wrongCorpusCount: rows.filter((row) => row.wrongCorpus).length,
    scopeLeakCount: rows.filter((row) => row.scopeLeak).length,
    docProcedureMissCount: rows.filter((row) => row.residualOwner === "document_procedure_shape_miss").length,
    taskScopeLeakCount: rows.filter((row) => row.residualOwner === "task_scope_leak").length,
    careerHistoryMissCount: rows.filter((row) => row.residualOwner === "career_history_scope_miss").length,
    multiLaneSynthesisMissCount: rows.filter((row) => row.residualOwner === "multi_lane_synthesis_missing").length,
    supportedZeroEvidence: rows.filter((row) => !row.allowSourceMissing && row.evidenceCount === 0).length,
    supportedEmptySourceTrail: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAudit: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: rows.length > 0 ? [...rows].sort((left, right) => left.latencyMs - right.latencyMs)[Math.min(rows.length - 1, Math.floor(rows.length * 0.95))]?.latencyMs ?? 0 : 0,
    maxLatencyMs: rows.reduce((max, row) => Math.max(max, row.latencyMs), 0)
  };
}

function markdownFor(report: any, missLedgerPath: string): string {
  const lines = [
    "# Query Plan Enforcement Pack",
    "",
    `- passed: ${report.passed}`,
    `- wrongRouteCount: ${report.metrics.wrongRouteCount}`,
    `- wrongCorpusCount: ${report.metrics.wrongCorpusCount}`,
    `- scopeLeakCount: ${report.metrics.scopeLeakCount}`,
    `- supportedZeroEvidence: ${report.metrics.supportedZeroEvidence}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- missLedger: ${missLedgerPath}`,
    "",
    "## Rows",
    ...report.results.map((row: Row) => `- ${row.id}: ${row.passed ? "pass" : row.residualOwner}`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteQueryPlanEnforcementPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string; readonly missJsonPath: string; readonly missMarkdownPath: string };
}> {
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    rows.push(await runScenario(scenario));
  }
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows);
  const report = {
    generatedAt,
    benchmark: "query_plan_enforcement_pack",
    sampleCount: rows.length,
    passed:
      rows.every((row) => row.passed) &&
      metrics.wrongRouteCount === 0 &&
      metrics.wrongCorpusCount === 0 &&
      metrics.scopeLeakCount === 0 &&
      metrics.docProcedureMissCount === 0 &&
      metrics.taskScopeLeakCount === 0 &&
      metrics.careerHistoryMissCount === 0 &&
      metrics.multiLaneSynthesisMissCount === 0 &&
      metrics.supportedZeroEvidence === 0 &&
      metrics.supportedEmptySourceTrail === 0 &&
      metrics.supportedMissingClaimAudit === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };
  const missRows = rows.filter((row) => !row.passed);
  const missLedger = {
    generatedAt,
    benchmark: "query_plan_miss_ledger",
    sourcePack: "query_plan_enforcement_pack",
    missCount: missRows.length,
    dominantResidualOwner: missRows[0]?.residualOwner ?? "none",
    results: missRows.map((row) => ({
      query: row.query,
      expectedIntent: row.expectedIntent,
      selectedIntent: row.selectedIntent,
      expectedCorpus: row.expectedCorpus,
      selectedCorpus: row.selectedCorpus,
      selectedReader: row.selectedReader,
      blockedEarlyRoutes: row.blockedEarlyRoutes,
      finalClaimSource: row.finalClaimSource,
      evidenceCount: row.evidenceCount,
      sourceTrailCount: row.sourceTrailCount,
      claimAuditCount: row.claimAuditCount,
      wrongRoute: row.wrongRoute,
      wrongCorpus: row.wrongCorpus,
      scopeLeak: row.scopeLeak,
      wrongShape: row.wrongShape,
      supportedButBadAnswer: row.supportedButBadAnswer,
      sourceMissing: row.sourceMissing,
      residualOwner: row.residualOwner,
      notes: row.missingTerms.length > 0 ? `missing terms: ${row.missingTerms.join(", ")}` : ""
    }))
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `query-plan-enforcement-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `query-plan-enforcement-pack-${stamp}.md`);
  const missJsonPath = path.join(outputDir(), `query-plan-miss-ledger-${stamp}.json`);
  const missMarkdownPath = path.join(outputDir(), `query-plan-miss-ledger-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(missJsonPath, `${JSON.stringify(missLedger, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report, missJsonPath), "utf8");
  await writeFile(
    missMarkdownPath,
    `# Query Plan Miss Ledger\n\n- missCount: ${missLedger.missCount}\n- dominantResidualOwner: ${missLedger.dominantResidualOwner}\n`,
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath, missJsonPath, missMarkdownPath } };
}

export async function runQueryPlanEnforcementPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteQueryPlanEnforcementPack();
    process.stdout.write(
      `${output.jsonPath}\n${output.markdownPath}\n${output.missJsonPath}\n${output.missMarkdownPath}\n${JSON.stringify(
        { passed: report.passed, metrics: report.metrics },
        null,
        2
      )}\n`
    );
  } finally {
    await closePool();
  }
}
