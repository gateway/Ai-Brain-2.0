import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runAndWriteDocumentParserChunkingQualityPack } from "./document-parser-chunking-quality-pack.js";
import { runAndWriteIngestionQualityLedgerPack } from "./ingestion-quality-ledger-pack.js";
import { runAndWriteTaskEventLinkingPack } from "./task-event-linking-pack.js";
import { runAndWriteTemporalClarificationPack } from "./temporal-clarification-pack.js";
import { runAndWriteUniversalTaskEventProjectionPack } from "./universal-task-event-projection-pack.js";
import { percentile, rate } from "./query-benchmark-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Quality = "strong" | "weak" | "fail" | "source_missing";

interface ChildArtifact {
  readonly suite: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly passed: boolean;
  readonly metrics: Record<string, unknown>;
}

interface SelfHealingRow {
  readonly id: string;
  readonly suite: string;
  readonly corpus: string;
  readonly toolName: string;
  readonly query: string;
  readonly expectedAnswerShape: string | null;
  readonly expectedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly quality: Quality;
  readonly residualOwner: string;
  readonly passed: boolean;
}

interface SelfHealingLedgerRow {
  readonly rowId: string;
  readonly suite: string;
  readonly query: string;
  readonly residualOwner: string;
  readonly missingTerms: readonly string[];
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly suggestedFixLayer: string;
}

interface TemporalTaskSelfHealingPackReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_task_self_healing_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly sampleCount: number;
  readonly childArtifacts: readonly ChildArtifact[];
  readonly missLedgerArtifact: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
  readonly universalIngestionQualityLedgerArtifact: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  } | null;
  readonly dominantResidualOwner: string | null;
  readonly latencyHardeningBacklog: readonly {
    readonly source: string;
    readonly observation: string;
    readonly threshold: string;
    readonly recommendedSlice: string;
  }[];
  readonly metrics: {
    readonly totalRows: number;
    readonly strongCount: number;
    readonly weakCount: number;
    readonly failCount: number;
    readonly sourceMissingCount: number;
    readonly nonSourceMissingStrongRate: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly supportedZeroEvidenceCount: number;
    readonly missingExpectedTermRows: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
    readonly corpusCoverageCount: number;
    readonly suiteCoverageCount: number;
    readonly qualityLedgerRowsWritten: number;
    readonly latencyHardeningBacklogCount: number;
    readonly residualOwnerCounts: Record<string, number>;
  };
  readonly results: readonly SelfHealingRow[];
  readonly missLedgerRows: readonly SelfHealingLedgerRow[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function outputDir(): string {
  return path.resolve(thisDir(), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function corpusForRow(suite: string, row: Record<string, unknown>): string {
  if (typeof row.sourceKindFamily === "string") return row.sourceKindFamily;
  if (typeof row.sourceKind === "string") return row.sourceKind;
  if (suite === "temporal_clarification_pack") return "omi_markdown_temporal_fixture";
  if (suite === "universal_task_event_projection_pack") {
    const id = String(row.id ?? "");
    if (id.includes("codex")) return "codex";
    if (id.includes("omi")) return "omi";
    if (id.includes("calendar")) return "calendar_export";
    if (id.includes("documents") || id.includes("pdf")) return "pdf_docs";
    return "cross_source";
  }
  if (suite === "task_event_linking_pack") {
    const id = String(row.id ?? "");
    if (id.includes("pdf")) return "pdf_docs";
    if (id.includes("travel") || id.includes("trip")) return "omi_temporal";
    return "task_event";
  }
  if (suite === "document_parser_chunking_quality_pack") return "pdf_docs";
  if (suite === "ingestion_quality_ledger_pack") return "quality_ledger";
  return "unknown";
}

function residualOwnerFor(row: Record<string, unknown>): string {
  const residual = stringValue(row.residualOwner);
  if (residual && residual !== "null") return residual;
  if (row.passed === true) return "none";
  if (arrayOfStrings(row.missingTerms).length > 0) return "missing_expected_terms";
  if (numberValue(row.evidenceCount) <= 0) return "supported_zero_evidence";
  if (numberValue(row.sourceTrailCount) <= 0) return "empty_source_trail";
  if (numberValue(row.claimAuditCount) <= 0) return "missing_claim_audit";
  if (numberValue(row.queryTimeModelCalls) > 0) return "query_time_model_call";
  return "unknown";
}

function normalizeRow(suite: string, row: Record<string, unknown>, index: number): SelfHealingRow {
  const residualOwner = residualOwnerFor(row);
  const passed = row.passed === true && residualOwner === "none";
  const evidenceCount = numberValue(row.evidenceCount);
  const quality: Quality =
    passed ? "strong" : residualOwner === "source_missing" ? "source_missing" : evidenceCount <= 0 ? "fail" : "weak";
  return {
    id: `${suite}:${String(row.id ?? `row_${index + 1}`)}`,
    suite,
    corpus: corpusForRow(suite, row),
    toolName: String(row.toolName ?? "memory.search"),
    query: String(row.query ?? ""),
    expectedAnswerShape: stringValue(row.expectedAnswerShape),
    expectedTerms: arrayOfStrings(row.expectedTerms),
    missingTerms: arrayOfStrings(row.missingTerms),
    queryContract: stringValue(row.queryContract),
    retrievalDomain: stringValue(row.retrievalDomain),
    finalClaimSource: stringValue(row.finalClaimSource),
    evidenceCount,
    sourceTrailCount: numberValue(row.sourceTrailCount),
    claimAuditCount: numberValue(row.claimAuditCount),
    queryTimeModelCalls: numberValue(row.queryTimeModelCalls),
    latencyMs: numberValue(row.latencyMs),
    quality,
    residualOwner,
    passed
  };
}

function rowsFromReport(suite: string, report: { readonly results?: readonly unknown[] }): readonly SelfHealingRow[] {
  const rows = Array.isArray(report.results) ? report.results : [];
  return rows.map((row, index) => normalizeRow(suite, row as Record<string, unknown>, index));
}

function residualCounts(rows: readonly SelfHealingRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.residualOwner === "none") continue;
    counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
  }
  return counts;
}

function suggestedFixLayer(row: SelfHealingRow): string {
  switch (row.residualOwner) {
    case "missing_expected_terms":
      return "reader selection or presenter expected-term preservation";
    case "supported_zero_evidence":
    case "unsupported_no_evidence":
      return "typed reader or source-bound support selection";
    case "empty_source_trail":
      return "source-audit envelope propagation";
    case "missing_claim_audit":
      return "claim-audit adapter coverage";
    case "query_time_model_call":
      return "retrieval query-time model-call guard";
    case "source_missing":
      return "source acquisition or valid abstention";
    default:
      return "dominant residual owner investigation";
  }
}

function missLedgerRows(rows: readonly SelfHealingRow[]): readonly SelfHealingLedgerRow[] {
  return rows
    .filter((row) => row.quality !== "strong" && row.quality !== "source_missing")
    .map((row) => ({
      rowId: row.id,
      suite: row.suite,
      query: row.query,
      residualOwner: row.residualOwner,
      missingTerms: row.missingTerms,
      evidenceCount: row.evidenceCount,
      sourceTrailCount: row.sourceTrailCount,
      claimAuditCount: row.claimAuditCount,
      suggestedFixLayer: suggestedFixLayer(row)
    }));
}

function metricsForRows(rows: readonly SelfHealingRow[], missRows: readonly SelfHealingLedgerRow[], latencyBacklogCount: number): TemporalTaskSelfHealingPackReport["metrics"] {
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const nonSourceMissingRows = rows.filter((row) => row.quality !== "source_missing");
  const latencies = rows.map((row) => row.latencyMs);
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    failCount: rows.filter((row) => row.quality === "fail").length,
    sourceMissingCount: rows.filter((row) => row.quality === "source_missing").length,
    nonSourceMissingStrongRate: rate(nonSourceMissingRows.filter((row) => row.quality === "strong").length, nonSourceMissingRows.length),
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount <= 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount <= 0).length,
    supportedZeroEvidenceCount: rows.filter((row) => row.quality !== "source_missing" && row.evidenceCount <= 0 && !row.residualOwner.includes("clarification")).length,
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0 && row.quality !== "source_missing").length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2)),
    corpusCoverageCount: new Set(rows.map((row) => row.corpus)).size,
    suiteCoverageCount: new Set(rows.map((row) => row.suite)).size,
    qualityLedgerRowsWritten: missRows.length,
    latencyHardeningBacklogCount: latencyBacklogCount,
    residualOwnerCounts: residualCounts(rows)
  };
}

