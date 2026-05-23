import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ScenarioKind = "repo_doc_source_audit" | "procedure_source_audit";

interface Scenario {
  readonly id: string;
  readonly kind: ScenarioKind;
  readonly query: string;
  readonly expectedReader: string;
  readonly expectedSourceTerms: readonly string[];
}

interface Row extends Scenario {
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly selectedReader: string | null;
  readonly repoProjectionUsed: boolean;
  readonly packageScriptProjectionUsed: boolean;
  readonly repoDocScanCount: number;
  readonly vectorContribution: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingSourceTerms: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly passed: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "source_audit_hybrid_temporal_spec",
    kind: "repo_doc_source_audit",
    query: "Show the sources for the current spec or plan for hybrid temporal memory retrieval.",
    expectedReader: "repo_doc_trusted_reader",
    expectedSourceTerms: ["brain-spec/local", "hybrid"]
  },
  {
    id: "source_audit_phase2_latency_checkpoint",
    kind: "repo_doc_source_audit",
    query: "Show the sources for the Phase 2 latency checkpoint answer.",
    expectedReader: "repo_doc_trusted_reader",
    expectedSourceTerms: ["phase-2-latency", "brain-spec/local"]
  },
  {
    id: "source_audit_mcp_gold_command",
    kind: "procedure_source_audit",
    query: "Show the source for how to run the MCP query taxonomy gold benchmark.",
    expectedReader: "package_script_trusted_reader",
    expectedSourceTerms: ["local-brain/package.json", "benchmark:mcp-query-taxonomy-gold"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function payloadText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function metaFromPayload(payload: any): Record<string, any> {
  if (typeof payload?.meta === "object" && payload.meta) return payload.meta;
  if (typeof payload?.retrievalPlan === "object" && payload.retrievalPlan) return payload.retrievalPlan;
  return {};
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: "personal",
    query: scenario.query,
    limit: 8,
    detailMode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const meta = metaFromPayload(payload);
  const evidenceCount = payloadEvidenceCount(payload);
  const missingSourceTerms = scenario.expectedSourceTerms.filter((term) => !payloadText(payload).includes(term.toLowerCase()));
  const selectedReader = typeof meta.selectedReader === "string" ? meta.selectedReader : null;
  const row: Row = {
    ...scenario,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    selectedReader,
    repoProjectionUsed: meta.repoProjectionUsed === true,
    packageScriptProjectionUsed: meta.packageScriptProjectionUsed === true,
    repoDocScanCount: typeof meta.repoDocScanCount === "number" ? meta.repoDocScanCount : selectedReader ? 1 : 0,
    vectorContribution: typeof meta.vectorContribution === "string" ? meta.vectorContribution : null,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    missingSourceTerms,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed: false
  };
  const projectionUsed = scenario.kind === "procedure_source_audit" ? row.packageScriptProjectionUsed : row.repoProjectionUsed;
  return {
    ...row,
    passed:
      row.finalClaimSource === "source_audit" &&
      row.queryContract === "source_audit" &&
      row.selectedReader === scenario.expectedReader &&
      projectionUsed &&
      row.repoDocScanCount === 0 &&
      row.vectorContribution !== "final_support" &&
      row.evidenceCount > 0 &&
      row.sourceTrailCount > 0 &&
      row.claimAuditCount > 0 &&
      row.missingSourceTerms.length === 0 &&
      row.queryTimeModelCalls === 0
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function markdownFor(report: any): string {
  return [
    "# Repo Procedure Source Audit Pack",
    "",
    `- passed: ${report.passed}`,
    `- repoProcedureSourceAuditMissCount: ${report.metrics.repoProcedureSourceAuditMissCount}`,
    `- sourceAuditProjectionCoverageRate: ${report.metrics.sourceAuditProjectionCoverageRate}`,
    `- repoDocScanCount: ${report.metrics.repoDocScanCount}`,
    `- vectorAuthoritativeClaimCount: ${report.metrics.vectorAuthoritativeClaimCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Rows",
    ...report.results.map((row: Row) => `- ${row.id}: ${row.passed ? "pass" : `fail missing=${row.missingSourceTerms.join(",")}`}`)
  ].join("\n") + "\n";
}

export async function runAndWriteRepoProcedureSourceAuditPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    rows.push(await runScenario(scenario));
  }
  const metrics = {
    totalRows: rows.length,
    passedRows: rows.filter((row) => row.passed).length,
    repoProcedureSourceAuditMissCount: rows.filter((row) => !row.passed).length,
    sourceAuditProjectionCoverageRate: rate(
      rows.filter((row) => row.repoProjectionUsed || row.packageScriptProjectionUsed).length,
      rows.length
    ),
    repoDocScanCount: rows.reduce((sum, row) => sum + row.repoDocScanCount, 0),
    supportedEmptySourceTrailCount: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    vectorAuthoritativeClaimCount: rows.filter((row) => row.vectorContribution === "final_support").length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "repo_procedure_source_audit_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.repoProcedureSourceAuditMissCount === 0 &&
      metrics.sourceAuditProjectionCoverageRate === 1 &&
      metrics.repoDocScanCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.vectorAuthoritativeClaimCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `repo-procedure-source-audit-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `repo-procedure-source-audit-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRepoProcedureSourceAuditPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteRepoProcedureSourceAuditPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
