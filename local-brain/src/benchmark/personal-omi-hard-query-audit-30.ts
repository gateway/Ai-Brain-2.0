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
type ResidualOwner =
  | "none"
  | "source_missing"
  | "wrong_route"
  | "wrong_corpus"
  | "scope_leak"
  | "missing_expected_terms"
  | "empty_source_trail"
  | "missing_claim_audit"
  | "presenter_shape"
  | "latency_tail";

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedFamily: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly expectedQueryContract?: string;
  readonly expectedFinalClaimSource?: string;
  readonly allowSourceMissing?: boolean;
  readonly maxLatencyMs?: number;
}

interface Row extends Scenario {
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly selectedIntent: string | null;
  readonly selectedCorpus: string | null;
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
  readonly answerPreview: string;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly quality: "strong" | "acceptable" | "weak" | "source_missing";
  readonly residualOwner: ResidualOwner;
  readonly passed: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "relationship_place_friends_chiang_mai",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    expectedFamily: "relationship",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"],
    forbiddenTerms: ["Arrange", "Attend Burning", "Jeep", "Sign", "Twisp", "Washington"]
  },
  {
    id: "relationship_dan_intro_where",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Chiang Mai, and where did we meet?",
    expectedFamily: "relationship",
    expectedTerms: ["Dan", "Chiang Mai"]
  },
  {
    id: "relationship_shared_no_generic_map",
    toolName: "memory.search",
    query: "Who are all of mine and Dan's friends, and do not fall back to a generic relationship map?",
    expectedFamily: "relationship",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    forbiddenTerms: ["generic relationship map"]
  },
  {
    id: "source_audit_chiang_mai_friend_set",
    toolName: "memory.search",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    expectedFamily: "source_audit",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    expectedFinalClaimSource: "source_audit",
    forbiddenTerms: ["Arrange", "Attend Burning", "Jeep", "Sign", "Twisp", "Washington"]
  },
  {
    id: "travel_mid_late_july",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    expectedFamily: "temporal",
    expectedTerms: ["July", "US"]
  },
  {
    id: "travel_september_2026",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for September 2026?",
    expectedFamily: "temporal",
    expectedTerms: ["September"]
  },
  {
    id: "travel_change_july_september",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September travel plans?",
    expectedFamily: "temporal_change",
    expectedTerms: ["July", "September"],
    maxLatencyMs: 10000
  },
  {
    id: "travel_after_burning_man",
    toolName: "memory.extract_calendar",
    query: "What was I planning after Burning Man?",
    expectedFamily: "temporal",
    expectedTerms: ["Burning Man"],
    allowSourceMissing: true
  },
  {
    id: "tasks_latest_omi_note",
    toolName: "memory.extract_tasks",
    query: "What tasks did I mention in my most recent OMI note?",
    expectedFamily: "task",
    expectedTerms: ["task"]
  },
  {
    id: "tasks_recent_travel_open",
    toolName: "memory.extract_tasks",
    query: "What tasks are still open from my recent travel planning notes?",
    expectedFamily: "task",
    expectedTerms: ["Store Jeep", "RV", "driver"]
  },
  {
    id: "tasks_travel_source_audit",
    toolName: "memory.search",
    query: "Where did those travel tasks come from: Store Jeep, RV, and driver's license?",
    expectedFamily: "source_audit",
    expectedTerms: ["Store Jeep", "RV", "driver"],
    expectedQueryContract: "source_audit",
    expectedFinalClaimSource: "source_audit",
    forbiddenTerms: ["You went to", "destination"]
  },
  {
    id: "tasks_hybrid_temporal_project",
    toolName: "memory.extract_tasks",
    query: "What open tasks remain from the hybrid temporal memory retrieval work?",
    expectedFamily: "task",
    expectedTerms: ["Hybrid Temporal Memory Retrieval"],
    forbiddenTerms: ["Store Jeep", "RV", "Reno", "Iceland"]
  },
  {
    id: "projects_active_now",
    toolName: "memory.search",
    query: "What am I actively building now?",
    expectedFamily: "source_topic",
    expectedTerms: ["AI Brain"]
  },
  {
    id: "projects_two_way_work",
    toolName: "memory.search",
    query: "What is Two Way and what work am I doing there?",
    expectedFamily: "project",
    expectedTerms: ["Two Way", "Project / org", "My role"]
  },
  {
    id: "projects_2way_recent",
    toolName: "memory.search",
    query: "Summarize what I mentioned about 2Way recently.",
    expectedFamily: "source_topic",
    expectedTerms: ["2Way"]
  },
  {
    id: "projects_memoir_engine_recent",
    toolName: "memory.search",
    query: "Summarize what I mentioned about Memoir Engine recently.",
    expectedFamily: "source_topic",
    expectedTerms: ["Memoir Engine"]
  },
  {
    id: "projects_preset_kitchen_recent",
    toolName: "memory.search",
    query: "What have I said about Preset Kitchen recently?",
    expectedFamily: "source_topic",
    expectedTerms: ["Preset Kitchen"],
    allowSourceMissing: true
  },
  {
    id: "career_full_roles_dates",
    toolName: "memory.search",
    query: "Give me my full work history with roles and dates.",
    expectedFamily: "career",
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "career_companies_worked_for",
    toolName: "memory.search",
    query: "What companies have I worked for?",
    expectedFamily: "career",
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "career_id_software_carmack",
    toolName: "memory.search",
    query: "What did I do when I worked with id Software and John Carmack?",
    expectedFamily: "career",
    expectedTerms: ["id Software", "John Carmack"]
  },
  {
    id: "career_two_way_well_inked_roles",
    toolName: "memory.search",
    query: "What roles have I had at Two-Way and Well Inked?",
    expectedFamily: "career",
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "preference_coffee_now",
    toolName: "memory.search",
    query: "What coffee do I prefer now?",
    expectedFamily: "preference",
    expectedTerms: ["coffee"]
  },
  {
    id: "preference_peanuts_constraint",
    toolName: "memory.search",
    query: "Can I have peanuts for dinner?",
    expectedFamily: "preference_constraint",
    expectedTerms: ["peanuts"]
  },
  {
    id: "preference_spicy_historical",
    toolName: "memory.search",
    query: "Did I use to like spicy food?",
    expectedFamily: "temporal_preference",
    expectedTerms: ["spicy"]
  },
  {
    id: "preference_spicy_now",
    toolName: "memory.search",
    query: "Can I have spicy food now?",
    expectedFamily: "preference",
    expectedTerms: ["spicy"]
  },
  {
    id: "source_project_list",
    toolName: "memory.search",
    query: "Where did the current project list come from?",
    expectedFamily: "source_audit",
    expectedTerms: ["source"],
    allowSourceMissing: true
  },
  {
    id: "repo_hybrid_spec",
    toolName: "memory.search",
    query: "What is the current spec or plan for hybrid temporal memory retrieval?",
    expectedFamily: "repo_doc",
    expectedTerms: ["MemoryQueryPlan", "benchmark"]
  },
  {
    id: "procedure_mcp_gold",
    toolName: "memory.search",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    expectedFamily: "procedure",
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain"]
  },
  {
    id: "procedure_production_readiness",
    toolName: "memory.search",
    query: "How do I run production readiness?",
    expectedFamily: "procedure",
    expectedTerms: ["benchmark:production-readiness"]
  },
  {
    id: "multi_gummi_twoway_istanbul",
    toolName: "memory.search",
    query: "What do I know about Gummi, Two Way, and the Istanbul trip?",
    expectedFamily: "multi_entity",
    expectedTerms: ["Gummi", "Two Way", "Istanbul"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
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

function finalClaimSource(payload: any): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  return null;
}

function numberFromMeta(meta: Record<string, any>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function stageTimedTotalMs(meta: Record<string, any>): number | null {
  const explicitTotal = meta.stageTimingsMs?.total;
  if (typeof explicitTotal === "number" && Number.isFinite(explicitTotal)) {
    return Number(explicitTotal.toFixed(2));
  }
  return numberFromMeta(meta, "topStageMs");
}

function latencyUnaccountedMs(latencyMs: number, timedTotalMs: number | null): number | null {
  if (timedTotalMs === null) {
    return null;
  }
  return Number(Math.max(0, latencyMs - timedTotalMs).toFixed(2));
}

function hasLatencyTelemetryMismatch(latencyMs: number, timedTotalMs: number | null): boolean {
  if (timedTotalMs === null) {
    return false;
  }
  const unaccountedMs = latencyMs - timedTotalMs;
  return latencyMs > 1000 && unaccountedMs > 500 && timedTotalMs < latencyMs * 0.8;
}

function classifyQuality(params: {
  readonly scenario: Scenario;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
}): Row["quality"] {
  if (params.evidenceCount === 0) return "source_missing";
  if (params.missingTerms.length === 0 && params.forbiddenHits.length === 0 && params.sourceTrailCount > 0 && params.claimAuditCount > 0 && params.queryTimeModelCalls === 0) {
    return params.scenario.maxLatencyMs && params.latencyMs > params.scenario.maxLatencyMs ? "acceptable" : "strong";
  }
  if (params.missingTerms.length <= 1 && params.forbiddenHits.length === 0 && params.sourceTrailCount > 0 && params.queryTimeModelCalls === 0) return "acceptable";
  return "weak";
}

function classifyResidual(params: {
  readonly scenario: Scenario;
  readonly quality: Row["quality"];
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
}): ResidualOwner {
  if (params.quality === "strong" || params.quality === "acceptable") {
    if (params.scenario.maxLatencyMs && params.latencyMs > params.scenario.maxLatencyMs) return "latency_tail";
    return "none";
  }
  if (params.evidenceCount === 0) return "source_missing";
  if (params.forbiddenHits.length > 0) return "scope_leak";
  if (params.missingTerms.length > 0) return "missing_expected_terms";
  if (params.sourceTrailCount === 0) return "empty_source_trail";
  if (params.claimAuditCount === 0) return "missing_claim_audit";
  return "presenter_shape";
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaFromPayload(payload);
  const evidenceCount = payloadEvidenceCount(payload);
  const trailCount = sourceTrailCount(payload);
  const auditCount = claimAuditCount(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const actualContract = typeof payload?.queryContract === "string" ? payload.queryContract : typeof meta.queryContractName === "string" ? meta.queryContractName : null;
  const actualFinalClaimSource = finalClaimSource(payload);
  const contractTerms = [
    ...(scenario.expectedQueryContract && actualContract !== scenario.expectedQueryContract ? [`queryContract:${scenario.expectedQueryContract}`] : []),
    ...(scenario.expectedFinalClaimSource && actualFinalClaimSource !== scenario.expectedFinalClaimSource ? [`finalClaimSource:${scenario.expectedFinalClaimSource}`] : [])
  ];
  const effectiveMissingTerms = [...missingTerms, ...contractTerms];
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(payload, term));
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const timedTotalMs = stageTimedTotalMs(meta);
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const quality = classifyQuality({
    scenario,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    missingTerms: effectiveMissingTerms,
    forbiddenHits,
    queryTimeModelCalls,
    latencyMs
  });
  const residualOwner = classifyResidual({
    scenario,
    quality,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    missingTerms: effectiveMissingTerms,
    forbiddenHits,
    queryTimeModelCalls,
    latencyMs
  });
  const sourceMissingAllowed = quality === "source_missing" && scenario.allowSourceMissing === true;
  return {
    ...scenario,
    finalClaimSource: actualFinalClaimSource,
    queryContract: actualContract,
    retrievalDomain: typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : typeof meta.queryContractRetrievalDomain === "string" ? meta.queryContractRetrievalDomain : null,
    selectedIntent: typeof meta.memoryQueryPlanIntent === "string" ? meta.memoryQueryPlanIntent : null,
    selectedCorpus: typeof meta.selectedCorpusCapability === "string" ? meta.selectedCorpusCapability : null,
    selectedReader: typeof meta.selectedReader === "string" ? meta.selectedReader : null,
    dominantStage: typeof meta.dominantStage === "string" ? meta.dominantStage : null,
    topStageMs: numberFromMeta(meta, "topStageMs"),
    stageTimedTotalMs: timedTotalMs,
    latencyUnaccountedMs: latencyUnaccountedMs(latencyMs, timedTotalMs),
    latencyTelemetryMismatch: hasLatencyTelemetryMismatch(latencyMs, timedTotalMs),
    stageTimingsMs: typeof meta.stageTimingsMs === "object" && meta.stageTimingsMs ? meta.stageTimingsMs : null,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    answerPreview: answerTextFromPayload(payload, scenario.toolName).slice(0, 500),
    missingTerms: effectiveMissingTerms,
    forbiddenHits,
    queryTimeModelCalls,
    latencyMs,
    quality,
    residualOwner: sourceMissingAllowed ? "none" : residualOwner,
    passed: (quality === "strong" || quality === "acceptable" || sourceMissingAllowed) && queryTimeModelCalls === 0
  };
}

function metricsFromRows(rows: readonly Row[]) {
  const nonSourceMissingRows = rows.filter((row) => !(row.quality === "source_missing" && row.allowSourceMissing));
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    acceptableCount: rows.filter((row) => row.quality === "acceptable").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    sourceMissingCount: rows.filter((row) => row.quality === "source_missing").length,
    passRate: rate(rows.filter((row) => row.passed).length, rows.length),
    nonSourceMissingPassRate: rate(nonSourceMissingRows.filter((row) => row.passed).length, nonSourceMissingRows.length),
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0 && !(row.quality === "source_missing" && row.allowSourceMissing)).length,
    scopeLeakRows: rows.filter((row) => row.forbiddenHits.length > 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    missingLatencyTelemetryRows: rows.filter((row) => !row.stageTimingsMs).length,
    latencyTelemetryMismatchRows: rows.filter((row) => row.latencyTelemetryMismatch).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: rows.length > 0 ? [...rows].sort((left, right) => left.latencyMs - right.latencyMs)[Math.min(rows.length - 1, Math.floor(rows.length * 0.95))]?.latencyMs ?? 0 : 0,
    maxLatencyMs: rows.reduce((max, row) => Math.max(max, row.latencyMs), 0),
    residualOwnerCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function markdownFor(report: any): string {
  const lines = [
    "# Personal OMI Hard Query Audit 30",
    "",
    `- passed: ${report.passed}`,
    `- passRate: ${report.metrics.passRate}`,
    `- strongCount: ${report.metrics.strongCount}`,
    `- acceptableCount: ${report.metrics.acceptableCount}`,
    `- weakCount: ${report.metrics.weakCount}`,
    `- sourceMissingCount: ${report.metrics.sourceMissingCount}`,
    `- missingExpectedTermRows: ${report.metrics.missingExpectedTermRows}`,
    `- scopeLeakRows: ${report.metrics.scopeLeakRows}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- missingLatencyTelemetryRows: ${report.metrics.missingLatencyTelemetryRows}`,
    `- latencyTelemetryMismatchRows: ${report.metrics.latencyTelemetryMismatchRows}`,
    "",
    "## Rows",
    ...report.results.map((row: Row) => `- ${row.id}: ${row.quality} (${row.residualOwner})`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWritePersonalOmiHardQueryAudit30(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    process.stderr.write(`[personal-omi-hard-query-audit-30] running ${scenario.id}\n`);
    rows.push(await runScenario(scenario));
  }
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows);
  const report = {
    generatedAt,
    benchmark: "personal_omi_hard_query_audit_30",
    passed:
      rows.every((row) => row.passed) &&
      metrics.scopeLeakRows === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.missingLatencyTelemetryRows === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `personal-omi-hard-query-audit-30-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `personal-omi-hard-query-audit-30-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runPersonalOmiHardQueryAudit30Cli(): Promise<void> {
  try {
    const { report, output } = await runAndWritePersonalOmiHardQueryAudit30();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
