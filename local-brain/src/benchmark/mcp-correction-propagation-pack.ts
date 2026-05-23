import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows, withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface CorrectionRow {
  readonly id: string;
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly sourceEntityType?: string;
  readonly canonicalEntityType?: string;
  readonly applied: boolean;
  readonly propagated: boolean;
  readonly aliasPreserved: boolean;
  readonly staleActiveSourceEntityCount: number;
  readonly outboxEventCount: number;
  readonly correctionEnvelopeCount: number;
  readonly classConstraintCount: number;
  readonly referenceAuditCount: number;
  readonly writeLockReleasedCount: number;
  readonly orphanReferenceCount: number;
  readonly rawEvidenceDeleted: boolean;
  readonly notes: string;
}

interface KeepSeparateRow {
  readonly leftName: string;
  readonly rightName: string;
  readonly decision: string | null;
  readonly decisionTrailCount: number;
  readonly correctionEnvelopeCount: number;
  readonly referenceAuditCount: number;
  readonly rawEvidenceDeleted: boolean;
  readonly passed: boolean;
}

interface RelationshipVerificationRow {
  readonly queryEntity: string;
  readonly expectedRelatedEntity: string;
  readonly relationshipCount: number;
  readonly foundExpectedRelatedEntity: boolean;
  readonly passed: boolean;
}

interface AmbiguousCorrectionRow {
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly applied: boolean;
  readonly requiresUserChoice: boolean;
  readonly candidateCount: number;
  readonly passed: boolean;
}

export interface McpCorrectionPropagationReport {
  readonly generatedAt: string;
  readonly benchmark: "mcp_correction_propagation_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly mcpCorrectionToolCoverage: number;
    readonly correctionPropagationPassRate: number;
    readonly aliasMergePropagationPassRate: number;
    readonly keepSeparatePassRate: number;
    readonly roleCorrectionPassRate: number;
    readonly spellingCorrectionRetrievalPassRate: number;
    readonly staleAliasLeakCount: number;
    readonly correctionDecisionTrailCoverageRate: number;
    readonly sourceAuditAfterCorrectionPassRate: number;
    readonly replayableCorrectionArtifactCoverageRate: number;
    readonly hardClassConstraintCoverageRate: number;
    readonly orphanReferenceAuditPassRate: number;
    readonly inboxWriteLockReleaseRate: number;
    readonly rawEvidenceDeletedCount: number;
    readonly ambiguousCorrectionBlockedCount: number;
    readonly ambiguousCorrectionCandidateCount: number;
    readonly queryTimeModelCalls: number;
  };
  readonly correctionRows: readonly CorrectionRow[];
  readonly keepSeparateRows: readonly KeepSeparateRow[];
  readonly relationshipRows: readonly RelationshipVerificationRow[];
  readonly ambiguousRows: readonly AmbiguousCorrectionRow[];
  readonly artifactPaths?: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

async function upsertFixtureEntity(namespaceId: string, entityType: string, canonicalName: string): Promise<string> {
  const normalizedName = normalizeName(canonicalName);
  const rows = await queryRows<{ readonly id: string }>(
    `
      INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        merged_into_entity_id = NULL,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      namespaceId,
      entityType,
      canonicalName,
      normalizedName,
      JSON.stringify({ benchmark_seed: "mcp_correction_propagation_pack" })
    ]
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to upsert fixture entity ${canonicalName}.`);
  }
  await queryRows(
    `
      INSERT INTO entity_aliases (entity_id, alias, normalized_alias, alias_type, metadata)
      VALUES ($1::uuid, $2, $3, 'observed', $4::jsonb)
      ON CONFLICT (entity_id, normalized_alias)
      DO UPDATE SET metadata = entity_aliases.metadata || EXCLUDED.metadata
    `,
    [
      id,
      canonicalName,
      normalizedName,
      JSON.stringify({ benchmark_seed: "mcp_correction_propagation_pack" })
    ]
  );
  return id;
}