function renderMissLedgerMarkdown(rows: readonly SelfHealingLedgerRow[]): string {
  const lines = [
    "# Temporal Task Self-Healing Miss Ledger",
    "",
    rows.length === 0 ? "No weak or failing non-source-missing rows remain." : "Weak or failing rows are listed below by reusable residual owner.",
    ""
  ];
  for (const row of rows) {
    lines.push(`- ${row.rowId}: owner=${row.residualOwner}; layer=${row.suggestedFixLayer}; query=${row.query}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderReportMarkdown(report: TemporalTaskSelfHealingPackReport): string {
  return [
    "# Temporal Task Self-Healing Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- strong/weak/fail/sourceMissing: ${report.metrics.strongCount}/${report.metrics.weakCount}/${report.metrics.failCount}/${report.metrics.sourceMissingCount}`,
    `- nonSourceMissingStrongRate: ${report.metrics.nonSourceMissingStrongRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    `- dominantResidualOwner: ${report.dominantResidualOwner ?? "none"}`,
    `- latencyHardeningBacklogCount: ${report.metrics.latencyHardeningBacklogCount}`,
    "",
    "## Child Artifacts",
    "",
    ...report.childArtifacts.map((artifact) => `- ${artifact.suite}: passed=${artifact.passed} -> ${artifact.jsonPath}`),
    "",
    "## Rows",
    "",
    ...report.results.map(
      (row) =>
        `- ${row.id}: quality=${row.quality} owner=${row.residualOwner} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} claimAudit=${row.claimAuditCount} query="${row.query}"`
    ),
    "",
    "## Latency Hardening Backlog",
    "",
    ...report.latencyHardeningBacklog.map((item) => `- ${item.source}: ${item.observation}; threshold=${item.threshold}; next=${item.recommendedSlice}`),
    ""
  ].join("\n");
}

export async function runAndWriteTemporalTaskSelfHealingPack(): Promise<{
  readonly report: TemporalTaskSelfHealingPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const childRuns = [
    {
      suite: "temporal_clarification_pack",
      run: await runAndWriteTemporalClarificationPack()
    },
    {
      suite: "universal_task_event_projection_pack",
      run: await runAndWriteUniversalTaskEventProjectionPack()
    },
    {
      suite: "task_event_linking_pack",
      run: await runAndWriteTaskEventLinkingPack()
    },
    {
      suite: "document_parser_chunking_quality_pack",
      run: await runAndWriteDocumentParserChunkingQualityPack()
    },
    {
      suite: "ingestion_quality_ledger_pack",
      run: await runAndWriteIngestionQualityLedgerPack()
    }
  ];

  const childArtifacts: readonly ChildArtifact[] = childRuns.map((entry) => ({
    suite: entry.suite,
    jsonPath: entry.run.output.jsonPath,
    markdownPath: entry.run.output.markdownPath,
    passed: entry.run.report.passed === true,
    metrics: (entry.run.report.metrics ?? {}) as Record<string, unknown>
  }));
  const rows = childRuns.flatMap((entry) => rowsFromReport(entry.suite, entry.run.report));
  const misses = missLedgerRows(rows);
  const counts = residualCounts(rows);
  const dominantResidualOwner = Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  const ingestionLedgerRun = childRuns.find((entry) => entry.suite === "ingestion_quality_ledger_pack")?.run.report as
    | { readonly ledgerArtifact?: { readonly jsonPath: string; readonly markdownPath: string } }
    | undefined;
  const latencyHardeningBacklog = [
    {
      source: "mcp-query-taxonomy-gold-2026-05-29T04-25-43-818Z",
      observation: "MCP gold passed 60/60 but had one max-latency outlier at 12086.52ms while p95 remained 2904.11ms",
      threshold: "investigate max > 10000ms or repeated p95 > 3000ms",
      recommendedSlice: "Phase 6 latency hardening: inspect row-level stage timings, dominant stage, candidate counts, and route budget decisions before adding indexes or caches"
    }
  ];
  const metrics = metricsForRows(rows, misses, latencyHardeningBacklog.length);
  const generatedAt = new Date().toISOString();
  const report: TemporalTaskSelfHealingPackReport = {
    generatedAt,
    benchmark: "temporal_task_self_healing_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        childSuiteCount: childArtifacts.length,
        rowCount: rows.length
      }
    }),
    passed:
      childArtifacts.every((artifact) => artifact.passed) &&
      rows.length >= 20 &&
      metrics.nonSourceMissingStrongRate === 1 &&
      metrics.weakCount === 0 &&
      metrics.failCount === 0 &&
      metrics.queryTimeModelCalls === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.missingExpectedTermRows === 0,
    sampleCount: rows.length,
    childArtifacts,
    missLedgerArtifact: {
      jsonPath: "",
      markdownPath: ""
    },
    universalIngestionQualityLedgerArtifact: ingestionLedgerRun?.ledgerArtifact ?? null,
    dominantResidualOwner,
    latencyHardeningBacklog,
    metrics,
    results: rows,
    missLedgerRows: misses
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const missJsonPath = path.join(outputDir(), `temporal-task-self-healing-miss-ledger-${runStamp}.json`);
  const missMarkdownPath = path.join(outputDir(), `temporal-task-self-healing-miss-ledger-${runStamp}.md`);
  const finalReport = {
    ...report,
    missLedgerArtifact: {
      jsonPath: missJsonPath,
      markdownPath: missMarkdownPath
    }
  };
  const jsonPath = path.join(outputDir(), `temporal-task-self-healing-pack-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-task-self-healing-pack-${runStamp}.md`);
  await writeFile(missJsonPath, `${JSON.stringify({ generatedAt, benchmark: "temporal_task_self_healing_miss_ledger", rows: misses }, null, 2)}\n`, "utf8");
  await writeFile(missMarkdownPath, renderMissLedgerMarkdown(misses), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${renderReportMarkdown(finalReport)}\n`, "utf8");
  return { report: finalReport, output: { jsonPath, markdownPath } };
}

export async function runTemporalTaskSelfHealingPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalTaskSelfHealingPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics, dominantResidualOwner: report.dominantResidualOwner }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
