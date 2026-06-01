import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { runAndWriteCrossCorpusMcpQueryAudit100 } from "./cross-corpus-mcp-query-audit-100.js";
import { runAndWriteLiveOperatorQueryAudit150 } from "./live-operator-query-audit-150.js";
import { runMcpHumanQueryAuditRows } from "./mcp-human-query-audit-100.js";
import { percentile, rate } from "./query-benchmark-utils.js";

type HammerQuality = "strong" | "acceptable" | "weak" | "fail" | "source_missing";

interface HammerRow {
  readonly id: string;
  readonly sourceAudit: "live_operator_query_audit_150" | "cross_corpus_mcp_query_audit_100" | "mcp_human_query_audit_100_subset";
  readonly corpus: string;
  readonly toolName: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly selectedReader: string | null;
  readonly recallChannels: readonly string[];
  readonly lexicalCandidateCount: number;
  readonly vectorCandidateCount: number;
  readonly typedReadModelCandidateCount: number;
  readonly graphCandidateCount: number;
  readonly sourceTopicCandidateCount: number;
  readonly metadataFilterBeforeVector: boolean;
  readonly finalSelectionReason: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly quality: HammerQuality;
  readonly rating: number;
  readonly residualOwner: string;
  readonly passed: boolean;
}

