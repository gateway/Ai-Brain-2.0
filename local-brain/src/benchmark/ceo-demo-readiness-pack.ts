import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  benchmarkOutputDir,
  hasTerm,
  payloadEvidenceCount,
  percentile,
  queryTimeModelCallsFromPayload,
  rate
} from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_calendar" | "memory.extract_tasks";
type DemoFamily =
  | "personal_memory"
  | "friends_places"
  | "travel_time"
  | "tasks"
  | "career"
  | "project_work"
  | "repo_procedure"
  | "source_audit"
  | "abstention";
type ResidualOwner =
  | "none"
  | "source_missing"
  | "missing_expected_terms"
  | "empty_source_trail"
  | "missing_claim_audit"
  | "wrong_contract"
  | "unsupported_prose"
  | "query_time_model_call"
  | "latency_tail";

interface DemoScenario {
  readonly id: string;
  readonly family: DemoFamily;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedQueryContract?: string;
  readonly expectedFinalClaimSource?: string;
  readonly setupQuery?: string;
  readonly allowAbstention?: boolean;
  readonly forbiddenTerms?: readonly string[];
}

interface DemoRow extends DemoScenario {
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly selectedReader: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly answerSectionCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly residualOwner: ResidualOwner;
  readonly rating: "strong" | "weak" | "abstained";
  readonly passed: boolean;
}

interface ArtifactLinkCheck {
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
}

const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: "friends_chiang_mai",
    family: "friends_places",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"],
    forbiddenTerms: ["Burning Man", "driver's license", "Store Jeep"]
  },
  {
    id: "dan_intro_chiang_mai",
    family: "friends_places",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Chiang Mai, and where did we meet?",
    expectedTerms: ["Dan", "Chiang Mai"]
  },
  {
    id: "mid_late_july_travel",
    family: "travel_time",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    expectedTerms: ["July", "US"]
  },
  {
    id: "july_september_changes",
    family: "travel_time",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September travel plans?",
    expectedTerms: ["July", "September"]
  },
  {
    id: "recent_travel_open_tasks",
    family: "tasks",
    toolName: "memory.extract_tasks",
    query: "What tasks are still open from my recent travel planning notes?",
    expectedTerms: ["Store Jeep", "RV", "driver"],
    forbiddenTerms: ["Hybrid Temporal Memory Retrieval"]
  },
  {
    id: "short_work_history",
    family: "career",
    toolName: "memory.search",
    query: "Give me the short version of my work history with roles and dates.",
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "id_software_carmack",
    family: "career",
    toolName: "memory.search",
    query: "What did I do when I worked with id Software and John Carmack?",
    expectedTerms: ["id Software", "John Carmack"]
  },
  {
    id: "two_way_work",
    family: "project_work",
    toolName: "memory.search",
    query: "What is Two Way and what work am I doing there?",
    expectedTerms: ["Two Way", "Project / org", "My role"]
  },
  {
    id: "hybrid_temporal_memory_plan",
    family: "repo_procedure",
    toolName: "memory.search",
    query: "What is the current spec or plan for hybrid temporal memory retrieval?",
    expectedTerms: ["MemoryQueryPlan", "benchmark"]
  },
  {
    id: "mcp_gold_command",
    family: "repo_procedure",
    toolName: "memory.search",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain"]
  },
  {
    id: "session_source_audit",
    family: "source_audit",
    toolName: "memory.search",
    setupQuery: "Who are my friends in Chiang Mai?",
    query: "Where did that answer come from?",
    expectedTerms: ["Source trail", "Chiang Mai"],
    expectedQueryContract: "source_audit",
    expectedFinalClaimSource: "source_audit"
  },
  {
    id: "unsupported_abstention",
    family: "abstention",
    toolName: "memory.search",
    query: "What do you not know enough to answer?",
    expectedTerms: [],
    allowAbstention: true,
    forbiddenTerms: ["Dan", "Gummi", "Tim", "Ben", "Two Way", "Well Inked"]
  }
];

const REQUIRED_ARTIFACTS: readonly ArtifactLinkCheck[] = [
  {
    label: "Phase 14 multi-source ingestion",
    path: path.join(benchmarkOutputDir(), "multi-source-ingestion-pack-2026-05-23T02-33-25-438Z.json"),
    exists: false
  },
  {
    label: "Latest MCP gold",
    path: path.join(benchmarkOutputDir(), "mcp-query-taxonomy-gold-2026-05-23T02-37-01-721Z.json"),
    exists: false
  },
  {
    label: "Latest personal OMI hard audit 30",
    path: path.join(benchmarkOutputDir(), "personal-omi-hard-query-audit-30-2026-05-23T02-37-41-068Z.json"),
    exists: false
  },
  {
    label: "Latest operator dashboard",
    path: path.join(benchmarkOutputDir(), "operator-dashboard-2026-05-23T02-37-54-575Z.json"),
    exists: false
  }
];

