import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildMemoryFocusPacket, buildMemorySummaryDag, upsertMemorySourceWindow, type MemoryPacketSourceKind } from "../memory-packets/service.js";
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

interface PresenterRow extends Scenario {
  readonly passed: boolean;
  readonly answer: string | null;
  readonly selectedReader: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly answerPresentationTracePresent: boolean;
  readonly missingTerms: readonly string[];
  readonly sourceWindowPrefixLeak: boolean;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
}

interface ExpandableMemoryPresenterPackReport {
  readonly generatedAt: string;
  readonly benchmark: "expandable_memory_presenter_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly totalQueries: number;
    readonly topLevelAnswerCoverageRate: number;
    readonly compactAnswerHumanReadableRate: number;
    readonly sourceWindowPrefixLeakCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly missingPresentationTraceCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly PresenterRow[];
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
  return `fixture_expandable_presenter_${stamp().toLowerCase()}`;
}

function fixtures(): readonly FixtureWindow[] {
  return [
    {
      sourceKind: "codex_session",
      sourceUri: "codex://codex-memory/session-token-waste",
      key: "presenter-codex-token-waste",
      text: "Codex memory analytics flagged token waste from rereading large docs, repeated test logs, oversized prompts, stale task lists, missing compact memory packets, and missing compact context packets."
    },
    {
      sourceKind: "pdf",
      sourceUri: "pdf://temporal-kg-paper.pdf#page=4",
      key: "presenter-pdf-temporal-kg",
      text: "Temporal knowledge graph paper notes recommend separating event time from dialogue time, preserving temporal support paths, and using time-window constraints before vector recall."
    },
    {
      sourceKind: "omi_note",
      sourceUri: "omi://2026-05-18/friends-chiang-mai",
      key: "presenter-omi-friends",
      text: "The Chiang Mai friends note mentioned Dan, Gummi, Tim, and Ben as people connected through local meetups and coworking-style social context."
    },
    {
      sourceKind: "task_export",
      sourceUri: "task-export://query-contract-work",
      key: "presenter-task-query-contract",
      text: "Query contract tasks include finish projection audit, review MCP Studio wiring, add stable queryContract metadata, and verify sourceTrail for supported answers."
    },
    {
      sourceKind: "repo_doc",
      sourceUri: "repo://ai-brain/package.json#scripts",
      key: "presenter-repo-package-scripts",
      text: "The package scripts include benchmark:mcp-query-taxonomy-gold, benchmark:source-audit-cross-family-pack, benchmark:clean-main-smoke-stack, and benchmark:expandable-memory-packets-pack."
    }
  ];
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "codex_token_waste",
      query: "What Codex token waste patterns were flagged in source windows?",
      expectedTerms: ["rereading large docs", "repeated test logs"]
    },
    {
      id: "pdf_temporal_kg",
      query: "Summarize the temporal KG paper source window about event time and dialogue time.",
      expectedTerms: ["event time", "dialogue time"]
    },
    {
      id: "omi_chiang_mai_people",
      query: "Who were the Chiang Mai people mentioned in the OMI source window?",
      expectedTerms: ["Dan", "Gummi", "Tim", "Ben"]
    },
    {
      id: "task_mcp_studio_wiring",
      query: "Which task source says review MCP Studio wiring?",
      expectedTerms: ["review MCP Studio wiring"]
    },
    {
      id: "repo_clean_main_gates",
      query: "Show evidence for clean-main gates and cross-family source audit.",
      expectedTerms: ["benchmark:clean-main-smoke-stack", "benchmark:source-audit-cross-family-pack"]
    }
  ];
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

function includesTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(term.toLowerCase());
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

function hasSourceWindowPrefixLeak(answer: string | null): boolean {
  if (!answer) return false;
  return /\b(?:codex session|pdf|omi note|repo doc|task export|calendar export|markdown|other)\s+source\s+window\s*:/iu.test(answer) || /\bsource window\s*:/iu.test(answer) || /\bpacket summary\s*:/iu.test(answer);
}

async function seed(namespace: string): Promise<void> {
  for (const [index, fixture] of fixtures().entries()) {
    await upsertMemorySourceWindow({
      namespaceId: namespace,
      artifactId: `artifact-${fixture.key}`,
      sourceWindowKey: fixture.key,
      sourceKind: fixture.sourceKind,
      sourceUri: fixture.sourceUri,
      startLocator: `presenter:${index}:start`,
      endLocator: `presenter:${index}:end`,
      text: fixture.text,
      capturedAt: "2026-05-31T00:00:00.000Z",
      occurredAt: "2026-05-31T00:00:00.000Z",
      metadata: {
        fixture: true,
        audit: "expandable_memory_presenter_pack",
        redaction_checked: true,
        large_block_externalized: true
      }
    });
  }
}

