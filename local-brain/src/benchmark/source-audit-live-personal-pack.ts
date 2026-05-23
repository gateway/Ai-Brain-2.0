import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar";
type LiveRating = "strong" | "weak" | "source_missing";
type ResidualOwner =
  | "missing_claim_audit"
  | "empty_source_trail"
  | "wrong_presenter_shape"
  | "wrong_family"
  | "section_support_missing"
  | "unsupported_prose"
  | "source_missing"
  | "latency_regression"
  | "none";

interface LiveScenario {
  readonly id: string;
  readonly query: string;
  readonly toolName: ToolName;
  readonly expectSourceAudit?: boolean;
}

export interface SourceAuditLivePersonalRow {
  readonly id: string;
  readonly query: string;
  readonly toolName: ToolName;
  readonly rating: LiveRating;
  readonly residualOwner: ResidualOwner;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly answerSectionCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answer: string;
  readonly notes: readonly string[];
}

export interface SourceAuditLivePersonalReport {
  readonly generatedAt: string;
  readonly benchmark: "source_audit_live_personal_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly strongCount: number;
    readonly weakCount: number;
    readonly sourceMissingCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly SourceAuditLivePersonalRow[];
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
    { id: "relationship_lauren", toolName: "memory.search", query: "Who is Lauren to me?" },
    { id: "relationship_lauren_source", toolName: "memory.search", query: "Where did the Lauren answer come from?", expectSourceAudit: true },
    { id: "career_full_history", toolName: "memory.search", query: "Give me my full work history with roles and dates." },
    { id: "career_roles_source", toolName: "memory.search", query: "Where did the Well Inked and Two-Way roles come from?", expectSourceAudit: true },
    { id: "dossier_lauren", toolName: "memory.recap", query: "Tell me everything about Lauren." },
    { id: "dossier_lauren_sources", toolName: "memory.recap", query: "Show the sources for each section.", expectSourceAudit: true },
    { id: "project_active_now", toolName: "memory.search", query: "What am I actively building now?" },
    { id: "project_active_source", toolName: "memory.search", query: "Where did that project list come from?", expectSourceAudit: true },
    { id: "temporal_july_travel", toolName: "memory.extract_calendar", query: "What trips did I mention for mid to late July?" },
    { id: "temporal_july_source", toolName: "memory.extract_calendar", query: "Where did the mid to late July travel answer come from?", expectSourceAudit: true },
    { id: "task_recent_travel", toolName: "memory.extract_tasks", query: "What tasks are still open from my recent travel planning notes?" },
    { id: "task_recent_travel_source", toolName: "memory.extract_tasks", query: "Where did those travel tasks come from?", expectSourceAudit: true }
  ];
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function payloadEvidenceCount(payload: any): number {
  if (typeof payload?.evidenceCount === "number") return payload.evidenceCount;
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence.length;
  if (Array.isArray(payload?.evidence)) return payload.evidence.length;
  if (Array.isArray(payload?.tasks)) return payload.tasks.length;
  if (Array.isArray(payload?.commitments)) return payload.commitments.length;
  return 0;
}

function classifyResidual(params: {
  readonly scenario: LiveScenario;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly answerSectionCount: number;
  readonly answer: string;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
}): { readonly rating: LiveRating; readonly residualOwner: ResidualOwner; readonly notes: readonly string[] } {
  const notes: string[] = [];
  if (params.queryTimeModelCalls > 0) {
    notes.push("query-time model call detected");
    return { rating: "weak", residualOwner: "wrong_presenter_shape", notes };
  }
  if (params.evidenceCount <= 0) {
    notes.push("no source-backed evidence returned");
    return { rating: "source_missing", residualOwner: "source_missing", notes };
  }
  if (params.sourceTrailCount <= 0) {
    notes.push("supported answer had empty sourceTrail");
    return { rating: "weak", residualOwner: "empty_source_trail", notes };
  }
  if (params.claimAuditCount <= 0) {
    notes.push("supported answer had no claimAudit entries");
    return { rating: "weak", residualOwner: "missing_claim_audit", notes };
  }
  if (params.scenario.expectSourceAudit && !params.answer.startsWith("Source trail:")) {
    notes.push("source-audit query did not render provenance first");
    return { rating: "weak", residualOwner: "wrong_presenter_shape", notes };
  }
  if (params.answerSectionCount > 0 && params.claimAuditCount < params.answerSectionCount) {
    notes.push("sectioned answer has fewer claimAudit entries than sections");
    return { rating: "weak", residualOwner: "section_support_missing", notes };
  }
  if (params.latencyMs > 10000) {
    notes.push("latency exceeded live personal audit budget");
    return { rating: "weak", residualOwner: "latency_regression", notes };
  }
  return { rating: "strong", residualOwner: "none", notes };
}

