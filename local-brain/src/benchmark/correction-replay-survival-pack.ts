import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  runAndWriteMcpCorrectionPropagationPack,
  type McpCorrectionPropagationReport
} from "./mcp-correction-propagation-pack.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface CorrectionReplayScenario {
  readonly id: string;
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly sourceEntityType?: string;
  readonly canonicalEntityType?: string;
}

interface CorrectionReplayRow {
  readonly id: string;
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly propagated: boolean;
  readonly replayEnvelopeCount: number;
  readonly classConstraintCount: number;
  readonly referenceAuditCount: number;
  readonly writeLockReleasedCount: number;
  readonly staleActiveSourceEntityCount: number;
  readonly activeCanonicalEntityCount: number;
  readonly duplicateCorrectedEntityCount: number;
  readonly wrongRoleAfterReplayCount: number;
  readonly orphanReferenceCount: number;
  readonly rawEvidenceDeleted: boolean;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
}

interface AmbiguousReplayRow {
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly applied: boolean;
  readonly requiresUserChoice: boolean;
  readonly candidateCount: number;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
}

interface RelationshipReplayRow {
  readonly queryEntity: string;
  readonly expectedRelatedEntity: string;
  readonly relationshipCount: number;
  readonly foundExpectedRelatedEntity: boolean;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
}

