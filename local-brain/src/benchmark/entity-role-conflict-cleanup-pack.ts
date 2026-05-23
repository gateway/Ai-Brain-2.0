import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { loadEntityRoleConflictProjection, rebuildEntityRoleConflictProjection, type EntityRoleConflictProjectionRow } from "../identity/entity-role-resolution.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface RawConflictRow {
  readonly canonical_name: string;
  readonly roles: readonly string[];
}

interface RetrievalRegressionRow {
  readonly query: string;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly passed: boolean;
  readonly notes: string;
}

export interface EntityRoleConflictCleanupReport {
  readonly generatedAt: string;
  readonly benchmark: "entity_role_conflict_cleanup_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly metrics: {
    readonly rawConflictCount: number;
    readonly resolvedConflictCount: number;
    readonly invalidPlaceAsPersonCount: number;
    readonly invalidPersonAsOrgCount: number;
    readonly allowedDualRoleOrgProjectCount: number;
    readonly sourceTrailCoverageRate: number;
    readonly retrievalBindingRegressionCount: number;
    readonly queryTimeModelCalls: number;
  };
  readonly rawConflicts: readonly RawConflictRow[];
  readonly projections: readonly EntityRoleConflictProjectionRow[];
  readonly retrievalRows: readonly RetrievalRegressionRow[];
}

const REQUIRED_NAMES = ["chiang mai", "omi gummi", "two way"];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

async function loadRawConflicts(): Promise<readonly RawConflictRow[]> {
  return queryRows<RawConflictRow>(
    `
      SELECT canonical_name, array_agg(DISTINCT entity_type ORDER BY entity_type) AS roles
      FROM entities
      WHERE namespace_id = 'personal'
        AND lower(canonical_name) = ANY($1::text[])
      GROUP BY canonical_name
      HAVING count(DISTINCT entity_type) > 1
      ORDER BY canonical_name
    `,
    [REQUIRED_NAMES]
  );
}

function hasRole(row: EntityRoleConflictProjectionRow | undefined, role: string): boolean {
  return Boolean(row?.resolvedRoles.some((candidate) => candidate === role));
}

function hasSourceTrail(row: EntityRoleConflictProjectionRow): boolean {
  return Object.values(row.roleSourceTrails).some((entries) => entries.length > 0);
}