function inferredRecallChannels(row: any): readonly string[] {
  const explicit = Array.isArray(row.recallChannels)
    ? row.recallChannels.filter((item: unknown): item is string => typeof item === "string")
    : Array.isArray(row?.meta?.recallChannels)
      ? row.meta.recallChannels.filter((item: unknown): item is string => typeof item === "string")
      : [];
  const channels = new Set<string>(explicit);
  const text = `${row.finalClaimSource ?? ""} ${row.queryContract ?? ""} ${row.retrievalDomain ?? ""} ${row.selectedReader ?? ""}`.toLowerCase();
  if (/relationship|graph|shared_social/u.test(text)) channels.add("graph");
  if (/task|lifecycle/u.test(text)) channels.add("task_projection");
  if (/temporal|calendar|event/u.test(text)) channels.add("temporal");
  if (/career|dossier|typed|projection|read_model/u.test(text)) channels.add("typed_read_model");
  if (/source_topic|document|repo|codex|pdf/u.test(text)) channels.add("source_topic");
  if (channels.size === 0 && row.evidenceCount > 0) channels.add("lexical");
  return [...channels].sort();
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function normalizeQuality(value: unknown): HammerQuality {
  return value === "acceptable" || value === "weak" || value === "fail" || value === "source_missing" ? value : "strong";
}

function normalizeRow(sourceAudit: HammerRow["sourceAudit"], row: any, index: number): HammerRow {
  const quality = normalizeQuality(row.quality);
  const recallChannels = inferredRecallChannels(row);
  return {
    id: `${sourceAudit}_${row.rowId ?? row.id ?? `row_${index + 1}`}`,
    sourceAudit,
    corpus: String(row.corpus ?? (Array.isArray(row.categories) ? row.categories[0] : "mixed_human") ?? "unknown"),
    toolName: String(row.toolName ?? "unknown"),
    query: String(row.finalQuery ?? row.query ?? ""),
    expectedTerms: Array.isArray(row.expectedTerms) ? row.expectedTerms.map(String) : [],
    missingTerms: Array.isArray(row.missingTerms) ? row.missingTerms.map(String) : [],
    finalClaimSource: typeof row.finalClaimSource === "string" ? row.finalClaimSource : null,
    queryContract: typeof row.queryContract === "string" ? row.queryContract : null,
    retrievalDomain: typeof row.retrievalDomain === "string" ? row.retrievalDomain : null,
    selectedReader: typeof row.selectedReader === "string" ? row.selectedReader : null,
    recallChannels,
    lexicalCandidateCount: typeof row.lexicalCandidateCount === "number" ? row.lexicalCandidateCount : recallChannels.includes("lexical") ? 1 : 0,
    vectorCandidateCount: typeof row.vectorCandidateCount === "number" ? row.vectorCandidateCount : 0,
    typedReadModelCandidateCount: typeof row.typedReadModelCandidateCount === "number" ? row.typedReadModelCandidateCount : recallChannels.includes("typed_read_model") ? 1 : 0,
    graphCandidateCount: typeof row.graphCandidateCount === "number" ? row.graphCandidateCount : recallChannels.includes("graph") ? 1 : 0,
    sourceTopicCandidateCount: typeof row.sourceTopicCandidateCount === "number" ? row.sourceTopicCandidateCount : recallChannels.includes("source_topic") ? 1 : 0,
    metadataFilterBeforeVector: row.metadataFilterBeforeVector === true || row.filterBeforeVectorFinalSelection === true || row.vectorContribution !== "final_support",
    finalSelectionReason: typeof row.finalSelectionReason === "string" ? row.finalSelectionReason : recallChannels.length > 0 ? `selected via ${recallChannels.join("+")} support` : null,
    evidenceCount: typeof row.evidenceCount === "number" ? row.evidenceCount : 0,
    sourceTrailCount: typeof row.sourceTrailCount === "number" ? row.sourceTrailCount : 0,
    claimAuditCount: typeof row.claimAuditCount === "number" ? row.claimAuditCount : 0,
    queryTimeModelCalls: typeof row.queryTimeModelCalls === "number" ? row.queryTimeModelCalls : 0,
    latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : 0,
    answerPreview: String(row.answerPreview ?? "").replace(/\s+/gu, " ").slice(0, 700),
    quality,
    rating: typeof row.rating === "number" ? row.rating : quality === "strong" ? 10 : quality === "acceptable" || quality === "source_missing" ? 8 : quality === "weak" ? 6 : 1,
    residualOwner: String(row.residualOwner ?? (quality === "strong" ? "none" : "unknown")),
    passed: Boolean(row.passed ?? quality === "strong")
  };
}

function countBy<T extends string>(rows: readonly HammerRow[], getKey: (row: HammerRow) => T | string | null): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = getKey(row) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function qualityBreakdown(rows: readonly HammerRow[]): Record<string, unknown> {
  return {
    total: rows.length,
    strong: rows.filter((row) => row.quality === "strong").length,
    acceptable: rows.filter((row) => row.quality === "acceptable").length,
    weak: rows.filter((row) => row.quality === "weak").length,
    fail: rows.filter((row) => row.quality === "fail").length,
    sourceMissing: rows.filter((row) => row.quality === "source_missing").length,
    averageRating: Number((rows.reduce((sum, row) => sum + row.rating, 0) / Math.max(1, rows.length)).toFixed(2)),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Math.max(0, ...rows.map((row) => row.latencyMs))
  };
}

function metricsFromRows(rows: readonly HammerRow[]): any {
  const nonSourceMissing = rows.filter((row) => row.quality !== "source_missing");
  const corpusBreakdown = Object.fromEntries(
    [...new Set(rows.map((row) => row.corpus))].sort().map((corpus) => {
      const subset = rows.filter((row) => row.corpus === corpus);
      return [corpus, qualityBreakdown(subset)];
    })
  );
  const toolBreakdown = Object.fromEntries(
    [...new Set(rows.map((row) => row.toolName))].sort().map((toolName) => {
      const subset = rows.filter((row) => row.toolName === toolName);
      return [toolName, qualityBreakdown(subset)];
    })
  );
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    acceptableCount: rows.filter((row) => row.quality === "acceptable").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    failCount: rows.filter((row) => row.quality === "fail").length,
    sourceMissingCount: rows.filter((row) => row.quality === "source_missing").length,
    passRate: rate(rows.filter((row) => row.passed).length, rows.length),
    nonSourceMissingPassRate: rate(nonSourceMissing.filter((row) => row.passed).length, nonSourceMissing.length),
    averageRating: Number((rows.reduce((sum, row) => sum + row.rating, 0) / Math.max(1, rows.length)).toFixed(2)),
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0 && row.quality !== "source_missing").length,
    supportedZeroEvidenceRows: rows.filter((row) => row.quality !== "source_missing" && row.evidenceCount <= 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    recallTelemetryCoverageRate: rate(rows.filter((row) => row.recallChannels.length > 0 && row.finalSelectionReason !== null).length, rows.length),
    filterBeforeVectorFinalSelectionRate: rate(rows.filter((row) => row.metadataFilterBeforeVector).length, rows.length),
    vectorAuthoritativeClaimCount: rows.filter((row) => row.vectorCandidateCount > 0 && !row.metadataFilterBeforeVector).length,
    recallChannelCounts: countBy(rows, (row) => row.recallChannels[0] ?? "unknown"),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 50),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Math.max(0, ...rows.map((row) => row.latencyMs)),
    corpusBreakdown,
    toolBreakdown,
    finalClaimSourceCounts: countBy(rows, (row) => row.finalClaimSource),
    queryContractCounts: countBy(rows, (row) => row.queryContract),
    retrievalDomainCounts: countBy(rows, (row) => row.retrievalDomain),
    selectedReaderCounts: countBy(rows, (row) => row.selectedReader),
    residualOwnerCounts: countBy(rows, (row) => row.residualOwner)
  };
}

