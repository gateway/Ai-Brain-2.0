import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

const LATENCY_TAIL_THRESHOLD_MS = 5000;

interface LiveScenario {
  readonly id: string;
  readonly query: string;
}

interface LiveRow extends LiveScenario {
  readonly quality: "strong" | "acceptable" | "weak" | "source_missing";
  readonly queryContract: string | null;
  readonly finalClaimSource: string | null;
  readonly selectedReader: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly suggestionCount: number;
  readonly unsupportedInsightClaimCount: number;
  readonly unsupportedSuggestionCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
}

interface UniversalInsightLivePersonalPackReport {
  readonly generatedAt: string;
  readonly benchmark: "universal_insight_live_personal_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: "personal";
  readonly passed: boolean;
  readonly metrics: {
    readonly totalRows: number;
    readonly strongRows: number;
    readonly acceptableRows: number;
    readonly weakRows: number;
    readonly sourceMissingRows: number;
    readonly nonSourceMissingPassRate: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly unsupportedInsightClaimCount: number;
    readonly unsupportedSuggestionCount: number;
    readonly queryTimeModelCalls: number;
    readonly latencyTailThresholdMs: number;
    readonly latencyTailRows: number;
    readonly latencyTailRowIds: readonly string[];
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly LiveRow[];
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

function scenarios(): readonly LiveScenario[] {
  return [
    { id: "codex_token_waste", query: "What token waste patterns show up in Codex sessions, with examples and suggested fixes?" },
    { id: "codex_repeated_instructions", query: "What repeated instructions have I given Codex, and what should become an agent rule?" },
    { id: "omi_travel_learning", query: "What did we learn from my recent OMI travel planning notes?" },
    { id: "pdf_temporal_research", query: "What did the temporal KG papers suggest we should add to AI Brain?" },
    { id: "repo_checkpoint_weaknesses", query: "What recurring weaknesses are documented across the latest checkpoints?" },
    { id: "tasks_from_retrieval_weakness", query: "What tasks should be generated from the current retrieval weaknesses?" },
    { id: "calendar_commitments", query: "What calendar-like commitments are implied by the latest OMI notes?" },
    { id: "evidence_gaps", query: "What are the biggest evidence gaps across Codex, OMI, PDFs, and tasks?" },
    { id: "skill_candidates", query: "What should become a new skill, automation, or checklist?" },
    { id: "overall_learning", query: "What did we learn overall, what should we do next, and where are the sources?" }
  ];
}

function structuredContent(result: unknown): Record<string, any> {
  if (!result || typeof result !== "object") return {};
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, any>) : {};
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

async function runScenario(scenario: LiveScenario): Promise<LiveRow> {
  const startedAt = performance.now();
  const result = await executeMcpTool("memory.search", {
    namespace_id: "personal",
    query: scenario.query,
    detail_mode: "full",
    limit: 8
  });
  const latencyMs = performance.now() - startedAt;
  const payload = structuredContent(result);
  const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
  const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
  const suggestionCount = Array.isArray(payload.suggestions) ? payload.suggestions.length : 0;
  const verification = payload.insightVerification && typeof payload.insightVerification === "object" ? payload.insightVerification : {};
  const unsupportedInsightClaimCount = typeof verification.unsupportedInsightClaimCount === "number" ? verification.unsupportedInsightClaimCount : 0;
  const unsupportedSuggestionCount = typeof verification.unsupportedSuggestionCount === "number" ? verification.unsupportedSuggestionCount : 0;
  const queryTimeModelCalls = typeof verification.queryTimeModelCalls === "number" ? verification.queryTimeModelCalls : typeof payload.queryTimeModelCalls === "number" ? payload.queryTimeModelCalls : 0;
  const quality: LiveRow["quality"] =
    evidenceCount === 0
      ? "source_missing"
      : payload.queryContract === "insight_report" &&
          payload.finalClaimSource === "insight_report" &&
          sourceTrailCount > 0 &&
          claimAuditCount > 0 &&
          suggestionCount > 0 &&
          unsupportedInsightClaimCount === 0 &&
          unsupportedSuggestionCount === 0
        ? "strong"
        : sourceTrailCount > 0 && claimAuditCount > 0 && unsupportedInsightClaimCount === 0 && unsupportedSuggestionCount === 0
          ? "acceptable"
          : "weak";
  const residualOwner =
    (quality === "strong" || quality === "acceptable") && latencyMs > LATENCY_TAIL_THRESHOLD_MS
      ? "latency_tail"
      : quality === "strong" || quality === "acceptable"
      ? null
      : quality === "source_missing"
        ? "source_missing"
        : sourceTrailCount === 0 || claimAuditCount === 0
          ? "missing_source_or_claim_audit"
          : unsupportedInsightClaimCount > 0 || unsupportedSuggestionCount > 0
            ? "unsupported_insight_or_suggestion"
            : "presenter_or_route_shape";
  return {
    ...scenario,
    quality,
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    selectedReader: typeof payload.selectedReader === "string" ? payload.selectedReader : null,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    suggestionCount,
    unsupportedInsightClaimCount,
    unsupportedSuggestionCount,
    queryTimeModelCalls,
    latencyMs: Number(latencyMs.toFixed(2)),
    residualOwner
  };
}

function toMarkdown(report: UniversalInsightLivePersonalPackReport): string {
  return [
    "# Universal Insight Live Personal Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Metrics",
    "",
    ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Rows",
    "",
    ...report.rows.map((row) => `- ${row.id}: ${row.quality}; contract=${row.queryContract}; source=${row.finalClaimSource}; evidence=${row.evidenceCount}; sources=${row.sourceTrailCount}; suggestions=${row.suggestionCount}; owner=${row.residualOwner ?? "none"}`),
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runUniversalInsightLivePersonalPack(): Promise<{
  readonly report: UniversalInsightLivePersonalPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const rows: LiveRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(scenario));
  }
  const nonSourceRows = rows.filter((row) => row.quality !== "source_missing");
  const latencies = rows.map((row) => row.latencyMs);
  const metrics = {
    totalRows: rows.length,
    strongRows: rows.filter((row) => row.quality === "strong").length,
    acceptableRows: rows.filter((row) => row.quality === "acceptable").length,
    weakRows: rows.filter((row) => row.quality === "weak").length,
    sourceMissingRows: rows.filter((row) => row.quality === "source_missing").length,
    nonSourceMissingPassRate: rate(nonSourceRows.filter((row) => row.quality === "strong" || row.quality === "acceptable").length, nonSourceRows.length),
    supportedEmptySourceTrailCount: nonSourceRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: nonSourceRows.filter((row) => row.claimAuditCount === 0).length,
    unsupportedInsightClaimCount: rows.reduce((sum, row) => sum + row.unsupportedInsightClaimCount, 0),
    unsupportedSuggestionCount: rows.reduce((sum, row) => sum + row.unsupportedSuggestionCount, 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    latencyTailThresholdMs: LATENCY_TAIL_THRESHOLD_MS,
    latencyTailRows: rows.filter((row) => row.latencyMs > LATENCY_TAIL_THRESHOLD_MS).length,
    latencyTailRowIds: rows.filter((row) => row.latencyMs > LATENCY_TAIL_THRESHOLD_MS).map((row) => row.id),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(...latencies, 0).toFixed(2))
  };
  const failures = [
    metrics.weakRows !== 0 ? "weak_rows_present" : "",
    metrics.nonSourceMissingPassRate !== 1 ? "non_source_missing_pass_rate_below_gate" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "supported_empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "supported_missing_claim_audit" : "",
    metrics.unsupportedInsightClaimCount !== 0 ? "unsupported_insight_claims_present" : "",
    metrics.unsupportedSuggestionCount !== 0 ? "unsupported_suggestions_present" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_used" : ""
  ].filter(Boolean);
  const report: UniversalInsightLivePersonalPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "universal_insight_live_personal_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId: "personal", scenarioCount: scenarios().length }
    }),
    namespaceId: "personal",
    passed: failures.length === 0,
    metrics,
    rows,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `universal-insight-live-personal-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `universal-insight-live-personal-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runUniversalInsightLivePersonalPackCli(): Promise<void> {
  const { report, output } = await runUniversalInsightLivePersonalPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