export interface CorrectionReplaySurvivalReport {
  readonly generatedAt: string;
  readonly benchmark: "correction_replay_survival_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly propagationArtifactPath: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly correctionReplaySurvivalRate: number;
    readonly wrongRoleAfterReplayCount: number;
    readonly duplicateCorrectedEntityCount: number;
    readonly orphanReferenceCount: number;
    readonly rawEvidenceDeletedCount: number;
    readonly ambiguousCorrectionRequiresPromptCount: number;
    readonly relationshipReattachmentPassRate: number;
    readonly replayEnvelopeCoverageRate: number;
    readonly classConstraintCoverageRate: number;
    readonly queryTimeModelCalls: number;
  };
  readonly rows: readonly CorrectionReplayRow[];
  readonly relationshipRows: readonly RelationshipReplayRow[];
  readonly ambiguousRows: readonly AmbiguousReplayRow[];
  readonly upstreamPropagationMetrics: McpCorrectionPropagationReport["metrics"];
  readonly artifactPaths?: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function queryTimeModelCalls(payload: Record<string, unknown>): number {
  const meta = payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : {};
  const value = meta.queryTimeModelCalls ?? meta.queryTimeLLMCalls ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanFromPayload(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function activeEntityCount(namespaceId: string, entityType: string, name: string): Promise<number> {
  const rows = await queryRows<{ readonly count: string }>(
    `
      SELECT count(*)::text AS count
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = $2
        AND normalized_name = $3
        AND merged_into_entity_id IS NULL
    `,
    [namespaceId, entityType, normalizeName(name)]
  );
  return Number(rows[0]?.count ?? "0");
}

async function replayStatusRow(namespaceId: string, scenario: CorrectionReplayScenario): Promise<CorrectionReplayRow> {
  const payload = structuredContent(
    await executeMcpTool("memory.get_correction_status", {
      namespace_id: namespaceId,
      source_name: scenario.sourceName,
      canonical_name: scenario.canonicalName,
      entity_type: scenario.entityType,
      limit: 20
    })
  );
  const replayEnvelopes = toArray(payload.correctionSourceEnvelopes);
  const classConstraints = toArray(payload.classConstraints);
  const referenceAudits = toArray(payload.referenceAudits);
  const writeLocks = toArray(payload.writeLocks);
  const activeCanonicalEntities = toArray(payload.activeCanonicalEntities);
  const staleActiveSourceEntities = toArray(payload.staleActiveSourceEntities);
  const propagated = booleanFromPayload(payload, "propagated");
  const rawEvidenceDeleted = booleanFromPayload(payload, "rawEvidenceDeleted");
  const duplicateCorrectedEntityCount = Math.max(0, activeCanonicalEntities.length - 1);
  const sourceRole = scenario.sourceEntityType ?? scenario.entityType;
  const targetRole = scenario.canonicalEntityType ?? scenario.entityType;
  const sourceActiveCount = normalizeName(scenario.sourceName) === normalizeName(scenario.canonicalName) && sourceRole === targetRole
    ? 0
    : await activeEntityCount(namespaceId, sourceRole, scenario.sourceName);
  const targetActiveCount = await activeEntityCount(namespaceId, targetRole, scenario.canonicalName);
  const wrongRoleAfterReplayCount =
    scenario.sourceEntityType && scenario.canonicalEntityType && scenario.sourceEntityType !== scenario.canonicalEntityType
      ? await activeEntityCount(namespaceId, scenario.sourceEntityType, scenario.sourceName)
      : 0;
  const orphanReferenceCount = referenceAudits.reduce<number>((sum, audit) => {
    if (!audit || typeof audit !== "object") {
      return sum;
    }
    const row = audit as Record<string, unknown>;
    return sum + numberFromUnknown(row.source_reference_count);
  }, 0);
  const writeLockReleasedCount = writeLocks.filter((lock) => {
    if (!lock || typeof lock !== "object") {
      return false;
    }
    return (lock as Record<string, unknown>).status === "released";
  }).length;
  const requiresClassConstraint = scenario.sourceEntityType && scenario.canonicalEntityType && scenario.sourceEntityType !== scenario.canonicalEntityType;
  const passed =
    propagated &&
    replayEnvelopes.length > 0 &&
    referenceAudits.length > 0 &&
    writeLockReleasedCount > 0 &&
    sourceActiveCount === 0 &&
    targetActiveCount === 1 &&
    duplicateCorrectedEntityCount === 0 &&
    wrongRoleAfterReplayCount === 0 &&
    orphanReferenceCount === 0 &&
    !rawEvidenceDeleted &&
    (!requiresClassConstraint || classConstraints.length > 0);

  return {
    id: scenario.id,
    sourceName: scenario.sourceName,
    canonicalName: scenario.canonicalName,
    entityType: scenario.entityType,
    propagated,
    replayEnvelopeCount: replayEnvelopes.length,
    classConstraintCount: classConstraints.length,
    referenceAuditCount: referenceAudits.length,
    writeLockReleasedCount,
    staleActiveSourceEntityCount: staleActiveSourceEntities.length + sourceActiveCount,
    activeCanonicalEntityCount: targetActiveCount,
    duplicateCorrectedEntityCount,
    wrongRoleAfterReplayCount,
    orphanReferenceCount,
    rawEvidenceDeleted,
    queryTimeModelCalls: queryTimeModelCalls(payload),
    passed
  };
}

async function verifyRelationshipReplay(namespaceId: string): Promise<RelationshipReplayRow> {
  const payload = structuredContent(
    await executeMcpTool("memory.get_relationships", {
      namespace_id: namespaceId,
      entity_name: "Stephen",
      limit: 10
    })
  );
  const relationships = toArray(payload.relationships);
  const foundExpectedRelatedEntity = JSON.stringify(relationships).toLowerCase().includes("bob");
  return {
    queryEntity: "Stephen",
    expectedRelatedEntity: "Bob",
    relationshipCount: relationships.length,
    foundExpectedRelatedEntity,
    queryTimeModelCalls: queryTimeModelCalls(payload),
    passed: foundExpectedRelatedEntity
  };
}

async function verifyAmbiguousReplay(namespaceId: string): Promise<AmbiguousReplayRow> {
  const payload = structuredContent(
    await executeMcpTool("memory.apply_correction", {
      namespace_id: namespaceId,
      source_name: "Omni Gummi",
      canonical_name: "Gumi",
      entity_type: "person",
      aliases: ["Omni Gummi"],
      preserve_aliases: true,
      note: "Replay survival benchmark should still require target selection"
    })
  );
  const preflight = payload.correctionPreflight && typeof payload.correctionPreflight === "object"
    ? payload.correctionPreflight as Record<string, unknown>
    : {};
  const candidates = toArray(preflight.candidates);
  const requiresUserChoice = payload.requiresUserChoice === true || preflight.requiresUserChoice === true;
  const applied = payload.applied !== false && Boolean(payload.result);
  return {
    sourceName: "Omni Gummi",
    canonicalName: "Gumi",
    applied,
    requiresUserChoice,
    candidateCount: candidates.length,
    queryTimeModelCalls: queryTimeModelCalls(payload),
    passed: !applied && requiresUserChoice && candidates.length >= 2
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function markdown(report: CorrectionReplaySurvivalReport): string {
  return [
    "# Correction Replay Survival Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- propagationArtifactPath: ${report.propagationArtifactPath}`,
    `- passed: ${report.passed}`,
    `- correctionReplaySurvivalRate: ${report.metrics.correctionReplaySurvivalRate}`,
    `- wrongRoleAfterReplayCount: ${report.metrics.wrongRoleAfterReplayCount}`,
    `- duplicateCorrectedEntityCount: ${report.metrics.duplicateCorrectedEntityCount}`,
    `- orphanReferenceCount: ${report.metrics.orphanReferenceCount}`,
    `- rawEvidenceDeletedCount: ${report.metrics.rawEvidenceDeletedCount}`,
    `- ambiguousCorrectionRequiresPromptCount: ${report.metrics.ambiguousCorrectionRequiresPromptCount}`,
    `- relationshipReattachmentPassRate: ${report.metrics.relationshipReattachmentPassRate}`,
    `- replayEnvelopeCoverageRate: ${report.metrics.replayEnvelopeCoverageRate}`,
    `- classConstraintCoverageRate: ${report.metrics.classConstraintCoverageRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Corrections",
    "",
    ...report.rows.map(
      (row) =>
        `- ${row.passed ? "PASS" : "FAIL"} ${row.sourceName} -> ${row.canonicalName}; propagated=${row.propagated}; envelopes=${row.replayEnvelopeCount}; constraints=${row.classConstraintCount}; audits=${row.referenceAuditCount}; locksReleased=${row.writeLockReleasedCount}; staleActive=${row.staleActiveSourceEntityCount}; duplicates=${row.duplicateCorrectedEntityCount}; wrongRole=${row.wrongRoleAfterReplayCount}; orphanRefs=${row.orphanReferenceCount}`
    ),
    "",
    "## Relationship Replay",
    "",
    ...report.relationshipRows.map(
      (row) => `- ${row.passed ? "PASS" : "FAIL"} ${row.queryEntity} includes ${row.expectedRelatedEntity}; relationships=${row.relationshipCount}`
    ),
    "",
    "## Ambiguous Correction Blocking",
    "",
    ...report.ambiguousRows.map(
      (row) =>
        `- ${row.passed ? "PASS" : "FAIL"} ${row.sourceName} -> ${row.canonicalName}; applied=${row.applied}; requiresUserChoice=${row.requiresUserChoice}; candidates=${row.candidateCount}`
    ),
    ""
  ].join("\n");
}

export async function runAndWriteCorrectionReplaySurvivalPack(): Promise<{
  readonly report: CorrectionReplaySurvivalReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const propagation = await runAndWriteMcpCorrectionPropagationPack();
  const namespaceId = propagation.report.namespaceId;
  const scenarios: readonly CorrectionReplayScenario[] = [
    {
      id: "omi_gummi_alias_replay",
      sourceName: "Omi Gummi",
      canonicalName: "Gummi",
      entityType: "person"
    },
    {
      id: "steven_spelling_replay",
      sourceName: "Steven",
      canonicalName: "Stephen",
      entityType: "person"
    },
    {
      id: "chiang_mai_role_replay",
      sourceName: "Chiang Mai",
      canonicalName: "Chiang Mai",
      entityType: "place",
      sourceEntityType: "person",
      canonicalEntityType: "place"
    }
  ];
  const rows = [];
  for (const scenario of scenarios) {
    rows.push(await replayStatusRow(namespaceId, scenario));
  }
  const relationshipRow = await verifyRelationshipReplay(namespaceId);
  const ambiguousRow = await verifyAmbiguousReplay(namespaceId);
  const roleRows = rows.filter((row) => row.id.includes("role"));
  const queryTimeModelCallTotal =
    rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0) +
    relationshipRow.queryTimeModelCalls +
    ambiguousRow.queryTimeModelCalls +
    propagation.report.metrics.queryTimeModelCalls;
  const metrics = {
    correctionReplaySurvivalRate: average(rows.map((row) => row.passed ? 1 : 0)),
    wrongRoleAfterReplayCount: rows.reduce((sum, row) => sum + row.wrongRoleAfterReplayCount, 0),
    duplicateCorrectedEntityCount: rows.reduce((sum, row) => sum + row.duplicateCorrectedEntityCount, 0),
    orphanReferenceCount: rows.reduce((sum, row) => sum + row.orphanReferenceCount, 0),
    rawEvidenceDeletedCount: rows.filter((row) => row.rawEvidenceDeleted).length,
    ambiguousCorrectionRequiresPromptCount: ambiguousRow.passed ? 1 : 0,
    relationshipReattachmentPassRate: relationshipRow.passed ? 1 : 0,
    replayEnvelopeCoverageRate: average(rows.map((row) => row.replayEnvelopeCount > 0 ? 1 : 0)),
    classConstraintCoverageRate: roleRows.length === 0 ? 1 : average(roleRows.map((row) => row.classConstraintCount > 0 ? 1 : 0)),
    queryTimeModelCalls: queryTimeModelCallTotal
  };
  const generatedAt = new Date().toISOString();
  const report: CorrectionReplaySurvivalReport = {
    generatedAt,
    benchmark: "correction_replay_survival_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId, upstreamBenchmark: "mcp_correction_propagation_pack" }
    }),
    namespaceId,
    propagationArtifactPath: propagation.output.jsonPath,
    passed:
      propagation.report.passed &&
      metrics.correctionReplaySurvivalRate === 1 &&
      metrics.wrongRoleAfterReplayCount === 0 &&
      metrics.duplicateCorrectedEntityCount === 0 &&
      metrics.orphanReferenceCount === 0 &&
      metrics.rawEvidenceDeletedCount === 0 &&
      metrics.ambiguousCorrectionRequiresPromptCount === 1 &&
      metrics.relationshipReattachmentPassRate === 1 &&
      metrics.replayEnvelopeCoverageRate === 1 &&
      metrics.classConstraintCoverageRate === 1 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    rows,
    relationshipRows: [relationshipRow],
    ambiguousRows: [ambiguousRow],
    upstreamPropagationMetrics: propagation.report.metrics
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(outputDir(), `correction-replay-survival-pack-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `correction-replay-survival-pack-${runStamp}.md`);
  const reportWithPaths = { ...report, artifactPaths: { jsonPath, markdownPath } };
  await writeFile(jsonPath, `${JSON.stringify(reportWithPaths, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdown(reportWithPaths)}\n`, "utf8");
  return { report: reportWithPaths, output: { jsonPath, markdownPath } };
}

export async function runCorrectionReplaySurvivalPackCli(): Promise<void> {
  const { report, output } = await runAndWriteCorrectionReplaySurvivalPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}