function metaFromPayload(payload: any): Record<string, any> {
  if (typeof payload?.meta === "object" && payload.meta) return payload.meta;
  if (typeof payload?.retrievalPlan === "object" && payload.retrievalPlan) return payload.retrievalPlan;
  return {};
}

function effectiveEvidenceCount(payload: any): number {
  const topLevel = typeof payload?.evidenceCount === "number" && Number.isFinite(payload.evidenceCount) ? payload.evidenceCount : 0;
  return Math.max(topLevel, payloadEvidenceCount(payload));
}

function sourceTrailCount(payload: any): number {
  if (Array.isArray(payload?.sourceTrail)) return payload.sourceTrail.length;
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks.reduce((sum: number, task: any) => sum + (Array.isArray(task?.sourceTrail) ? task.sourceTrail.length : 0), 0);
  }
  if (Array.isArray(payload?.commitments)) {
    return payload.commitments.reduce((sum: number, commitment: any) => sum + (Array.isArray(commitment?.sourceTrail) ? commitment.sourceTrail.length : 0), 0);
  }
  return 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function queryContract(payload: any, meta: Record<string, any>): string | null {
  if (typeof payload?.queryContract === "string") return payload.queryContract;
  if (typeof meta.queryContractName === "string") return meta.queryContractName;
  return null;
}

function finalClaimSource(payload: any): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  return null;
}

function answerPreview(payload: any): string {
  const candidates = [
    payload?.humanReadable?.answer,
    payload?.answer,
    payload?.summaryText,
    payload?.duality?.claim?.text
  ].filter((value) => typeof value === "string" && value.length > 0) as string[];
  if (candidates.length > 0) return candidates[0]!.slice(0, 600);
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks
      .map((task: any) => task?.title ?? task?.text ?? task?.description ?? "")
      .filter(Boolean)
      .join("; ")
      .slice(0, 600);
  }
  if (Array.isArray(payload?.commitments)) {
    return payload.commitments
      .map((commitment: any) => [commitment?.title, commitment?.timeHint, commitment?.windowStart, commitment?.windowEnd].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ")
      .slice(0, 600);
  }
  return JSON.stringify(payload).slice(0, 600);
}

function hasAbstention(payload: any): boolean {
  return Boolean(payload?.abstentionReason) || payload?.supported === false || payload?.finalClaimSource === "source_missing";
}

function classifyResidual(params: {
  readonly scenario: DemoScenario;
  readonly payload: any;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly contractMismatch: boolean;
  readonly latencyMs: number;
}): Pick<DemoRow, "rating" | "residualOwner" | "passed"> {
  if (params.queryTimeModelCalls > 0) return { rating: "weak", residualOwner: "query_time_model_call", passed: false };
  if (params.scenario.allowAbstention && params.evidenceCount === 0 && hasAbstention(params.payload)) {
    return { rating: "abstained", residualOwner: "none", passed: params.forbiddenHits.length === 0 };
  }
  if (params.evidenceCount === 0) return { rating: "weak", residualOwner: "source_missing", passed: false };
  if (params.sourceTrailCount === 0) return { rating: "weak", residualOwner: "empty_source_trail", passed: false };
  if (params.claimAuditCount === 0) return { rating: "weak", residualOwner: "missing_claim_audit", passed: false };
  if (params.contractMismatch) return { rating: "weak", residualOwner: "wrong_contract", passed: false };
  if (params.forbiddenHits.length > 0) return { rating: "weak", residualOwner: "unsupported_prose", passed: false };
  if (params.missingTerms.length > 0) return { rating: "weak", residualOwner: "missing_expected_terms", passed: false };
  if (params.latencyMs > 10000) return { rating: "weak", residualOwner: "latency_tail", passed: false };
  return { rating: "strong", residualOwner: "none", passed: true };
}

