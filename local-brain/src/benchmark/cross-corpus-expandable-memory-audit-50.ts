import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  buildMemoryFocusPacket,
  buildMemorySummaryDag,
  upsertMemorySourceWindow,
  type MemoryPacketSourceKind
} from "../memory-packets/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface FixtureWindow {
  readonly sourceKind: MemoryPacketSourceKind;
  readonly sourceUri: string;
  readonly key: string;
  readonly text: string;
}

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
}

interface AuditRow extends Scenario {
  readonly answerQuality: "strong" | "weak" | "fail" | "source_missing";
  readonly selectedReader: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly summaryNodeCount: number;
  readonly sourceWindowCount: number;
  readonly expansionTraceCount: number;
  readonly missingTerms: readonly string[];
  readonly latencyMs: number;
  readonly queryTimeModelCalls: number;
  readonly residualOwner: string | null;
}

interface CrossCorpusExpandableMemoryAudit50Report {
  readonly generatedAt: string;
  readonly benchmark: "cross_corpus_expandable_memory_audit_50";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly totalQueries: number;
    readonly strongCount: number;
    readonly weakCount: number;
    readonly failedCount: number;
    readonly sourceMissingCount: number;
    readonly strongRate: number;
    readonly expansionRoundTripPassRate: number;
    readonly sourceWindowBoundAnswerRate: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly AuditRow[];
  readonly failures: readonly string[];
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

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function namespaceId(): string {
  return `fixture_cross_corpus_expandable_${stamp().toLowerCase()}`;
}

function fixtures(): readonly FixtureWindow[] {
  return [
    {
      sourceKind: "codex_session",
      sourceUri: "codex://media-studio/session-patterns-week",
      key: "audit-codex-media-patterns",
      text: "Media Studio Codex patterns from last week: reusable project-detail retrieval, no hardcoded patches, natural language project aliases, browser verification, and source-bound summaries."
    },
    {
      sourceKind: "codex_session",
      sourceUri: "codex://ai-brain/session-clean-main",
      key: "audit-codex-ai-brain-clean-main",
      text: "AI Brain Codex clean-main work used benchmark:clean-main-smoke-stack, MCP gold, source-audit cross-family, personal OMI hard query audit, planner or reader layers fixes rather than prompt hacks, and changelog updates before signoff."
    },
    {
      sourceKind: "codex_session",
      sourceUri: "codex://codex-memory/session-token-waste",
      key: "audit-codex-token-waste",
      text: "Codex memory analytics flagged token waste from rereading large docs, repeated test logs, oversized prompts, stale task lists, missing compact memory packets, and missing compact context packets."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://temporal-kg-paper.pdf#page=4",
      key: "audit-pdf-temporal-kg",
      text: "Temporal knowledge graph paper notes recommend separating event time from dialogue time, preserving temporal support paths, and using time-window constraints before vector recall."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://agent-memory-survey.pdf#page=7",
      key: "audit-pdf-agent-memory",
      text: "Agent memory survey describes semantic memory, episodic memory, procedural memory, preference memory, and working memory as separate memory types for autonomous agents."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://lossless-context-notes.pdf#section=source-windowing",
      key: "audit-pdf-lossless-context",
      text: "Lossless context notes emphasize source-window pointers, compact cards, expansion on demand, and keeping summaries as navigation aids rather than final truth."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/latest-travel",
      key: "audit-omi-travel",
      text: "The latest OMI travel note mentioned mid to late July travel, Chiang Mai flight planning, September travel after Burning Man, and confirming calendar dates."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/friends-chiang-mai",
      key: "audit-omi-friends",
      text: "The Chiang Mai friends note mentioned Dan, Gummi, Tim, and Ben as people connected through local meetups and coworking-style social context."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/tasks",
      key: "audit-omi-tasks",
      text: "The OMI task note mentioned booking flights, checking July dates, reviewing travel tasks, and separating current open tasks from old stale tasks."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/package.json#scripts",
      key: "audit-repo-package-scripts",
      text: "The package scripts include benchmark:mcp-query-taxonomy-gold, benchmark:source-audit-cross-family-pack, benchmark:clean-main-smoke-stack, and benchmark:expandable-memory-packets-pack."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/brain-spec/local/expandable-memory-packets-task-list.md",
      key: "audit-repo-task-list",
      text: "The expandable memory task list tracks Phase 4 focus packets, Phase 5 lexical source-window drilldown, Phase 6 cross-corpus audit, and documentation updates."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://query-contract-work",
      key: "audit-task-query-contract",
      text: "Query contract tasks include finish projection audit, review MCP Studio wiring, add stable queryContract metadata, and verify sourceTrail for supported answers."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://travel-planning",
      key: "audit-task-travel",
      text: "Travel planning tasks include book Chiang Mai flights, confirm mid to late July dates, check September plans after Burning Man, and close stale unrelated travel tasks."
    },
    {
      sourceKind: "calendar_export",
      sourceUri: "calendar-export://travel-2026",
      key: "audit-calendar-travel",
      text: "Calendar export includes a mid to late July travel window, a September 2026 travel window, Burning Man as an anchor, and a reminder to confirm dates before booking."
    },
    {
      sourceKind: "markdown",
      sourceUri: "markdown://notes/codex-session-ingestion.md",
      key: "audit-markdown-codex-ingestion",
      text: "Codex session ingestion notes define candidate memories, promoted memories, repeated instructions, skill candidates, project profiles, and weekly agent workflow reports."
    },
    {
      sourceKind: "markdown",
      sourceUri: "markdown://notes/temporal-task-self-healing.md",
      key: "audit-markdown-temporal-self-healing",
      text: "Temporal task self-healing notes define miss ledgers, dominant residual owners, source-scope discipline, event-window filtering, lifecycle scope, and before-after metrics."
    }
  ];
}

const BASE_SCENARIOS: readonly Scenario[] = [
  { id: "codex_01", query: "Using expandable memory, what repeated Media Studio Codex patterns mention source-bound summaries?", expectedTerms: ["Media Studio", "source-bound summaries"] },
  { id: "codex_02", query: "Show source windows for clean-main Codex work and MCP gold.", expectedTerms: ["clean-main-smoke-stack", "MCP gold"] },
  { id: "codex_03", query: "What Codex token waste patterns were flagged in source windows?", expectedTerms: ["rereading large docs", "repeated test logs"] },
  { id: "codex_04", query: "Generate a context packet for Codex memory analytics and stale task lists.", expectedTerms: ["token waste", "stale task lists"] },
  { id: "codex_05", query: "Which Codex source window says no hardcoded patches for project-detail retrieval?", expectedTerms: ["no hardcoded patches", "project-detail retrieval"] },
  { id: "codex_06", query: "Which Codex audit source mentions changelog updates before signoff?", expectedTerms: ["changelog updates", "before signoff"] },
  { id: "pdf_01", query: "Summarize the temporal KG paper source window about event time and dialogue time.", expectedTerms: ["event time", "dialogue time"] },
  { id: "pdf_02", query: "Show the PDF source window about time-window constraints before vector recall.", expectedTerms: ["time-window constraints", "vector recall"] },
  { id: "pdf_03", query: "What memory types does the agent memory survey list?", expectedTerms: ["semantic memory", "procedural memory"] },
  { id: "pdf_04", query: "Find PDF support for preference memory and working memory.", expectedTerms: ["preference memory", "working memory"] },
  { id: "pdf_05", query: "What do lossless context notes say about summaries and final truth?", expectedTerms: ["navigation aids", "final truth"] },
  { id: "pdf_06", query: "Expand source-window support for compact cards and expansion on demand.", expectedTerms: ["compact cards", "expansion on demand"] },
  { id: "omi_01", query: "From expandable OMI memory, what travel did I mention for mid to late July?", expectedTerms: ["mid to late July", "Chiang Mai"] },
  { id: "omi_02", query: "Show the OMI source window for September travel after Burning Man.", expectedTerms: ["September travel", "Burning Man"] },
  { id: "omi_03", query: "Who were the Chiang Mai people mentioned in the OMI source window?", expectedTerms: ["Dan", "Gummi"] },
  { id: "omi_04", query: "Which OMI source window mentions Tim and Ben in local meetup context?", expectedTerms: ["Tim", "Ben"] },
  { id: "omi_05", query: "What OMI task source window mentions booking flights and July dates?", expectedTerms: ["booking flights", "July dates"] },
  { id: "omi_06", query: "Show OMI source support for separating current open tasks from stale tasks.", expectedTerms: ["current open tasks", "stale tasks"] },
  { id: "repo_01", query: "Which repo source window lists the MCP query taxonomy gold benchmark command?", expectedTerms: ["benchmark:mcp-query-taxonomy-gold"] },
  { id: "repo_02", query: "Show package script source support for source-audit cross-family.", expectedTerms: ["benchmark:source-audit-cross-family-pack"] },
  { id: "repo_03", query: "What repo task list phases cover focus packets and lexical source-window drilldown?", expectedTerms: ["Phase 4 focus packets", "Phase 5 lexical"] },
  { id: "repo_04", query: "Which repo source mentions Phase 6 cross-corpus audit and documentation updates?", expectedTerms: ["Phase 6 cross-corpus audit", "documentation updates"] },
  { id: "repo_05", query: "Show source-window support for benchmark:expandable-memory-packets-pack.", expectedTerms: ["benchmark:expandable-memory-packets-pack"] },
  { id: "repo_06", query: "Which package source window mentions clean-main smoke stack?", expectedTerms: ["benchmark:clean-main-smoke-stack"] },
  { id: "task_01", query: "What query contract task source mentions finish projection audit?", expectedTerms: ["finish projection audit"] },
  { id: "task_02", query: "Which task source says review MCP Studio wiring?", expectedTerms: ["review MCP Studio wiring"] },
  { id: "task_03", query: "Find task source support for stable queryContract metadata.", expectedTerms: ["stable queryContract metadata"] },
  { id: "task_04", query: "Show task source support for verifying sourceTrail.", expectedTerms: ["verify sourceTrail"] },
  { id: "task_05", query: "What travel task source says book Chiang Mai flights?", expectedTerms: ["book Chiang Mai flights"] },
  { id: "task_06", query: "Which travel task source says close stale unrelated travel tasks?", expectedTerms: ["close stale unrelated travel tasks"] },
  { id: "calendar_01", query: "What calendar source window contains a mid to late July travel window?", expectedTerms: ["mid to late July travel window"] },
  { id: "calendar_02", query: "Show calendar source support for September 2026 travel.", expectedTerms: ["September 2026 travel"] },
  { id: "calendar_03", query: "Which calendar source treats Burning Man as an anchor?", expectedTerms: ["Burning Man as an anchor"] },
  { id: "calendar_04", query: "Find calendar source support for confirming dates before booking.", expectedTerms: ["confirm dates before booking"] },
  { id: "markdown_01", query: "What Codex ingestion markdown source defines candidate memories?", expectedTerms: ["candidate memories"] },
  { id: "markdown_02", query: "Show markdown support for promoted memories and repeated instructions.", expectedTerms: ["promoted memories", "repeated instructions"] },
  { id: "markdown_03", query: "Which markdown source mentions skill candidates and project profiles?", expectedTerms: ["skill candidates", "project profiles"] },
  { id: "markdown_04", query: "Find markdown source support for weekly agent workflow reports.", expectedTerms: ["weekly agent workflow reports"] },
  { id: "markdown_05", query: "What temporal self-healing markdown source defines miss ledgers?", expectedTerms: ["miss ledgers"] },
  { id: "markdown_06", query: "Show markdown source support for dominant residual owners.", expectedTerms: ["dominant residual owners"] },
  { id: "temporal_01", query: "Which source window says source-scope discipline and event-window filtering?", expectedTerms: ["source-scope discipline", "event-window filtering"] },
  { id: "temporal_02", query: "Find temporal source support for lifecycle scope and before-after metrics.", expectedTerms: ["lifecycle scope", "before-after metrics"] },
  { id: "mixed_01", query: "Generate a compact context packet across Codex, PDF, OMI, repo docs, tasks, and calendar.", expectedTerms: ["Codex", "PDF", "OMI"] },
  { id: "mixed_02", query: "Which expandable memory sources connect temporal KG research with OMI travel windows?", expectedTerms: ["Temporal knowledge graph", "mid to late July"] },
  { id: "mixed_03", query: "Show source windows connecting task lifecycle cleanup and stale unrelated travel tasks.", expectedTerms: ["lifecycle", "stale unrelated travel tasks"] },
  { id: "mixed_04", query: "What sources connect project profiles with Media Studio project aliases?", expectedTerms: ["project profiles", "project aliases"] },
  { id: "mixed_05", query: "Find expandable support for source-window pointers and sourceTrail verification.", expectedTerms: ["source-window pointers", "sourceTrail"] },
  { id: "mixed_06", query: "Show evidence for clean-main gates and cross-family source audit.", expectedTerms: ["clean-main", "source-audit cross-family"] },
  { id: "mixed_07", query: "Which sources mention compact memory packets and compact context packets?", expectedTerms: ["compact memory packets", "compact context packets"] },
  { id: "mixed_08", query: "Find source support for no prompt hacks and planner or reader layer fixes.", expectedTerms: ["prompt hacks", "planner or reader layers"] }
];

function scenarios(): readonly Scenario[] {
  return BASE_SCENARIOS;
}

function includesTerm(payload: unknown, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

async function seed(namespace: string): Promise<void> {
  for (const [index, fixture] of fixtures().entries()) {
    await upsertMemorySourceWindow({
      namespaceId: namespace,
      artifactId: `artifact-${fixture.key}`,
      sourceWindowKey: fixture.key,
      sourceKind: fixture.sourceKind,
      sourceUri: fixture.sourceUri,
      startLocator: `audit:${index}:start`,
      endLocator: `audit:${index}:end`,
      text: fixture.text,
      capturedAt: "2026-05-30T00:00:00.000Z",
      occurredAt: "2026-05-30T00:00:00.000Z",
      metadata: {
        fixture: true,
        audit: "cross_corpus_expandable_memory_audit_50",
        redaction_checked: true,
        large_block_externalized: true
      }
    });
  }
}

async function runScenario(namespace: string, scenario: Scenario): Promise<AuditRow> {
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: namespace,
    query: scenario.query,
    detail_mode: "compact",
    limit: 8
  });
  const latencyMs = performance.now() - startedAt;
  const payload = structuredContent(result);
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const summaryNodeCount = Array.isArray(payload.summaryNodeIds) ? payload.summaryNodeIds.length : 0;
  const sourceWindowCount = Array.isArray(payload.sourceWindowIds) ? payload.sourceWindowIds.length : 0;
  const expansionTraceCount = Array.isArray(payload.expansionTrace) ? payload.expansionTrace.length : 0;
  const missingTerms = scenario.expectedTerms.filter((term) => !includesTerm(payload, term));
  const queryTimeModelCalls = typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const selectedReader = typeof payload.selectedReader === "string" ? payload.selectedReader : null;
  const finalClaimSource = typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null;
  const answerQuality: AuditRow["answerQuality"] =
    evidenceCount === 0
      ? "source_missing"
      : missingTerms.length === 0 && sourceTrailCount > 0 && claimAuditCount > 0 && sourceWindowCount > 0 && expansionTraceCount > 0
        ? "strong"
        : "weak";
  const residualOwner =
    answerQuality === "strong"
      ? null
      : evidenceCount === 0
        ? "source_missing"
        : missingTerms.length > 0
          ? "lexical_drilldown_miss"
          : sourceTrailCount === 0 || claimAuditCount === 0
            ? "presenter_shape_miss"
            : sourceWindowCount === 0 || expansionTraceCount === 0
              ? "expansion_binding_miss"
              : "unknown_owner";
  return {
    ...scenario,
    answerQuality,
    selectedReader,
    finalClaimSource,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    summaryNodeCount,
    sourceWindowCount,
    expansionTraceCount,
    missingTerms,
    latencyMs: Number(latencyMs.toFixed(2)),
    queryTimeModelCalls,
    residualOwner
  };
}