function queryTimeModelCalls(payload: Record<string, unknown>): number {
  const meta = payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : {};
  const value = meta.queryTimeModelCalls ?? meta.queryTimeLLMCalls ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function runRetrievalRows(): Promise<{ readonly rows: readonly RetrievalRegressionRow[]; readonly queryTimeModelCalls: number }> {
  const queries = [
    "Who are my friends in Chiang Mai?",
    "Who did Dan introduce me to in Chiang Mai, and where did we meet?",
    "What is Two Way and what work am I doing there?",
    "Give me my full work history with roles and dates."
  ];
  let modelCalls = 0;
  const rows: RetrievalRegressionRow[] = [];

  for (const query of queries) {
    const result = (await executeMcpTool("memory.search", {
      namespace_id: "personal",
      query,
      detail_mode: "compact",
      limit: 8
    })) as { readonly structuredContent?: Record<string, unknown> };
    const payload = result.structuredContent ?? {};
    modelCalls += queryTimeModelCalls(payload);
    const evidenceCount = typeof payload.evidenceCount === "number" ? payload.evidenceCount : 0;
    const sourceTrailCount = Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0;
    const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
    const serialized = JSON.stringify(payload);
    const badPlaceOwnerBinding = serialized.includes('"sharedSocialGraphOwners":["Steve Tietze","Chiang Mai"]');
    const passed = evidenceCount > 0 && sourceTrailCount > 0 && claimAuditCount > 0 && !badPlaceOwnerBinding;
    rows.push({
      query,
      finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
      evidenceCount,
      sourceTrailCount,
      claimAuditCount,
      passed,
      notes: badPlaceOwnerBinding ? "Chiang Mai was bound as a social-graph owner." : "source-bound retrieval row"
    });
  }

  return { rows, queryTimeModelCalls: modelCalls };
}

function toMarkdown(report: EntityRoleConflictCleanupReport): string {
  return [
    "# Entity Role Conflict Cleanup Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- rawConflictCount: ${report.metrics.rawConflictCount}`,
    `- resolvedConflictCount: ${report.metrics.resolvedConflictCount}`,
    `- invalidPlaceAsPersonCount: ${report.metrics.invalidPlaceAsPersonCount}`,
    `- invalidPersonAsOrgCount: ${report.metrics.invalidPersonAsOrgCount}`,
    `- allowedDualRoleOrgProjectCount: ${report.metrics.allowedDualRoleOrgProjectCount}`,
    `- sourceTrailCoverageRate: ${report.metrics.sourceTrailCoverageRate}`,
    `- retrievalBindingRegressionCount: ${report.metrics.retrievalBindingRegressionCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Projections",
    "",
    report.projections
      .map((row) => `- ${row.canonicalName}: observed=${row.observedRoles.join(", ")} resolved=${row.resolvedRoles.join(", ")} invalid=${row.invalidRoles.join(", ") || "none"} action=${row.recommendedAction}`)
      .join("\n") || "- none",
    "",
    "## Retrieval Rows",
    "",
    report.retrievalRows
      .map((row) => `- ${row.passed ? "PASS" : "FAIL"} ${row.query} (${row.finalClaimSource}, evidence=${row.evidenceCount}, sourceTrail=${row.sourceTrailCount}, claimAudit=${row.claimAuditCount})`)
      .join("\n") || "- none",
    ""
  ].join("\n");
}

export async function runAndWriteEntityRoleConflictCleanupPack(): Promise<{
  readonly report: EntityRoleConflictCleanupReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await rebuildEntityRoleConflictProjection("personal");
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const rawConflicts = await loadRawConflicts();
  const projections = await loadEntityRoleConflictProjection("personal");
  const projectionByName = new Map(projections.map((row) => [row.normalizedName, row]));
  const chiangMai = projectionByName.get("chiang mai");
  const omiGummi = projectionByName.get("omi gummi");
  const twoWay = projectionByName.get("two way");
  const retrieval = await runRetrievalRows();
  const sourceTrailCoverageRate = projections.length === 0 ? 0 : projections.filter(hasSourceTrail).length / projections.length;
  const metrics = {
    rawConflictCount: rawConflicts.length,
    resolvedConflictCount: projections.filter((row) => row.resolutionStatus === "resolved" || row.resolutionStatus === "allowed").length,
    invalidPlaceAsPersonCount: hasRole(chiangMai, "person") ? 1 : 0,
    invalidPersonAsOrgCount: hasRole(omiGummi, "org") ? 1 : 0,
    allowedDualRoleOrgProjectCount: hasRole(twoWay, "org") && hasRole(twoWay, "project") ? 1 : 0,
    sourceTrailCoverageRate,
    retrievalBindingRegressionCount: retrieval.rows.filter((row) => !row.passed).length,
    queryTimeModelCalls: retrieval.queryTimeModelCalls
  };
  const report: EntityRoleConflictCleanupReport = {
    generatedAt,
    benchmark: "entity_role_conflict_cleanup_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        namespaceId: "personal",
        requiredConflictNames: REQUIRED_NAMES.join(",")
      }
    }),
    passed:
      metrics.invalidPlaceAsPersonCount === 0 &&
      metrics.invalidPersonAsOrgCount === 0 &&
      metrics.allowedDualRoleOrgProjectCount >= 1 &&
      metrics.sourceTrailCoverageRate === 1 &&
      metrics.retrievalBindingRegressionCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    rawConflicts,
    projections,
    retrievalRows: retrieval.rows
  };
  const root = outputDir();
  await mkdir(root, { recursive: true });
  const jsonPath = path.join(root, `entity-role-conflict-cleanup-pack-${stamp}.json`);
  const markdownPath = path.join(root, `entity-role-conflict-cleanup-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runEntityRoleConflictCleanupPackCli(): Promise<void> {
  const { report, output } = await runAndWriteEntityRoleConflictCleanupPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
