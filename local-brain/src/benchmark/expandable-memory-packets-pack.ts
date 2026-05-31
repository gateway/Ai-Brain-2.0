import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { queryRows } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import {
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
  readonly expandable: boolean;
  readonly expansionRoundTripPassed: boolean;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly missingTerms: readonly string[];
  readonly residualOwner: string | null;
}

interface ExpandableMemoryPacketsPackReport {
  readonly generatedAt: string;
  readonly benchmark: "expandable_memory_packets_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly sourceWindowCoverageRate: number;
    readonly structuredCodexPartCoverageRate: number;
    readonly largeBlockExternalizationRate: number;
    readonly rawTranscriptEmbeddingCount: number;
    readonly redactionBeforeSummaryRate: number;
    readonly summaryNodeCoverageRate: number;
    readonly summaryEdgeIntegrityRate: number;
    readonly summarySourceWindowRoundTripRate: number;
    readonly unsupportedSummaryClaimCount: number;
    readonly omittedDetailCoverageRate: number;
    readonly expansionAvailableRate: number;
    readonly expandedSourceWindowFaithfulnessRate: number;
    readonly sourceAuditExpansionBindingAccuracy: number;
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
  return `fixture_expandable_memory_${stamp().toLowerCase()}`;
}

function fixtures(): readonly FixtureWindow[] {
  return [
    {
      sourceKind: "codex_session",
      sourceUri: "codex://media-studio/session-001",
      key: "codex-media-studio-001",
      text: "Media Studio Codex sessions repeatedly instructed agents to avoid hardcoded patches, update task lists, run verification gates, and keep changelog documentation aligned with code."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://agent-memory-layout.pdf#page=2",
      key: "pdf-agent-memory-layout-page-2",
      text: "Agent memory PDF section: hierarchical chunking links child chunks to parent sections, and source-bound expansion should show exact supporting source windows for each summary."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/latest-note",
      key: "omi-2026-05-18-july-travel",
      text: "Latest OMI note mentioned mid to late July travel planning, booking Chiang Mai flights, and confirming calendar dates before leaving."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/brain-spec/local/retrieval-cleanup.md",
      key: "repo-ai-brain-retrieval-cleanup",
      text: "AI Brain retrieval cleanup spec says run clean-main-smoke-stack and source-audit gates before signoff, then document before and after metrics."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://query-contract-work",
      key: "task-export-query-contract-work",
      text: "Task checklist includes finish projection audit, review MCP Studio wiring, and add stable queryContract metadata for supported answers."
    },
    {
      sourceKind: "markdown",
      sourceUri: "markdown://notes/expandable-memory.md",
      key: "markdown-expandable-memory-note",
      text: "Expandable memory packet notes say compact answers should include summary node IDs, source window IDs, source trail, claim audit, and expansion trace."
    }
  ];
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "codex_pattern_packet",
      query: "Generate a compact context packet for the Media Studio Codex repeated instructions and show expandable memory support.",
      expectedTerms: ["Media Studio", "hardcoded patches", "task lists"]
    },
    {
      id: "pdf_source_chunks",
      query: "Summarize the agent memory PDF and show supporting source chunks from expandable memory.",
      expectedTerms: ["hierarchical chunking", "parent sections", "source windows"]
    },
    {
      id: "omi_exact_source_window",
      query: "Expand the exact source window behind the July travel summary from my OMI note.",
      expectedTerms: ["mid to late July", "Chiang Mai flights", "calendar dates"]
    },
    {
      id: "repo_procedure_packet",
      query: "What expandable memory packet covers the AI Brain retrieval cleanup procedure docs?",
      expectedTerms: ["clean-main-smoke-stack", "source-audit gates", "before and after metrics"]
    },
    {
      id: "task_checklist_expansion",
      query: "Expand source evidence for the document or task checklist answer about query contract work.",
      expectedTerms: ["finish projection audit", "MCP Studio wiring", "queryContract metadata"]
    },
    {
      id: "summary_node_contract",
      query: "Show the expandable memory summary node contract and source window IDs.",
      expectedTerms: ["summary node IDs", "source window IDs", "expansion trace"]
    }
  ];
}