function toMarkdown(report: CrossCorpusExpandableMemoryAudit50Report): string {
  return [
    "# Cross-Corpus Expandable Memory Audit 50",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- namespaceId: ${report.namespaceId}`,
    "",
    "## Metrics",
    "",
    ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Rows",
    "",
    ...report.rows.map((row) => `- ${row.id}: ${row.answerQuality}; reader=${row.selectedReader}; evidence=${row.evidenceCount}; windows=${row.sourceWindowCount}; missing=${row.missingTerms.join(", ") || "none"}; latencyMs=${row.latencyMs}`),
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runCrossCorpusExpandableMemoryAudit50(): Promise<{
  readonly report: CrossCorpusExpandableMemoryAudit50Report;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const namespace = namespaceId();
  await seed(namespace);
  await buildMemorySummaryDag({ namespaceId: namespace });
  await buildMemoryFocusPacket({
    namespaceId: namespace,
    prompt: "Cross-corpus expandable memory context packet for Codex PDF OMI repo docs tasks calendar markdown",
    packetType: "agent_start",
    projects: ["AI Brain", "Media Studio"]
  });
  const rows: AuditRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(namespace, scenario));
  }
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const strongCount = rows.filter((row) => row.answerQuality === "strong").length;
  const weakCount = rows.filter((row) => row.answerQuality === "weak").length;
  const failedCount = rows.filter((row) => row.answerQuality === "fail").length;
  const sourceMissingCount = rows.filter((row) => row.answerQuality === "source_missing").length;
  const latencies = rows.map((row) => row.latencyMs);
  const metrics = {
    totalQueries: rows.length,
    strongCount,
    weakCount,
    failedCount,
    sourceMissingCount,
    strongRate: rate(strongCount, rows.length),
    expansionRoundTripPassRate: rate(rows.filter((row) => row.summaryNodeCount > 0 && row.sourceWindowCount > 0 && row.expansionTraceCount > 0).length, rows.length),
    sourceWindowBoundAnswerRate: rate(supportedRows.filter((row) => row.sourceTrailCount > 0 && row.sourceWindowCount > 0).length, supportedRows.length),
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    scenarios().length !== 50 ? "scenario_count_not_50" : "",
    metrics.strongRate < 0.98 ? "strong_rate_below_gate" : "",
    metrics.weakCount !== 0 ? "weak_rows_present" : "",
    metrics.failedCount !== 0 ? "failed_rows_present" : "",
    metrics.sourceMissingCount !== 0 ? "source_missing_rows_present" : "",
    metrics.expansionRoundTripPassRate < 0.98 ? "expansion_roundtrip_below_gate" : "",
    metrics.sourceWindowBoundAnswerRate < 0.98 ? "source_window_bound_answer_rate_below_gate" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : "",
    metrics.p95LatencyMs > 5000 ? "p95_latency_above_gate" : "",
    metrics.maxLatencyMs > 10000 ? "max_latency_above_gate" : ""
  ].filter(Boolean);
  const report: CrossCorpusExpandableMemoryAudit50Report = {
    generatedAt: new Date().toISOString(),
    benchmark: "cross_corpus_expandable_memory_audit_50",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: namespace, scenarioCount: scenarios().length, fixtureCount: fixtures().length }
    }),
    namespaceId: namespace,
    passed: failures.length === 0,
    metrics,
    rows,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `cross-corpus-expandable-memory-audit-50-${generatedAt}.json`);
  const markdownPath = path.join(dir, `cross-corpus-expandable-memory-audit-50-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCrossCorpusExpandableMemoryAudit50Cli(): Promise<void> {
  const { report, output } = await runCrossCorpusExpandableMemoryAudit50();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