async function runScenario(scenario: LiveScenario): Promise<SourceAuditLivePersonalRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detail_mode: scenario.expectSourceAudit ? "compact" : "full"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceTrailCount = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  const claimAuditCount = Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
  const answerSectionCount = Array.isArray(payload?.answerSections) ? payload.answerSections.length : 0;
  const answer =
    typeof payload?.humanReadable?.answer === "string"
      ? payload.humanReadable.answer
      : typeof payload?.answer === "string"
        ? payload.answer
        : typeof payload?.summaryText === "string"
          ? payload.summaryText
          : "";
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const classification = classifyResidual({
    scenario,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    answerSectionCount,
    answer,
    queryTimeModelCalls,
    latencyMs
  });
  return {
    id: scenario.id,
    query: scenario.query,
    toolName: scenario.toolName,
    rating: classification.rating,
    residualOwner: classification.residualOwner,
    finalClaimSource: typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null,
    evidenceCount,
    sourceTrailCount,
    claimAuditCount,
    answerSectionCount,
    queryTimeModelCalls,
    latencyMs,
    answer,
    notes: classification.notes
  };
}

function summarizeMetrics(results: readonly SourceAuditLivePersonalRow[]): SourceAuditLivePersonalReport["metrics"] {
  const supportedRows = results.filter((row) => row.evidenceCount > 0);
  const latencies = results.map((row) => row.latencyMs);
  return {
    strongCount: results.filter((row) => row.rating === "strong").length,
    weakCount: results.filter((row) => row.rating === "weak").length,
    sourceMissingCount: results.filter((row) => row.rating === "source_missing").length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2))
  };
}

function reportPassed(report: SourceAuditLivePersonalReport): boolean {
  return (
    report.metrics.weakCount === 0 &&
    report.metrics.supportedEmptySourceTrailCount === 0 &&
    report.metrics.supportedMissingClaimAuditCount === 0 &&
    report.metrics.queryTimeModelCalls === 0
  );
}

function toMarkdown(report: SourceAuditLivePersonalReport): string {
  const lines = [
    "# Source Audit Live Personal Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    `- strongCount: ${report.metrics.strongCount}`,
    `- weakCount: ${report.metrics.weakCount}`,
    `- sourceMissingCount: ${report.metrics.sourceMissingCount}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: rating=${row.rating} residualOwner=${row.residualOwner} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} claimAudit=${row.claimAuditCount}`);
    lines.push(`  - answer: ${row.answer.replace(/\s+/gu, " ").slice(0, 320)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function questionAudit(report: SourceAuditLivePersonalReport): Record<string, unknown> {
  return {
    generatedAt: report.generatedAt,
    benchmark: "source_audit_question_audit",
    sourceBenchmark: report.benchmark,
    dominantResidualOwner:
      report.results
        .filter((row) => row.residualOwner !== "none")
        .reduce<Record<string, number>>((counts, row) => {
          counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
          return counts;
        }, {}),
    rows: report.results.map((row) => ({
      query: row.query,
      expectedFamily: row.toolName,
      expectedAnswerShape: row.id.includes("source") ? "source_audit" : "direct_answer",
      finalClaimSource: row.finalClaimSource,
      evidenceCount: row.evidenceCount,
      sourceCount: row.sourceTrailCount,
      queryTimeModelCalls: row.queryTimeModelCalls,
      residualOwner: row.residualOwner,
      missingTerms: [],
      wrongFamily: false,
      notes: row.notes
    }))
  };
}

export async function runAndWriteSourceAuditLivePersonalPack(): Promise<{
  readonly report: SourceAuditLivePersonalReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
    readonly questionAuditJsonPath: string;
    readonly questionAuditMarkdownPath: string;
  };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results: SourceAuditLivePersonalRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(scenario));
  }
  const report: SourceAuditLivePersonalReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "source_audit_live_personal_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        livePersonal: true,
        sequential: true,
        namespaceId: "personal"
      }
    }),
    sampleCount: results.length,
    passed: false,
    metrics: summarizeMetrics(results),
    results
  };
  const finalReport = { ...report, passed: reportPassed(report) };
  const audit = questionAudit(finalReport);
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `source-audit-live-personal-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-audit-live-personal-pack-${stamp}.md`);
  const questionAuditJsonPath = path.join(outputDir(), `source-audit-question-audit-${stamp}.json`);
  const questionAuditMarkdownPath = path.join(outputDir(), `source-audit-question-audit-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(finalReport), "utf8");
  await writeFile(questionAuditJsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await writeFile(questionAuditMarkdownPath, toMarkdown(finalReport).replace("Source Audit Live Personal Pack", "Source Audit Question Audit"), "utf8");
  return { report: finalReport, output: { jsonPath, markdownPath, questionAuditJsonPath, questionAuditMarkdownPath } };
}

export async function runSourceAuditLivePersonalPackCli(): Promise<void> {
  try {
    const { output } = await runAndWriteSourceAuditLivePersonalPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${output.questionAuditJsonPath}\n${output.questionAuditMarkdownPath}\n`);
  } finally {
    await closePool().catch(() => undefined);
  }
}