async function seedFixture(namespaceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM brain_outbox_events WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM relationship_memory WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);
  });

  const stevenId = await upsertFixtureEntity(namespaceId, "person", "Steven");
  const bobId = await upsertFixtureEntity(namespaceId, "person", "Bob");
  await upsertFixtureEntity(namespaceId, "person", "Stephen");
  await upsertFixtureEntity(namespaceId, "person", "Omi Gummi");
  await upsertFixtureEntity(namespaceId, "person", "Gummi");
  await upsertFixtureEntity(namespaceId, "person", "Gumee");
  await upsertFixtureEntity(namespaceId, "person", "Gumi");
  await upsertFixtureEntity(namespaceId, "person", "Alex Kim");
  await upsertFixtureEntity(namespaceId, "person", "Alex King");
  await upsertFixtureEntity(namespaceId, "person", "Chiang Mai");
  await upsertFixtureEntity(namespaceId, "place", "Chiang Mai");

  await queryRows(
    `
      INSERT INTO relationship_memory (
        namespace_id,
        subject_entity_id,
        predicate,
        object_entity_id,
        confidence,
        status,
        valid_from,
        metadata
      )
      VALUES ($1, $2::uuid, 'friend_of', $3::uuid, 0.98, 'active', '2026-05-22T00:00:00Z'::timestamptz, $4::jsonb)
      ON CONFLICT (namespace_id, subject_entity_id, predicate, object_entity_id, valid_from)
      DO UPDATE SET metadata = relationship_memory.metadata || EXCLUDED.metadata
    `,
    [
      namespaceId,
      stevenId,
      bobId,
      JSON.stringify({
        benchmark_seed: "mcp_correction_propagation_pack",
        source_uri: "benchmark://mcp-correction-propagation/steven-friend"
      })
    ]
  );
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }
  const content = (result as { readonly structuredContent?: unknown }).structuredContent;
  return content && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

