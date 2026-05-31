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

interface FocusPacketRow {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly answerQuality: "strong" | "weak" | "fail";
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly summaryNodeCount: number;
  readonly sourceWindowCount: number;
  readonly expansionTraceCount: number;
  readonly selectedReader: string | null;
  readonly finalClaimSource: string | null;
  readonly missingTerms: readonly string[];
  readonly latencyMs: number;
  readonly queryTimeModelCalls: number;
  readonly residualOwner: string | null;
}

interface FocusPacketPackReport {
  readonly generatedAt: string;
  readonly benchmark: "focus_packet_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly sourceCoverageRate: number;
    readonly staleSourceDetectionAccuracy: number;
    readonly packetReuseTraceCoverageRate: number;
    readonly unsupportedClaimCount: number;
    readonly tokenReductionRate: number;
    readonly focusPacketQueryStrongRate: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly FocusPacketRow[];
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
  return `fixture_focus_packet_${stamp().toLowerCase()}`;
}

function fixtures(): readonly FixtureWindow[] {
  return [
    {
      sourceKind: "codex_session",
      sourceUri: "codex://media-studio/session-focus-001",
      key: "focus-codex-media-studio-001",
      text: "Media Studio Codex work repeatedly asked for no hardcoded patches, no one-off Media Studio-only routing, reusable project-detail retrieval, updated task lists, and verification gates before signoff. The session emphasized natural-language project questions, source-bound summaries, and broad fixes that work for any project."
    },
    {
      sourceKind: "codex_session",
      sourceUri: "codex://ai-brain/session-focus-002",
      key: "focus-codex-ai-brain-002",
      text: "AI Brain Codex sessions repeatedly asked for benchmark-backed development, changelog updates, task-list checkoffs, clean-main smoke gates, MCP query validation, and retrieval fixes at planner or reader layers rather than prompt hacks."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://agent-memory-paper.pdf#section=hierarchical-context",
      key: "focus-pdf-agent-memory-001",
      text: "Agent memory research notes describe hierarchical summaries, source-window expansion, compact context packets, lexical drilldown, and preserving source spans so a compact answer can expand back to evidence without making the summary authoritative."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/temporal-travel-note",
      key: "focus-omi-travel-001",
      text: "The OMI note mentioned mid to late July travel, Chiang Mai flight planning, September travel after Burning Man, task follow-ups, and the need for source-scope queries to stay bound to the latest note."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/brain-spec/local/expandable-memory-packets-production-spec.md",
      key: "focus-repo-expandable-spec-001",
      text: "The expandable memory packet spec defines summary nodes, source windows, focus packets, expansion traces, source trails, claim audit coverage, and a fifty-query cross-corpus audit before signoff."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://expandable-memory-task-list",
      key: "focus-task-expandable-001",
      text: "The task list includes Phase 4 focus packets, Phase 5 source-window lexical drilldown, Phase 6 cross-corpus query audit, benchmark artifacts, changelog updates, and checkpoint documentation."
    }
  ];
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
      startLocator: `focus:${index}:start`,
      endLocator: `focus:${index}:end`,
      text: fixture.text,
      capturedAt: "2026-05-30T00:00:00.000Z",
      occurredAt: "2026-05-30T00:00:00.000Z",
      metadata: {
        fixture: true,
        phase: "focus_packet_pack",
        redaction_checked: true,
        large_block_externalized: true
      }
    });
  }
}