async function runScenario(namespace: string, scenario: Scenario): Promise<PresenterRow> {
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: namespace,
    query: scenario.query,
    detail_mode: "compact",
    limit: 8
  });
  const latencyMs = performance.now() - startedAt;
  const payload = structuredContent(result);
  const answer = typeof payload.answer === "string" && payload.answer.trim() ? payload.answer.trim() : null;
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const queryTimeModelCalls = typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const selectedReader = typeof payload.selectedReader === "string" ? payload.selectedReader : null;
  const finalClaimSource = typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null;
  const answerPresentationTracePresent = Boolean(payload.answerPresentationTrace && typeof payload.answerPresentationTrace === "object");
  const missingTerms = scenario.expectedTerms.filter((term) => !includesTerm(answer, term));
  const sourceWindowPrefixLeak = hasSourceWindowPrefixLeak(answer);
  const passed =
    evidenceCount > 0 &&
    sourceTrailCount > 0 &&
    claimAuditCount > 0 &&
    answerPresentationTracePresent &&
    answer !== null &&
    missingTerms.length === 0 &&
    !sourceWindowPrefixLeak &&
    queryTimeModelCalls === 0;
  const residualOwner = passed
    ? null
    : answer === null
      ? "missing_top_level_answer"
      : sourceWindowPrefixLeak
        ? "source_window_prefix_leak"
        : missingTerms.length > 0
          ? "answer_term_loss"
          : sourceTrailCount === 0 || claimAuditCount === 0
            ? "contract_envelope_regression"
            : !answerPresentationTracePresent
              ? "missing_presentation_trace"
              : queryTimeModelCalls !== 0
                ? "query_time_model_call_regression"
                : "unknown_owner";
  return {
    ...scenario,
    passed,
    answer,
    selectedReader,
    finalClaimSource,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    answerPresentationTracePresent,
    missingTerms,
    sourceWindowPrefixLeak,
    queryTimeModelCalls,
    latencyMs: Number(latencyMs.toFixed(2)),
    residualOwner
  };
}

function toMarkdown(report: ExpandableMemoryPresenterPackReport): string {
  return [
    "# Expandable Memory Presenter Pack",
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
    ...report.rows.map((row) => `- ${row.id}: ${row.passed ? "passed" : "failed"}; answer=${row.answer ?? "none"}; missing=${row.missingTerms.join(", ") || "none"}; leak=${row.sourceWindowPrefixLeak}; latencyMs=${row.latencyMs}`),
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runExpandableMemoryPresenterPack(): Promise<{
  readonly report: ExpandableMemoryPresenterPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const namespace = namespaceId();
  await seed(namespace);
  await buildMemorySummaryDag({ namespaceId: namespace });
  await buildMemoryFocusPacket({
    namespaceId: namespace,
    prompt: "Expandable presenter context packet for Codex PDF OMI task and repo docs",
    packetType: "agent_start",
    projects: ["AI Brain", "Codex Memory"]
  });

  const rows: PresenterRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(namespace, scenario));
  }

  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const latencies = rows.map((row) => row.latencyMs);
  const metrics = {
    totalQueries: rows.length,
    topLevelAnswerCoverageRate: rate(rows.filter((row) => row.answer !== null).length, rows.length),
    compactAnswerHumanReadableRate: rate(rows.filter((row) => row.answer !== null && row.missingTerms.length === 0 && !row.sourceWindowPrefixLeak).length, rows.length),
    sourceWindowPrefixLeakCount: rows.filter((row) => row.sourceWindowPrefixLeak).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    missingPresentationTraceCount: rows.filter((row) => !row.answerPresentationTracePresent).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    metrics.topLevelAnswerCoverageRate !== 1 ? "top_level_answer_coverage_below_gate" : "",
    metrics.compactAnswerHumanReadableRate !== 1 ? "compact_answer_human_readable_rate_below_gate" : "",
    metrics.sourceWindowPrefixLeakCount !== 0 ? "source_window_prefix_leak_present" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.missingPresentationTraceCount !== 0 ? "missing_presentation_trace" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : "",
    metrics.p95LatencyMs > 3000 ? "p95_latency_above_gate" : "",
    metrics.maxLatencyMs > 8000 ? "max_latency_above_gate" : "",
    ...rows.filter((row) => !row.passed).map((row) => `${row.id}:${row.residualOwner ?? "failed"}`)
  ].filter(Boolean);
  const report: ExpandableMemoryPresenterPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "expandable_memory_presenter_pack",
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
  const jsonPath = path.join(dir, `expandable-memory-presenter-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `expandable-memory-presenter-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runExpandableMemoryPresenterPackCli(): Promise<void> {
  const { report, output } = await runExpandableMemoryPresenterPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