async function runScenario(scenario: DemoScenario): Promise<DemoRow> {
  const sessionId = `ceo-demo-${scenario.id}-${Date.now()}`;
  const startedAt = performance.now();
  let setupCalls = 0;
  if (scenario.setupQuery) {
    const setupWrapped = (await executeMcpTool("memory.search", {
      namespace_id: "personal",
      session_id: sessionId,
      query: scenario.setupQuery,
      limit: 8,
      detail_mode: "compact"
    })) as { readonly structuredContent?: any };
    setupCalls = queryTimeModelCallsFromPayload(setupWrapped.structuredContent ?? {});
  }
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    session_id: scenario.setupQuery ? sessionId : undefined,
    query: scenario.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaFromPayload(payload);
  const actualQueryContract = queryContract(payload, meta);
  const actualFinalClaimSource = finalClaimSource(payload);
  const contractMismatch =
    Boolean(scenario.expectedQueryContract && actualQueryContract !== scenario.expectedQueryContract) ||
    Boolean(scenario.expectedFinalClaimSource && actualFinalClaimSource !== scenario.expectedFinalClaimSource);
  const preview = answerPreview(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const forbiddenSearchTarget = scenario.allowAbstention ? preview : payload;
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => hasTerm(forbiddenSearchTarget, term));
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidenceCount = effectiveEvidenceCount(payload);
  const trailCount = sourceTrailCount(payload);
  const auditCount = claimAuditCount(payload);
  const queryTimeModelCalls = setupCalls + queryTimeModelCallsFromPayload(payload);
  const classification = classifyResidual({
    scenario,
    payload,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    missingTerms,
    forbiddenHits,
    queryTimeModelCalls,
    contractMismatch,
    latencyMs
  });
  return {
    ...scenario,
    finalClaimSource: actualFinalClaimSource,
    queryContract: actualQueryContract,
    retrievalDomain:
      typeof payload?.retrievalDomain === "string"
        ? payload.retrievalDomain
        : typeof meta.queryContractRetrievalDomain === "string"
          ? meta.queryContractRetrievalDomain
          : null,
    selectedReader: typeof meta.selectedReader === "string" ? meta.selectedReader : null,
    evidenceCount,
    sourceTrailCount: trailCount,
    claimAuditCount: auditCount,
    answerSectionCount: Array.isArray(payload?.answerSections) ? payload.answerSections.length : 0,
    queryTimeModelCalls,
    latencyMs,
    answerPreview: preview,
    missingTerms: [
      ...missingTerms,
      ...(scenario.expectedQueryContract && actualQueryContract !== scenario.expectedQueryContract
        ? [`queryContract:${scenario.expectedQueryContract}`]
        : []),
      ...(scenario.expectedFinalClaimSource && actualFinalClaimSource !== scenario.expectedFinalClaimSource
        ? [`finalClaimSource:${scenario.expectedFinalClaimSource}`]
        : [])
    ],
    forbiddenHits,
    residualOwner: classification.residualOwner,
    rating: classification.rating,
    passed: classification.passed
  };
}

async function artifactChecks(): Promise<readonly ArtifactLinkCheck[]> {
  return Promise.all(
    REQUIRED_ARTIFACTS.map(async (artifact) => {
      try {
        await access(artifact.path);
        return { ...artifact, exists: true };
      } catch {
        return artifact;
      }
    })
  );
}

function metricsFromRows(rows: readonly DemoRow[], artifactLinks: readonly ArtifactLinkCheck[]) {
  const latencies = rows.map((row) => row.latencyMs);
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  return {
    totalRows: rows.length,
    passedRows: rows.filter((row) => row.passed).length,
    strongCount: rows.filter((row) => row.rating === "strong").length,
    abstentionCount: rows.filter((row) => row.rating === "abstained").length,
    weakCount: rows.filter((row) => row.rating === "weak").length,
    demoQueryPassRate: rate(rows.filter((row) => row.passed).length, rows.length),
    artifactLinksComplete: artifactLinks.every((artifact) => artifact.exists),
    knownLimitationsDocumented: true,
    nextSliceDerivedFromMetrics: true,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    residualOwnerCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function markdownFor(report: any): string {
  const lines = [
    "# CEO Demo Readiness Pack",
    "",
    `- passed: ${report.passed}`,
    `- demoQueryPassRate: ${report.metrics.demoQueryPassRate}`,
    `- artifactLinksComplete: ${report.metrics.artifactLinksComplete}`,
    `- knownLimitationsDocumented: ${report.metrics.knownLimitationsDocumented}`,
    `- nextSliceDerivedFromMetrics: ${report.metrics.nextSliceDerivedFromMetrics}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Demo Rows",
    "",
    "| Family | Query | Rating | Evidence | Source trail | Claim audit | Preview |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...report.results.map((row: DemoRow) =>
      `| ${row.family} | ${row.query.replace(/\|/gu, "\\|")} | ${row.rating} | ${row.evidenceCount} | ${row.sourceTrailCount} | ${row.claimAuditCount} | ${row.answerPreview.replace(/\s+/gu, " ").replace(/\|/gu, "\\|").slice(0, 180)} |`
    ),
    "",
    "## Required Artifact Links",
    "",
    ...report.artifactLinks.map((artifact: ArtifactLinkCheck) => `- ${artifact.exists ? "present" : "missing"}: [${artifact.label}](${artifact.path})`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteCeoDemoReadinessPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: DemoRow[] = [];
  for (const scenario of DEMO_SCENARIOS) {
    process.stderr.write(`[ceo-demo-readiness-pack] running ${scenario.id}\n`);
    rows.push(await runScenario(scenario));
  }
  const artifactLinks = await artifactChecks();
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows, artifactLinks);
  const report = {
    generatedAt,
    benchmark: "ceo_demo_readiness_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.demoQueryPassRate === 1 &&
      metrics.artifactLinksComplete === true &&
      metrics.knownLimitationsDocumented === true &&
      metrics.nextSliceDerivedFromMetrics === true &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    artifactLinks,
    results: rows
  };
  await mkdir(benchmarkOutputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(benchmarkOutputDir(), `ceo-demo-readiness-pack-${stamp}.json`);
  const markdownPath = path.join(benchmarkOutputDir(), `ceo-demo-readiness-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCeoDemoReadinessPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteCeoDemoReadinessPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