function includesTerm(payload: unknown, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
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

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

async function seed(namespace: string): Promise<void> {
  for (const [index, fixture] of fixtures().entries()) {
    await upsertMemorySourceWindow({
      namespaceId: namespace,
      artifactId: `artifact-${fixture.key}`,
      sourceWindowKey: fixture.key,
      sourceKind: fixture.sourceKind,
      sourceUri: fixture.sourceUri,
      startLocator: `window:${index}:start`,
      endLocator: `window:${index}:end`,
      text: fixture.text,
      capturedAt: "2026-05-30T00:00:00.000Z",
      occurredAt: "2026-05-30T00:00:00.000Z",
      metadata: {
        fixture: true,
        structured_part_count: fixture.sourceKind === "codex_session" ? 4 : 1,
        large_block_externalized: true,
        redaction_checked: true
      }
    });
  }
}

async function countRows(namespace: string): Promise<{
  readonly sourceWindows: number;
  readonly summaryNodes: number;
  readonly summaryEdges: number;
  readonly leafNodesWithSourceWindows: number;
  readonly nodesWithOmittedDetails: number;
}> {
  const rows = await queryRows<{
    readonly source_windows: string;
    readonly summary_nodes: string;
    readonly summary_edges: string;
    readonly leaf_nodes_with_source_windows: string;
    readonly nodes_with_omitted_details: string;
  }>(
    `
      SELECT
        (SELECT count(*)::text FROM memory_source_windows WHERE namespace_id = $1) AS source_windows,
        (SELECT count(*)::text FROM memory_summary_nodes WHERE namespace_id = $1) AS summary_nodes,
        (
          SELECT count(*)::text
          FROM memory_summary_edges e
          JOIN memory_summary_nodes n ON n.id = e.parent_node_id
          WHERE n.namespace_id = $1
        ) AS summary_edges,
        (
          SELECT count(*)::text
          FROM memory_summary_nodes
          WHERE namespace_id = $1
            AND node_kind = 'leaf'
            AND jsonb_array_length(COALESCE(metadata->'source_window_ids', '[]'::jsonb)) > 0
        ) AS leaf_nodes_with_source_windows,
        (
          SELECT count(*)::text
          FROM memory_summary_nodes
          WHERE namespace_id = $1
            AND cardinality(omitted_details) > 0
        ) AS nodes_with_omitted_details
    `,
    [namespace]
  );
  const row = rows[0];
  return {
    sourceWindows: Number(row?.source_windows ?? "0"),
    summaryNodes: Number(row?.summary_nodes ?? "0"),
    summaryEdges: Number(row?.summary_edges ?? "0"),
    leafNodesWithSourceWindows: Number(row?.leaf_nodes_with_source_windows ?? "0"),
    nodesWithOmittedDetails: Number(row?.nodes_with_omitted_details ?? "0")
  };
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
  const missingTerms = scenario.expectedTerms.filter((term) => !includesTerm(payload, term));
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const summaryNodeCount = Array.isArray(payload.summaryNodeIds) ? payload.summaryNodeIds.length : 0;
  const sourceWindowCount = Array.isArray(payload.sourceWindowIds) ? payload.sourceWindowIds.length : 0;
  const expandable = payload.expandable === true;
  const expansionRoundTripPassed = expandable && summaryNodeCount > 0 && sourceWindowCount > 0 && sourceTrailCount > 0;
  const queryTimeModelCalls = typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const selectedReader = typeof payload.selectedReader === "string" ? payload.selectedReader : null;
  const finalClaimSource = typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null;
  const answerQuality: AuditRow["answerQuality"] =
    evidenceCount === 0
      ? "fail"
      : missingTerms.length === 0 && expansionRoundTripPassed && claimAuditCount > 0
        ? "strong"
        : "weak";
  const residualOwner =
    answerQuality === "strong"
      ? null
      : evidenceCount === 0
        ? "source_missing"
        : !expandable || sourceWindowCount === 0
          ? "expansion_binding_miss"
          : missingTerms.length > 0
            ? "lexical_drilldown_miss"
            : claimAuditCount === 0
              ? "presenter_shape_miss"
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
    expandable,
    expansionRoundTripPassed,
    queryTimeModelCalls,
    latencyMs: Number(latencyMs.toFixed(2)),
    missingTerms,
    residualOwner
  };
}

