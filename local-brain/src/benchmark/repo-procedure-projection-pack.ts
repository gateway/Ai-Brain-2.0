import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ScenarioKind = "repo_doc" | "procedure";

interface Scenario {
  readonly id: string;
  readonly kind: ScenarioKind;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedReader: string;
}

interface Row extends Scenario {
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly answerShape: string | null;
  readonly selectedReader: string | null;
  readonly repoProjectionUsed: boolean;
  readonly packageScriptProjectionUsed: boolean;
  readonly repoDocScanCount: number;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly missingTerms: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly passed: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "repo_spec_hybrid_temporal",
    kind: "repo_doc",
    query: "What is the current spec or plan for hybrid temporal memory retrieval?",
    expectedReader: "repo_doc_trusted_reader",
    expectedTerms: ["MemoryQueryPlan", "source-bound", "benchmark"]
  },
  {
    id: "repo_latest_temporal_truth_checkpoint",
    kind: "repo_doc",
    query: "What changed in the latest temporal truth checkpoint?",
    expectedReader: "repo_doc_trusted_reader",
    expectedTerms: ["temporal truth", "checkpoint"]
  },
  {
    id: "repo_phase2_latency_checkpoint",
    kind: "repo_doc",
    query: "What does the Phase 2 latency checkpoint say changed?",
    expectedReader: "repo_doc_trusted_reader",
    expectedTerms: ["Phase 2", "latency", "fast"]
  },
  {
    id: "procedure_mcp_gold",
    kind: "procedure",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    expectedReader: "package_script_trusted_reader",
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain", "package.json"]
  },
  {
    id: "procedure_production_readiness",
    kind: "procedure",
    query: "How do I run production readiness?",
    expectedReader: "package_script_trusted_reader",
    expectedTerms: ["npm run benchmark:production-readiness", "--workspace local-brain", "package.json"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function payloadText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function hasTerm(payload: any, term: string): boolean {
  return payloadText(payload).includes(term.toLowerCase());
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

function answerShape(payload: any, meta: Record<string, any>): string | null {
  if (typeof payload?.answerShape === "string") return payload.answerShape;
  if (typeof payload?.queryContract?.answerShape === "string") return payload.queryContract.answerShape;
  if (typeof meta.answerShape === "string") return meta.answerShape;
  return null;
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
  const missingTerms = scenario.expectedTerms.filter((term) => !hasTerm(payload, term));
  const selectedReader = typeof meta.selectedReader === "string" ? meta.selectedReader : null;
  const row: Row = {
    ...scenario,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : typeof meta.finalClaimSource === "string" ? meta.finalClaimSource : null,
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : typeof meta.queryContractName === "string" ? meta.queryContractName : null,
    answerShape: answerShape(payload, meta),
    selectedReader,
    repoProjectionUsed: meta.repoProjectionUsed === true,
    packageScriptProjectionUsed: meta.packageScriptProjectionUsed === true,
    repoDocScanCount: typeof meta.repoDocScanCount === "number" ? meta.repoDocScanCount : selectedReader ? 1 : 0,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    missingTerms,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed: false
  };
  return {
    ...row,
    passed:
      row.selectedReader === scenario.expectedReader &&
      row.missingTerms.length === 0 &&
      row.evidenceCount > 0 &&
      row.sourceTrailCount > 0 &&
      row.claimAuditCount > 0 &&
      row.queryTimeModelCalls === 0 &&
      (scenario.kind !== "procedure" || row.answerShape === "procedure")
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function markdownFor(report: any): string {
  return [
    "# Repo Procedure Projection Pack",
    "",
    `- passed: ${report.passed}`,
    `- docProcedureMissCount: ${report.metrics.docProcedureMissCount}`,
    `- repoDocScanCount: ${report.metrics.repoDocScanCount}`,
    `- packageScriptCoverageRate: ${report.metrics.packageScriptCoverageRate}`,
    `- specCheckpointCoverageRate: ${report.metrics.specCheckpointCoverageRate}`,
    `- procedureAnswerShapePassRate: ${report.metrics.procedureAnswerShapePassRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Rows",
    ...report.results.map((row: Row) => `- ${row.id}: ${row.passed ? "pass" : `fail missing=${row.missingTerms.join(",")}`}`)
  ].join("\n") + "\n";
}

export async function runAndWriteRepoProcedureProjectionPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    rows.push(await runScenario(scenario));
  }
  const repoRows = rows.filter((row) => row.kind === "repo_doc");
  const procedureRows = rows.filter((row) => row.kind === "procedure");
  const metrics = {
    totalRows: rows.length,
    passedRows: rows.filter((row) => row.passed).length,
    docProcedureMissCount: rows.filter((row) => !row.passed).length,
    repoDocScanCount: rows.reduce((sum, row) => sum + row.repoDocScanCount, 0),
    packageScriptCoverageRate: rate(procedureRows.filter((row) => row.packageScriptProjectionUsed).length, procedureRows.length),
    specCheckpointCoverageRate: rate(repoRows.filter((row) => row.repoProjectionUsed && row.missingTerms.length === 0).length, repoRows.length),
    procedureAnswerShapePassRate: rate(procedureRows.filter((row) => row.answerShape === "procedure").length, procedureRows.length),
    supportedEmptySourceTrailCount: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...rows.map((row) => row.latencyMs)).toFixed(2))
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "repo_procedure_projection_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.docProcedureMissCount === 0 &&
      metrics.repoDocScanCount === 0 &&
      metrics.packageScriptCoverageRate === 1 &&
      metrics.specCheckpointCoverageRate >= 0.95 &&
      metrics.procedureAnswerShapePassRate === 1 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `repo-procedure-projection-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `repo-procedure-projection-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRepoProcedureProjectionPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteRepoProcedureProjectionPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