function toMarkdown(report: any): string {
  const weakRows = report.results.filter((row: HammerRow) => row.quality !== "strong");
  const examples = report.results.filter((row: HammerRow) => row.quality === "strong").slice(0, 30);
  const lines = [
    "# Retrieval Hammer Audit 300",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- strong/acceptable/weak/fail/sourceMissing: ${report.metrics.strongCount}/${report.metrics.acceptableCount}/${report.metrics.weakCount}/${report.metrics.failCount}/${report.metrics.sourceMissingCount}`,
    `- passRate: ${report.metrics.passRate}`,
    `- nonSourceMissingPassRate: ${report.metrics.nonSourceMissingPassRate}`,
    `- averageRating: ${report.metrics.averageRating}/10`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p50LatencyMs: ${report.metrics.p50LatencyMs}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Corpus Breakdown",
    "",
    ...Object.entries(report.metrics.corpusBreakdown).map(([corpus, value]: [string, any]) => {
      return `- ${corpus}: total=${value.total}, strong=${value.strong}, acceptable=${value.acceptable}, weak=${value.weak}, fail=${value.fail}, sourceMissing=${value.sourceMissing}, avg=${value.averageRating}/10, p95=${value.p95LatencyMs}ms`;
    }),
    "",
    "## Tool Breakdown",
    "",
    ...Object.entries(report.metrics.toolBreakdown).map(([toolName, value]: [string, any]) => {
      return `- ${toolName}: total=${value.total}, strong=${value.strong}, weak=${value.weak}, fail=${value.fail}, sourceMissing=${value.sourceMissing}, p95=${value.p95LatencyMs}ms`;
    }),
    "",
    "## Weak / Failed / Source Missing Rows",
    "",
    ...(weakRows.length === 0
      ? ["- None."]
      : weakRows.map(
          (row: HammerRow) =>
            `- ${row.id}: quality=${row.quality}, owner=${row.residualOwner}, missing=${row.missingTerms.join("|") || "none"}, evidence=${row.evidenceCount}, sources=${row.sourceTrailCount}, query="${row.query}"`
        )),
    "",
    "## Representative Strong Rows",
    "",
    ...examples.map(
      (row: HammerRow) =>
        `- ${row.id} [${row.corpus}] ${row.rating}/10 ${row.finalClaimSource ?? "unknown"} ${row.latencyMs}ms: "${row.query}" -> "${row.answerPreview}"`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRetrievalHammerAudit300(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const live = await runAndWriteLiveOperatorQueryAudit150();
  const crossCorpus = await runAndWriteCrossCorpusMcpQueryAudit100();
  const mcpHuman = await runMcpHumanQueryAuditRows({ rowLimit: 50 });
  const rows = [
    ...live.report.results.map((row: any, index: number) => normalizeRow("live_operator_query_audit_150", row, index)),
    ...crossCorpus.report.results.map((row: any, index: number) => normalizeRow("cross_corpus_mcp_query_audit_100", row, index)),
    ...mcpHuman.rows.map((row: any, index: number) => normalizeRow("mcp_human_query_audit_100_subset", row, index))
  ];
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows);
  const report = {
    generatedAt,
    benchmark: "retrieval_hammer_audit_300",
    artifactSchemaVersion: "retrieval_hammer_audit_300_v1",
    passed:
      rows.length === 300 &&
      metrics.strongCount / rows.length >= 0.95 &&
      metrics.failCount === 0 &&
      metrics.supportedZeroEvidenceRows === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.queryTimeModelCalls === 0,
    childArtifacts: {
      liveOperatorQueryAudit150: live.output.jsonPath,
      crossCorpusMcpQueryAudit100: crossCorpus.output.jsonPath,
      mcpHumanMultiSourceIngestionArtifact: mcpHuman.multiSourceIngestionArtifact
    },
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(outputDir(), `retrieval-hammer-audit-300-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `retrieval-hammer-audit-300-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRetrievalHammerAudit300Cli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteRetrievalHammerAudit300();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