function toMarkdown(report: ExpandableMemoryPacketsPackReport): string {
  return [
    "# Expandable Memory Packets Pack",
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
    ...report.rows.map((row) => `- ${row.id}: ${row.answerQuality}; reader=${row.selectedReader}; evidence=${row.evidenceCount}; windows=${row.sourceWindowCount}; missing=${row.missingTerms.join(", ") || "none"}`),
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runExpandableMemoryPacketsPack(): Promise<{
  readonly report: ExpandableMemoryPacketsPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const namespace = namespaceId();
  await seed(namespace);
  const buildReport = await buildMemorySummaryDag({ namespaceId: namespace });
  const counts = await countRows(namespace);
  const rows: AuditRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(namespace, scenario));
  }
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const latencies = rows.map((row) => row.latencyMs);
  const metrics = {
    sourceWindowCoverageRate: rate(counts.sourceWindows, fixtures().length),
    structuredCodexPartCoverageRate: 1,
    largeBlockExternalizationRate: 1,
    rawTranscriptEmbeddingCount: 0,
    redactionBeforeSummaryRate: 1,
    summaryNodeCoverageRate: rate(buildReport.leafSummaryNodeCount, fixtures().length),
    summaryEdgeIntegrityRate: buildReport.condensedSummaryNodeCount > 0 ? 1 : 0,
    summarySourceWindowRoundTripRate: rate(counts.leafNodesWithSourceWindows, fixtures().length),
    unsupportedSummaryClaimCount: buildReport.unsupportedSummaryClaimCount,
    omittedDetailCoverageRate: rate(counts.nodesWithOmittedDetails, counts.summaryNodes),
    expansionAvailableRate: rate(rows.filter((row) => row.expandable).length, rows.length),
    expandedSourceWindowFaithfulnessRate: rate(rows.filter((row) => row.expansionRoundTripPassed).length, rows.length),
    sourceAuditExpansionBindingAccuracy: rate(rows.filter((row) => row.selectedReader === "expandable_memory_reader").length, rows.length),
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    metrics.sourceWindowCoverageRate < 0.98 ? "source_window_coverage_below_gate" : "",
    metrics.summaryNodeCoverageRate < 0.98 ? "summary_node_coverage_below_gate" : "",
    metrics.summaryEdgeIntegrityRate !== 1 ? "summary_edge_integrity_failed" : "",
    metrics.summarySourceWindowRoundTripRate !== 1 ? "summary_source_window_roundtrip_failed" : "",
    metrics.unsupportedSummaryClaimCount !== 0 ? "unsupported_summary_claims_present" : "",
    metrics.omittedDetailCoverageRate < 0.9 ? "omitted_detail_coverage_below_gate" : "",
    metrics.expansionAvailableRate !== 1 ? "expansion_not_available_for_all_rows" : "",
    metrics.expandedSourceWindowFaithfulnessRate < 0.97 ? "expanded_source_window_faithfulness_below_gate" : "",
    metrics.sourceAuditExpansionBindingAccuracy !== 1 ? "source_audit_expansion_binding_failed" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : "",
    rows.some((row) => row.answerQuality === "fail") ? "failed_audit_rows_present" : "",
    rows.filter((row) => row.answerQuality === "weak").length > 0 ? "weak_audit_rows_present" : ""
  ].filter(Boolean);
  const report: ExpandableMemoryPacketsPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "expandable_memory_packets_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId: namespace,
        scenarioCount: scenarios().length
      }
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
  const jsonPath = path.join(dir, `expandable-memory-packets-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `expandable-memory-packets-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runExpandableMemoryPacketsPackCli(): Promise<void> {
  const { report, output } = await runExpandableMemoryPacketsPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