function numberFromPayload(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanFromPayload(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function queryTimeModelCalls(payload: Record<string, unknown>): number {
  const meta = payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : {};
  const value = meta.queryTimeModelCalls ?? meta.queryTimeLLMCalls ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function applyAndCheckCorrection(input: {
  readonly namespaceId: string;
  readonly id: string;
  readonly sourceName: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly sourceEntityType?: string;
  readonly canonicalEntityType?: string;
}): Promise<{ readonly row: CorrectionRow; readonly queryTimeModelCalls: number }> {
  const applyPayload = structuredContent(
    await executeMcpTool("memory.apply_correction", {
      namespace_id: input.namespaceId,
      source_name: input.sourceName,
      canonical_name: input.canonicalName,
      entity_type: input.entityType,
      source_entity_type: input.sourceEntityType,
      canonical_entity_type: input.canonicalEntityType,
      aliases: [input.sourceName],
      preserve_aliases: true,
      note: `Benchmark correction ${input.sourceName} -> ${input.canonicalName}`
    })
  );
  const status = applyPayload.status && typeof applyPayload.status === "object" ? (applyPayload.status as Record<string, unknown>) : {};
  const aliases = toArray(status.aliases);
  const outboxEvents = toArray(status.outboxEvents);
  const correctionSourceEnvelopes = toArray(status.correctionSourceEnvelopes);
  const classConstraints = toArray(status.classConstraints);
  const referenceAudits = toArray(status.referenceAudits);
  const writeLocks = toArray(status.writeLocks);
  const staleActiveSourceEntities = toArray(status.staleActiveSourceEntities);
  let staleActiveSourceEntityCount = staleActiveSourceEntities.length;
  if (input.sourceEntityType && input.canonicalEntityType && input.sourceEntityType !== input.canonicalEntityType) {
    const staleRows = await queryRows<{ readonly count: string }>(
      `
        SELECT count(*)::text AS count
        FROM entities
        WHERE namespace_id = $1
          AND entity_type = $2
          AND normalized_name = $3
          AND merged_into_entity_id IS NULL
      `,
      [input.namespaceId, input.sourceEntityType, normalizeName(input.sourceName)]
    );
    staleActiveSourceEntityCount = Number(staleRows[0]?.count ?? "0");
  }
  const aliasPreserved = aliases.some((alias) => {
    if (!alias || typeof alias !== "object") {
      return false;
    }
    return normalizeName(String((alias as Record<string, unknown>).alias ?? "")) === normalizeName(input.sourceName);
  });
  const propagated = booleanFromPayload(status, "propagated");
  const rawEvidenceDeleted = booleanFromPayload(status, "rawEvidenceDeleted");
  const orphanReferenceCount = referenceAudits.reduce<number>((sum, audit) => {
    if (!audit || typeof audit !== "object") {
      return sum;
    }
    return sum + Number((audit as Record<string, unknown>).source_reference_count ?? 0);
  }, 0);
  const writeLockReleasedCount = writeLocks.filter((lock) => lock && typeof lock === "object" && (lock as Record<string, unknown>).status === "released").length;

  return {
    row: {
      id: input.id,
      sourceName: input.sourceName,
      canonicalName: input.canonicalName,
      entityType: input.entityType,
      sourceEntityType: input.sourceEntityType,
      canonicalEntityType: input.canonicalEntityType,
      applied: Boolean(applyPayload.result),
      propagated,
      aliasPreserved,
      staleActiveSourceEntityCount,
      outboxEventCount: outboxEvents.length,
      correctionEnvelopeCount: correctionSourceEnvelopes.length,
      classConstraintCount: classConstraints.length,
      referenceAuditCount: referenceAudits.length,
      writeLockReleasedCount,
      orphanReferenceCount,
      rawEvidenceDeleted,
      notes:
        propagated && aliasPreserved && correctionSourceEnvelopes.length > 0
          ? "canonical entity active, source spelling preserved as alias, replay envelope recorded"
          : "correction did not fully propagate"
    },
    queryTimeModelCalls: queryTimeModelCalls(applyPayload)
  };
}

async function verifyRelationship(namespaceId: string): Promise<{ readonly row: RelationshipVerificationRow; readonly queryTimeModelCalls: number }> {
  const payload = structuredContent(
    await executeMcpTool("memory.get_relationships", {
      namespace_id: namespaceId,
      entity_name: "Stephen",
      limit: 10
    })
  );
  const relationships = toArray(payload.relationships);
  const serialized = JSON.stringify(relationships).toLowerCase();
  const foundExpectedRelatedEntity = serialized.includes("bob");
  return {
    row: {
      queryEntity: "Stephen",
      expectedRelatedEntity: "Bob",
      relationshipCount: relationships.length,
      foundExpectedRelatedEntity,
      passed: foundExpectedRelatedEntity
    },
    queryTimeModelCalls: queryTimeModelCalls(payload)
  };
}

async function verifyAmbiguousCorrectionBlocked(namespaceId: string): Promise<{ readonly row: AmbiguousCorrectionRow; readonly queryTimeModelCalls: number }> {
  const payload = structuredContent(
    await executeMcpTool("memory.apply_correction", {
      namespace_id: namespaceId,
      source_name: "Omni Gummi",
      canonical_name: "Gumi",
      entity_type: "person",
      aliases: ["Omni Gummi"],
      preserve_aliases: true,
      note: "Benchmark ambiguous correction should ask for target selection"
    })
  );
  const preflight = payload.correctionPreflight && typeof payload.correctionPreflight === "object"
    ? payload.correctionPreflight as Record<string, unknown>
    : {};
  const candidates = toArray(preflight.candidates);
  const requiresUserChoice = payload.requiresUserChoice === true || preflight.requiresUserChoice === true;
  const applied = payload.applied !== false && Boolean(payload.result);
  return {
    row: {
      sourceName: "Omni Gummi",
      canonicalName: "Gumi",
      applied,
      requiresUserChoice,
      candidateCount: candidates.length,
      passed: !applied && requiresUserChoice && candidates.length >= 2
    },
    queryTimeModelCalls: queryTimeModelCalls(payload)
  };
}

async function keepSeparateAndVerify(namespaceId: string): Promise<{ readonly row: KeepSeparateRow; readonly queryTimeModelCalls: number }> {
  const keepPayload = structuredContent(
    await executeMcpTool("memory.keep_correction_separate", {
      namespace_id: namespaceId,
      left_name: "Alex Kim",
      right_name: "Alex King",
      entity_type: "person",
      note: "Benchmark keep-separate decision for similar person names"
    })
  );
  const statusPayload = structuredContent(
    await executeMcpTool("memory.get_correction_status", {
      namespace_id: namespaceId,
      source_name: "Alex Kim",
      canonical_name: "Alex King",
      entity_type: "person",
      limit: 10
    })
  );
  const decisions = toArray(statusPayload.identityDecisions);
  const correctionSourceEnvelopes = toArray(statusPayload.correctionSourceEnvelopes);
  const referenceAudits = toArray(statusPayload.referenceAudits);
  const keepSeparateDecision = decisions.find((decision) => {
    if (!decision || typeof decision !== "object") {
      return false;
    }
    return (decision as Record<string, unknown>).decision === "keep_separate";
  });
  return {
    row: {
      leftName: "Alex Kim",
      rightName: "Alex King",
      decision: keepSeparateDecision ? "keep_separate" : null,
      decisionTrailCount: decisions.length,
      correctionEnvelopeCount: correctionSourceEnvelopes.length,
      referenceAuditCount: referenceAudits.length,
      rawEvidenceDeleted: booleanFromPayload(keepPayload, "rawEvidenceDeleted"),
      passed:
        Boolean(keepSeparateDecision) &&
        decisions.length > 0 &&
        correctionSourceEnvelopes.length > 0 &&
        referenceAudits.length > 0 &&
        !booleanFromPayload(keepPayload, "rawEvidenceDeleted")
    },
    queryTimeModelCalls: queryTimeModelCalls(keepPayload) + queryTimeModelCalls(statusPayload)
  };
}

function toMarkdown(report: McpCorrectionPropagationReport): string {
  return [
    "# MCP Correction Propagation Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- mcpCorrectionToolCoverage: ${report.metrics.mcpCorrectionToolCoverage}`,
    `- correctionPropagationPassRate: ${report.metrics.correctionPropagationPassRate}`,
    `- aliasMergePropagationPassRate: ${report.metrics.aliasMergePropagationPassRate}`,
    `- keepSeparatePassRate: ${report.metrics.keepSeparatePassRate}`,
    `- roleCorrectionPassRate: ${report.metrics.roleCorrectionPassRate}`,
    `- spellingCorrectionRetrievalPassRate: ${report.metrics.spellingCorrectionRetrievalPassRate}`,
    `- staleAliasLeakCount: ${report.metrics.staleAliasLeakCount}`,
    `- correctionDecisionTrailCoverageRate: ${report.metrics.correctionDecisionTrailCoverageRate}`,
    `- sourceAuditAfterCorrectionPassRate: ${report.metrics.sourceAuditAfterCorrectionPassRate}`,
    `- replayableCorrectionArtifactCoverageRate: ${report.metrics.replayableCorrectionArtifactCoverageRate}`,
    `- hardClassConstraintCoverageRate: ${report.metrics.hardClassConstraintCoverageRate}`,
    `- orphanReferenceAuditPassRate: ${report.metrics.orphanReferenceAuditPassRate}`,
    `- inboxWriteLockReleaseRate: ${report.metrics.inboxWriteLockReleaseRate}`,
    `- rawEvidenceDeletedCount: ${report.metrics.rawEvidenceDeletedCount}`,
    `- ambiguousCorrectionBlockedCount: ${report.metrics.ambiguousCorrectionBlockedCount}`,
    `- ambiguousCorrectionCandidateCount: ${report.metrics.ambiguousCorrectionCandidateCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Corrections",
    "",
    report.correctionRows
      .map((row) => `- ${row.propagated ? "PASS" : "FAIL"} ${row.sourceName} -> ${row.canonicalName}; aliasPreserved=${row.aliasPreserved}; staleActive=${row.staleActiveSourceEntityCount}; outbox=${row.outboxEventCount}; envelopes=${row.correctionEnvelopeCount}; constraints=${row.classConstraintCount}; audits=${row.referenceAuditCount}; locksReleased=${row.writeLockReleasedCount}; orphanRefs=${row.orphanReferenceCount}`)
      .join("\n"),
    "",
    "## Keep Separate",
    "",
    report.keepSeparateRows
      .map((row) => `- ${row.passed ? "PASS" : "FAIL"} ${row.leftName} != ${row.rightName}; decision=${row.decision}; trail=${row.decisionTrailCount}; envelopes=${row.correctionEnvelopeCount}; audits=${row.referenceAuditCount}`)
      .join("\n"),
    "",
    "## Relationship Propagation",
    "",
    report.relationshipRows
      .map((row) => `- ${row.passed ? "PASS" : "FAIL"} ${row.queryEntity} includes ${row.expectedRelatedEntity}; relationships=${row.relationshipCount}`)
      .join("\n"),
    "",
    "## Ambiguous Correction Blocking",
    "",
    report.ambiguousRows
      .map((row) => `- ${row.passed ? "PASS" : "FAIL"} ${row.sourceName} -> ${row.canonicalName}; applied=${row.applied}; requiresUserChoice=${row.requiresUserChoice}; candidates=${row.candidateCount}`)
      .join("\n"),
    ""
  ].join("\n");
}

export async function runAndWriteMcpCorrectionPropagationPack(): Promise<{
  readonly report: McpCorrectionPropagationReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `fixture_mcp_correction_${stamp.toLowerCase()}`;
  await seedFixture(namespaceId);

  const listPayload = structuredContent(
    await executeMcpTool("memory.list_corrections", {
      namespace_id: namespaceId,
      limit: 10
    })
  );
  const corrections = [
    {
      id: "omi_gummi_alias_merge",
      namespaceId,
      sourceName: "Omi Gummi",
      canonicalName: "Gummi",
      entityType: "person"
    },
    {
      id: "steven_spelling_merge",
      namespaceId,
      sourceName: "Steven",
      canonicalName: "Stephen",
      entityType: "person"
    },
    {
      id: "chiang_mai_person_to_place_role_correction",
      namespaceId,
      sourceName: "Chiang Mai",
      canonicalName: "Chiang Mai",
      entityType: "place",
      sourceEntityType: "person",
      canonicalEntityType: "place"
    }
  ];
  const applied = [];
  let queryTimeModelCallTotal = queryTimeModelCalls(listPayload);
  for (const correction of corrections) {
    const result = await applyAndCheckCorrection(correction);
    applied.push(result.row);
    queryTimeModelCallTotal += result.queryTimeModelCalls;
  }
  const keepSeparate = await keepSeparateAndVerify(namespaceId);
  queryTimeModelCallTotal += keepSeparate.queryTimeModelCalls;
  const relationship = await verifyRelationship(namespaceId);
  queryTimeModelCallTotal += relationship.queryTimeModelCalls;
  const ambiguous = await verifyAmbiguousCorrectionBlocked(namespaceId);
  queryTimeModelCallTotal += ambiguous.queryTimeModelCalls;

  const correctionPassCount = applied.filter((row) => row.applied && row.propagated).length;
  const aliasPassCount = applied.filter((row) => row.aliasPreserved && row.staleActiveSourceEntityCount === 0).length;
  const roleCorrectionRows = applied.filter((row) => row.sourceEntityType && row.canonicalEntityType && row.sourceEntityType !== row.canonicalEntityType);
  const decisionTrailCount = applied.filter((row) => row.outboxEventCount > 0).length;
  const replayableArtifactCount = applied.filter((row) => row.correctionEnvelopeCount > 0).length + (keepSeparate.row.correctionEnvelopeCount > 0 ? 1 : 0);
  const replayableArtifactTotal = applied.length + 1;
  const hardClassConstraintCount = roleCorrectionRows.filter((row) => row.classConstraintCount > 0).length;
  const referenceAuditPassCount = applied.filter((row) => row.referenceAuditCount > 0 && row.orphanReferenceCount === 0).length + (keepSeparate.row.referenceAuditCount > 0 ? 1 : 0);
  const writeLockReleaseCount = applied.filter((row) => row.writeLockReleasedCount > 0).length;
  const sourceAuditAfterCorrectionPassCount = applied.filter((row) => row.outboxEventCount > 0 && row.aliasPreserved).length + (keepSeparate.row.decisionTrailCount > 0 ? 1 : 0);
  const sourceAuditAfterCorrectionTotal = applied.length + 1;
  const metrics = {
    mcpCorrectionToolCoverage: toArray((listPayload.guidance as Record<string, unknown> | undefined)?.examples).length >= 2 ? 1 : 0,
    correctionPropagationPassRate: correctionPassCount / applied.length,
    aliasMergePropagationPassRate: aliasPassCount / applied.length,
    keepSeparatePassRate: keepSeparate.row.passed ? 1 : 0,
    roleCorrectionPassRate:
      roleCorrectionRows.length === 0
        ? 0
        : roleCorrectionRows.filter((row) => row.propagated && row.aliasPreserved && row.staleActiveSourceEntityCount === 0).length / roleCorrectionRows.length,
    spellingCorrectionRetrievalPassRate: relationship.row.passed ? 1 : 0,
    staleAliasLeakCount: applied.reduce((sum, row) => sum + row.staleActiveSourceEntityCount, 0),
    correctionDecisionTrailCoverageRate: decisionTrailCount / applied.length,
    sourceAuditAfterCorrectionPassRate: sourceAuditAfterCorrectionPassCount / sourceAuditAfterCorrectionTotal,
    replayableCorrectionArtifactCoverageRate: replayableArtifactCount / replayableArtifactTotal,
    hardClassConstraintCoverageRate: roleCorrectionRows.length === 0 ? 0 : hardClassConstraintCount / roleCorrectionRows.length,
    orphanReferenceAuditPassRate: referenceAuditPassCount / replayableArtifactTotal,
    inboxWriteLockReleaseRate: writeLockReleaseCount / applied.length,
    rawEvidenceDeletedCount: applied.filter((row) => row.rawEvidenceDeleted).length + (keepSeparate.row.rawEvidenceDeleted ? 1 : 0),
    ambiguousCorrectionBlockedCount: ambiguous.row.passed ? 1 : 0,
    ambiguousCorrectionCandidateCount: ambiguous.row.candidateCount,
    queryTimeModelCalls: queryTimeModelCallTotal
  };
  const report: McpCorrectionPropagationReport = {
    generatedAt,
    benchmark: "mcp_correction_propagation_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId }
    }),
    namespaceId,
    passed:
      metrics.mcpCorrectionToolCoverage === 1 &&
      metrics.correctionPropagationPassRate === 1 &&
      metrics.aliasMergePropagationPassRate === 1 &&
      metrics.keepSeparatePassRate === 1 &&
      metrics.roleCorrectionPassRate === 1 &&
      metrics.spellingCorrectionRetrievalPassRate === 1 &&
      metrics.staleAliasLeakCount === 0 &&
      metrics.correctionDecisionTrailCoverageRate === 1 &&
      metrics.sourceAuditAfterCorrectionPassRate === 1 &&
      metrics.replayableCorrectionArtifactCoverageRate === 1 &&
      metrics.hardClassConstraintCoverageRate === 1 &&
      metrics.orphanReferenceAuditPassRate === 1 &&
      metrics.inboxWriteLockReleaseRate === 1 &&
      metrics.rawEvidenceDeletedCount === 0 &&
      metrics.ambiguousCorrectionBlockedCount === 1 &&
      metrics.ambiguousCorrectionCandidateCount >= 2 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    correctionRows: applied,
    keepSeparateRows: [keepSeparate.row],
    relationshipRows: [relationship.row],
    ambiguousRows: [ambiguous.row]
  };
  const root = outputDir();
  await mkdir(root, { recursive: true });
  const jsonPath = path.join(root, `mcp-correction-propagation-pack-${stamp}.json`);
  const markdownPath = path.join(root, `mcp-correction-propagation-pack-${stamp}.md`);
  const reportWithPaths = { ...report, artifactPaths: { jsonPath, markdownPath } };
  await writeFile(jsonPath, `${JSON.stringify(reportWithPaths, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(reportWithPaths)}\n`, "utf8");
  return { report: reportWithPaths, output: { jsonPath, markdownPath } };
}

export async function runMcpCorrectionPropagationPackCli(): Promise<void> {
  const { report, output } = await runAndWriteMcpCorrectionPropagationPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