async function runFocusQuery(namespace: string): Promise<FocusPacketRow> {
  const query = "Generate a focus packet for AI Brain expandable memory source windows and show prior reused packets.";
  const expectedTerms = ["AI Brain", "source windows", "focus packets", "cross-corpus audit"];
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: namespace,
    query,
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
  const missingTerms = expectedTerms.filter((term) => !includesTerm(payload, term));
  const queryTimeModelCalls = typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const answerQuality: FocusPacketRow["answerQuality"] =
    evidenceCount > 0 && sourceTrailCount > 0 && claimAuditCount > 0 && summaryNodeCount > 0 && sourceWindowCount > 0 && expansionTraceCount > 0 && missingTerms.length === 0
      ? "strong"
      : evidenceCount > 0
        ? "weak"
        : "fail";
  const residualOwner =
    answerQuality === "strong"
      ? null
      : evidenceCount === 0
        ? "focus_packet_source_missing"
        : missingTerms.length > 0
          ? "focus_packet_term_miss"
          : sourceTrailCount === 0 || claimAuditCount === 0
            ? "presenter_shape_miss"
            : "focus_packet_expansion_trace_miss";
  return {
    id: "focus_packet_reuse_query",
    query,
    expectedTerms,
    answerQuality,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    summaryNodeCount,
    sourceWindowCount,
    expansionTraceCount,
    selectedReader: typeof payload.selectedReader === "string" ? payload.selectedReader : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    missingTerms,
    latencyMs: Number(latencyMs.toFixed(2)),
    queryTimeModelCalls,
    residualOwner
  };
}

function toMarkdown(report: FocusPacketPackReport): string {
  return [
    "# Focus Packet Pack",
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

export async function runFocusPacketPack(): Promise<{
  readonly report: FocusPacketPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const namespace = namespaceId();
  await seed(namespace);
  await buildMemorySummaryDag({ namespaceId: namespace });
  const first = await buildMemoryFocusPacket({
    namespaceId: namespace,
    prompt: "Media Studio and AI Brain reusable project-detail retrieval focus packet with task lists and verification gates",
    packetType: "agent_start",
    projects: ["Media Studio", "AI Brain"]
  });
  const second = await buildMemoryFocusPacket({
    namespaceId: namespace,
    prompt: "AI Brain expandable memory source windows focus packet for cross-corpus audit and prior packet reuse",
    packetType: "agent_start",
    projects: ["AI Brain"]
  });
  const row = await runFocusQuery(namespace);
  const latencies = [row.latencyMs];
  const metrics = {
    sourceCoverageRate: second.sourceCoverageRate,
    staleSourceDetectionAccuracy: second.staleDetected ? 0 : 1,
    packetReuseTraceCoverageRate: second.packet.reused_packet_ids.length > 0 ? second.packetReuseTraceCoverageRate : 0,
    unsupportedClaimCount: first.unsupportedClaimCount + second.unsupportedClaimCount,
    tokenReductionRate: Math.max(0, Number(((first.tokenReductionRate + second.tokenReductionRate) / 2).toFixed(4))),
    focusPacketQueryStrongRate: row.answerQuality === "strong" ? 1 : 0,
    supportedEmptySourceTrailCount: row.evidenceCount > 0 && row.sourceTrailCount === 0 ? 1 : 0,
    supportedMissingClaimAuditCount: row.evidenceCount > 0 && row.claimAuditCount === 0 ? 1 : 0,
    queryTimeModelCalls: row.queryTimeModelCalls,
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    metrics.sourceCoverageRate < 1 ? "focus_packet_source_coverage_below_gate" : "",
    metrics.staleSourceDetectionAccuracy !== 1 ? "stale_source_detection_failed" : "",
    metrics.packetReuseTraceCoverageRate < 1 ? "packet_reuse_trace_missing" : "",
    metrics.unsupportedClaimCount !== 0 ? "unsupported_focus_packet_claims_present" : "",
    metrics.tokenReductionRate <= 0 ? "token_reduction_missing" : "",
    metrics.focusPacketQueryStrongRate !== 1 ? "focus_packet_query_not_strong" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : ""
  ].filter(Boolean);
  const report: FocusPacketPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "focus_packet_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: namespace, fixtureCount: fixtures().length }
    }),
    namespaceId: namespace,
    passed: failures.length === 0,
    metrics,
    rows: [row],
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `focus-packet-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `focus-packet-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runFocusPacketPackCli(): Promise<void> {
  const { report, output } = await runFocusPacketPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
