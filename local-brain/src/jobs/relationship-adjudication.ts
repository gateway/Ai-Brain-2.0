import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { refreshRelationshipPriors } from "./relationship-priors.js";
import type { JobRunContext } from "./types.js";

interface RelationshipCandidateRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly subject_entity_id: string;
  readonly predicate: string;
  readonly object_entity_id: string;
  readonly confidence: number;
  readonly status: "pending" | "accepted" | "rejected" | "superseded";
  readonly prior_score: number;
  readonly prior_reason: string | null;
  readonly valid_from: string | null;
  readonly created_at: string;
  readonly source_memory_id: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface ActiveRelationshipRow {
  readonly id: string;
  readonly object_entity_id: string;
}

interface EntityAliasSignatureRow {
  readonly canonical_name: string | null;
  readonly aliases: readonly string[] | null;
}

interface RelationshipTenureRow {
  readonly id: string;
  readonly object_entity_id: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
}

interface ActiveProceduralStateRow {
  readonly id: string;
  readonly version: number;
  readonly state_value: Record<string, unknown>;
}

function relationshipKind(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.relationship_kind;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function canonicalRelationshipPredicate(candidate: RelationshipCandidateRow): string {
  const kind = relationshipKind(candidate.metadata);
  if (candidate.predicate === "was_with" && kind === "romantic") {
    return "significant_other_of";
  }
  if (candidate.predicate === "lives_in" || candidate.predicate === "currently_in") {
    return "resides_at";
  }

  return candidate.predicate;
}

function relationshipProcessingRank(candidate: RelationshipCandidateRow): number {
  const kind = relationshipKind(candidate.metadata);
  if (candidate.predicate === "was_with" && kind === "romantic") {
    return 10;
  }
  if (candidate.predicate === "relationship_ended") {
    return 20;
  }
  if (candidate.predicate === "relationship_contact_paused") {
    return 30;
  }
  if (candidate.predicate === "relationship_reconnected") {
    return 40;
  }
  return 50;
}

function residencePredicateFamily(predicate: string): readonly string[] | null {
  if (predicate === "lived_in") {
    return ["lived_in"];
  }

  if (predicate === "lives_in" || predicate === "currently_in" || predicate === "resides_at") {
    return ["lives_in", "currently_in", "resides_at"];
  }

  return null;
}

async function hasMoreSpecificResidenceCandidate(
  client: PoolClient,
  candidate: RelationshipCandidateRow
): Promise<boolean> {
  const predicateFamily = residencePredicateFamily(candidate.predicate);
  if (!predicateFamily) {
    return false;
  }

  const result = await client.query<{ matches: boolean }>(
    `
      WITH RECURSIVE peers AS (
        SELECT rc.object_entity_id
        FROM relationship_candidates rc
        WHERE rc.namespace_id = $1
          AND rc.subject_entity_id = $2::uuid
          AND rc.object_entity_id IS NOT NULL
          AND rc.object_entity_id <> $3::uuid
          AND rc.predicate = ANY($4::text[])
          AND rc.status IN ('pending', 'accepted')
          AND rc.source_memory_id IS NOT DISTINCT FROM $5::uuid
      ),
      ancestors(entity_id, hops, path) AS (
        SELECT peers.object_entity_id, 0, ARRAY[peers.object_entity_id]::uuid[]
        FROM peers

        UNION ALL

        SELECT e.parent_entity_id, ancestors.hops + 1, ancestors.path || e.parent_entity_id
        FROM ancestors
        JOIN entities e
          ON e.id = ancestors.entity_id
         AND e.namespace_id = $1
         AND e.parent_entity_id IS NOT NULL
        WHERE ancestors.hops < 6
          AND NOT (e.parent_entity_id = ANY(ancestors.path))
      )
      SELECT EXISTS(
        SELECT 1
        FROM ancestors
        WHERE entity_id = $3::uuid
      ) AS matches
    `,
    [
      candidate.namespace_id,
      candidate.subject_entity_id,
      candidate.object_entity_id,
      predicateFamily,
      candidate.source_memory_id
    ]
  );

  return Boolean(result.rows[0]?.matches);
}

export interface RelationshipAdjudicationRunSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly scanned: number;
  readonly accepted: number;
  readonly reinforced: number;
  readonly superseded: number;
  readonly rejected: number;
}

function isExclusivePredicate(predicate: string): boolean {
  const normalized = predicate.toLowerCase();
  const exclusivePredicates = new Set<string>(["primary_contact", "married_to", "ceo_of", "significant_other_of", "works_at", "resides_at"]);
  return exclusivePredicates.has(normalized);
}

function currentRelationshipStateKey(subjectEntityId: string): string {
  return `current_relationship:${subjectEntityId}:romantic`;
}

async function hasHistoricalRomanticTenure(
  client: PoolClient,
  namespaceId: string,
  subjectEntityId: string,
  objectEntityId: string
): Promise<boolean> {
  const [relationshipResult, stateResult] = await Promise.all([
    client.query<{ matches: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM relationship_memory
          WHERE namespace_id = $1
            AND subject_entity_id = $2
            AND object_entity_id = $3
            AND predicate = 'significant_other_of'
        ) AS matches
      `,
      [namespaceId, subjectEntityId, objectEntityId]
    ),
    client.query<{ matches: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM procedural_memory
          WHERE namespace_id = $1
            AND state_type = 'current_relationship'
            AND state_key = $2
            AND coalesce(state_value->>'partner_entity_id', '') = $3
        ) AS matches
      `,
      [namespaceId, currentRelationshipStateKey(subjectEntityId), objectEntityId]
    )
  ]);

  return Boolean(relationshipResult.rows[0]?.matches || stateResult.rows[0]?.matches);
}

async function isRomanticRelationshipTransition(
  client: PoolClient,
  candidate: RelationshipCandidateRow,
  canonicalPredicate: string
): Promise<boolean> {
  const kind = relationshipKind(candidate.metadata);
  if (kind === "romantic" || canonicalPredicate === "significant_other_of") {
    return true;
  }

  if (!["relationship_contact_paused", "relationship_reconnected", "relationship_ended"].includes(candidate.predicate)) {
    return false;
  }

  return hasHistoricalRomanticTenure(
    client,
    candidate.namespace_id,
    candidate.subject_entity_id,
    candidate.object_entity_id
  );
}

async function lookupCanonicalName(client: PoolClient, entityId: string): Promise<string | null> {
  const result = await client.query<{ canonical_name: string | null }>(
    `
      SELECT canonical_name
      FROM entities
      WHERE id = $1
      LIMIT 1
    `,
    [entityId]
  );

  return result.rows[0]?.canonical_name ?? null;
}

function normalizeAliasSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const costs = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) {
    costs[j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    let previous = i - 1;
    costs[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = costs[j];
      const substitution = left[i - 1] === right[j - 1] ? previous : previous + 1;
      costs[j] = Math.min(costs[j] + 1, costs[j - 1] + 1, substitution);
      previous = current;
    }
  }

  return costs[right.length] ?? 0;
}

async function loadEntityAliasSignature(client: PoolClient, entityId: string): Promise<readonly string[]> {
  const result = await client.query<EntityAliasSignatureRow>(
    `
      SELECT
        e.canonical_name,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT ea.alias), NULL) AS aliases
      FROM entities e
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      WHERE e.id = $1
      GROUP BY e.id, e.canonical_name
      LIMIT 1
    `,
    [entityId]
  );

  const row = result.rows[0];
  if (!row) {
    return [];
  }

  return [...new Set([row.canonical_name, ...(row.aliases ?? [])].filter(Boolean).map((value) => normalizeAliasSignature(String(value))))];
}

function aliasSignaturesSemanticallyConflict(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightSet = new Set(right);
  for (const leftAlias of left) {
    if (rightSet.has(leftAlias)) {
      return true;
    }
    for (const rightAlias of right) {
      if (!leftAlias || !rightAlias) {
        continue;
      }
      if (leftAlias[0] !== rightAlias[0]) {
        continue;
      }
      const distance = levenshteinDistance(leftAlias, rightAlias);
      if (distance <= 1 || ((leftAlias.includes(rightAlias) || rightAlias.includes(leftAlias)) && distance <= 2)) {
        return true;
      }
    }
  }

  return false;
}

async function hasSemanticExclusiveConflict(
  client: PoolClient,
  candidateObjectEntityId: string,
  activeObjectEntityId: string
): Promise<boolean> {
  const [candidateSignature, activeSignature] = await Promise.all([
    loadEntityAliasSignature(client, candidateObjectEntityId),
    loadEntityAliasSignature(client, activeObjectEntityId)
  ]);

  return aliasSignaturesSemanticallyConflict(candidateSignature, activeSignature);
}

async function upsertCurrentRelationshipState(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly subjectEntityId: string;
    readonly objectEntityId: string;
    readonly occurredAt: string;
    readonly sourceMemoryId: string | null;
    readonly relationshipMemoryId: string;
    readonly candidateId: string;
  }
): Promise<void> {
  const [subjectName, partnerName] = await Promise.all([
    lookupCanonicalName(client, options.subjectEntityId),
    lookupCanonicalName(client, options.objectEntityId)
  ]);
  const stateKey = currentRelationshipStateKey(options.subjectEntityId);
  const stateValue = {
    person: subjectName,
    partner: partnerName,
    relationship_kind: "romantic",
    subject_entity_id: options.subjectEntityId,
    partner_entity_id: options.objectEntityId,
    relationship_memory_id: options.relationshipMemoryId,
    source_memory_id: options.sourceMemoryId
  };

  const activeState = await client.query<ActiveProceduralStateRow>(
    `
      SELECT id, version, state_value
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'current_relationship'
        AND state_key = $2
        AND valid_until IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [options.namespaceId, stateKey]
  );
  const latestVersionResult = await client.query<{ version: number }>(
    `
      SELECT COALESCE(MAX(version), 0)::int AS version
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'current_relationship'
        AND state_key = $2
    `,
    [options.namespaceId, stateKey]
  );

  const activeRow = activeState.rows[0];
  if (activeRow && JSON.stringify(activeRow.state_value) === JSON.stringify(stateValue)) {
    await client.query(
      `
        UPDATE procedural_memory
        SET metadata = procedural_memory.metadata || $2::jsonb
        WHERE id = $1
      `,
      [
        activeRow.id,
        JSON.stringify({
          relationship_memory_id: options.relationshipMemoryId,
          last_candidate_id: options.candidateId,
          last_updated_at: options.occurredAt
        })
      ]
    );
    return;
  }

  if (activeRow) {
    await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = $2
        WHERE id = $1
      `,
      [activeRow.id, options.occurredAt]
    );
  }

  await client.query(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, 'current_relationship', $2, $3::jsonb, $4, $5, $5, NULL, $6, $7::jsonb)
    `,
    [
      options.namespaceId,
      stateKey,
      JSON.stringify(stateValue),
      (latestVersionResult.rows[0]?.version ?? 0) + 1,
      options.occurredAt,
      activeRow?.id ?? null,
      JSON.stringify({
        relationship_kind: "romantic",
        relationship_memory_id: options.relationshipMemoryId,
        source_memory_id: options.sourceMemoryId,
        candidate_id: options.candidateId
      })
    ]
  );
}

async function closeCurrentRelationshipState(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly subjectEntityId: string;
    readonly objectEntityId: string;
    readonly occurredAt: string;
    readonly candidateId: string;
    readonly supersededById?: string | null;
    readonly transition: "ended" | "paused";
  }
): Promise<void> {
  await client.query(
    `
      UPDATE procedural_memory
      SET
        valid_until = $3,
        metadata = procedural_memory.metadata || $4::jsonb
      WHERE namespace_id = $1
        AND state_type = 'current_relationship'
        AND state_key = $2
        AND valid_until IS NULL
        AND coalesce(state_value->>'partner_entity_id', '') = $5
    `,
    [
      options.namespaceId,
      currentRelationshipStateKey(options.subjectEntityId),
      options.occurredAt,
      JSON.stringify({
        relationship_transition: options.transition,
        ended_at: options.occurredAt,
        ended_by_candidate_id: options.candidateId,
        superseded_by_id: options.supersededById ?? null
      }),
      options.objectEntityId
    ]
  );
}

async function loadActiveRomanticTenure(
  client: PoolClient,
  namespaceId: string,
  subjectEntityId: string,
  objectEntityId: string
): Promise<RelationshipTenureRow | null> {
  const result = await client.query<RelationshipTenureRow>(
    `
      SELECT id, object_entity_id, valid_until
      , valid_from
      FROM relationship_memory
      WHERE namespace_id = $1
        AND subject_entity_id = $2
        AND object_entity_id = $3
        AND predicate = 'significant_other_of'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    [namespaceId, subjectEntityId, objectEntityId]
  );

  return result.rows[0] ?? null;
}

async function loadLatestClosedRomanticTenure(
  client: PoolClient,
  namespaceId: string,
  subjectEntityId: string,
  objectEntityId: string
): Promise<RelationshipTenureRow | null> {
  const result = await client.query<RelationshipTenureRow>(
    `
      SELECT id, object_entity_id, valid_until
      , valid_from
      FROM relationship_memory
      WHERE namespace_id = $1
        AND subject_entity_id = $2
        AND object_entity_id = $3
        AND predicate = 'significant_other_of'
        AND valid_until IS NOT NULL
      ORDER BY valid_until DESC, valid_from DESC
      LIMIT 1
    `,
    [namespaceId, subjectEntityId, objectEntityId]
  );

  return result.rows[0] ?? null;
}

async function closeActiveRomanticTenure(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly subjectEntityId: string;
    readonly objectEntityId: string;
    readonly occurredAt: string;
    readonly candidateId: string;
    readonly transition: "ended" | "paused";
    readonly supersededById?: string | null;
  }
): Promise<RelationshipTenureRow | null> {
  const activeRow = await loadActiveRomanticTenure(
    client,
    options.namespaceId,
    options.subjectEntityId,
    options.objectEntityId
  );

  if (!activeRow) {
    return null;
  }

  await client.query(
    `
      UPDATE relationship_memory
      SET
        status = 'superseded',
        valid_until = $2,
        superseded_by_id = $3,
        metadata = relationship_memory.metadata || $4::jsonb
      WHERE id = $1
    `,
    [
      activeRow.id,
      options.occurredAt,
      options.supersededById ?? null,
      JSON.stringify({
        relationship_transition: options.transition,
        ended_by_candidate_id: options.candidateId,
        ended_at: options.occurredAt,
        superseded_by_candidate_id: options.candidateId,
        superseded_by_id: options.supersededById ?? null
      })
    ]
  );

  await closeCurrentRelationshipState(client, {
    namespaceId: options.namespaceId,
    subjectEntityId: options.subjectEntityId,
    objectEntityId: options.objectEntityId,
    occurredAt: options.occurredAt,
    candidateId: options.candidateId,
    supersededById: options.supersededById ?? null,
    transition: options.transition
  });

  return activeRow;
}

async function countParticipationMembershipSignals(
  client: PoolClient,
  candidate: RelationshipCandidateRow,
  occurredAt: string
): Promise<number> {
  const result = await client.query<{ signal_count: string }>(
    `
      SELECT COUNT(DISTINCT COALESCE(source_memory_id::text, id::text))::text AS signal_count
      FROM relationship_candidates
      WHERE namespace_id = $1
        AND subject_entity_id = $2
        AND object_entity_id = $3
        AND predicate = 'member_of'
        AND coalesce(metadata->>'membership_signal', '') = 'participation'
        AND status IN ('pending', 'accepted')
        AND COALESCE(valid_from, created_at) >= ($4::timestamptz - interval '180 days')
        AND COALESCE(valid_from, created_at) <= $4::timestamptz
    `,
    [candidate.namespace_id, candidate.subject_entity_id, candidate.object_entity_id, occurredAt]
  );

  return Number(result.rows[0]?.signal_count ?? 0);
}

async function hasCollapsedRomanticTransitionContext(
  client: PoolClient,
  candidate: RelationshipCandidateRow
): Promise<boolean> {
  if (candidate.predicate !== "was_with" || relationshipKind(candidate.metadata) !== "romantic") {
    return false;
  }

  const occurredAt = candidate.valid_from ?? candidate.created_at;
  const result = await client.query<{ matches: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM relationship_candidates rc
        WHERE rc.namespace_id = $1
          AND rc.subject_entity_id = $2
          AND rc.object_entity_id = $3
          AND rc.id <> $4
          AND rc.status IN ('pending', 'accepted')
          AND rc.predicate = ANY($5::text[])
          AND COALESCE(rc.valid_from, rc.created_at) = $6::timestamptz
          AND rc.source_memory_id IS NOT DISTINCT FROM $7::uuid
      ) AS matches
    `,
    [
      candidate.namespace_id,
      candidate.subject_entity_id,
      candidate.object_entity_id,
      candidate.id,
      ["relationship_ended", "relationship_contact_paused", "relationship_reconnected"],
      occurredAt,
      candidate.source_memory_id
    ]
  );

  return Boolean(result.rows[0]?.matches);
}

async function markRelationshipCandidate(
  client: PoolClient,
  candidateId: string,
  status: "accepted" | "rejected" | "superseded",
  reason: string
): Promise<void> {
  await client.query(
    `
      UPDATE relationship_candidates
      SET
        status = $2,
        processed_at = now(),
        decision_reason = $3
      WHERE id = $1
    `,
    [candidateId, status, reason]
  );
}

async function logEvent(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly candidateId: string;
    readonly relationshipMemoryId: string | null;
    readonly action: "accepted" | "rejected" | "superseded" | "reinforced";
    readonly reason: string;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO relationship_adjudication_events (
        namespace_id,
        candidate_id,
        relationship_memory_id,
        action,
        reason,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      options.namespaceId,
      options.candidateId,
      options.relationshipMemoryId,
      options.action,
      options.reason,
      JSON.stringify(options.metadata ?? {})
    ]
  );
}

export async function runRelationshipAdjudication(
  namespaceId: string,
  options?: {
    readonly limit?: number;
    readonly acceptThreshold?: number;
    readonly rejectThreshold?: number;
  }
): Promise<RelationshipAdjudicationRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };
  const limit = Math.max(1, options?.limit ?? 200);
  const acceptThreshold = Math.min(1, Math.max(0.01, options?.acceptThreshold ?? 0.6));
  const rejectThreshold = Math.min(acceptThreshold, Math.max(0, options?.rejectThreshold ?? 0.4));

  const summary = await withTransaction(async (client) => {
    const candidates = await client.query<RelationshipCandidateRow>(
      `
        SELECT
          rc.id,
          rc.namespace_id,
          rc.subject_entity_id,
          rc.predicate,
          rc.object_entity_id,
          rc.confidence,
          rc.status,
          rc.prior_score,
          rc.prior_reason,
          rc.valid_from,
          rc.created_at,
          rc.source_memory_id,
          rc.metadata
        FROM relationship_candidates rc
        WHERE rc.namespace_id = $1
          AND rc.processed_at IS NULL
          AND rc.status IN ('pending', 'accepted')
        ORDER BY ((rc.confidence * 0.72) + (rc.prior_score * 0.28)) DESC, COALESCE(rc.valid_from, rc.created_at) ASC
        LIMIT $2
      `,
      [namespaceId, limit]
    );

    let accepted = 0;
    let reinforced = 0;
    let superseded = 0;
    let rejected = 0;

    const orderedCandidates = candidates.rows.slice().sort((left, right) => {
      const leftOccurred = Date.parse(left.valid_from ?? left.created_at) || 0;
      const rightOccurred = Date.parse(right.valid_from ?? right.created_at) || 0;
      if (leftOccurred !== rightOccurred) {
        return leftOccurred - rightOccurred;
      }

      const leftRank = relationshipProcessingRank(left);
      const rightRank = relationshipProcessingRank(right);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      const leftScore = (left.confidence * 0.72) + (left.prior_score * 0.28);
      const rightScore = (right.confidence * 0.72) + (right.prior_score * 0.28);
      return rightScore - leftScore;
    });

    for (const candidate of orderedCandidates) {
      const providerAccepted = candidate.status === "accepted";
      const effectiveConfidence = Math.max(
        candidate.confidence,
        Math.round(((candidate.confidence * 0.72) + (candidate.prior_score * 0.28)) * 1000) / 1000
      );
      const historicalRelationship = candidate.metadata?.historical_relationship === true;
      const canonicalPredicate = canonicalRelationshipPredicate(candidate);
      const relationshipTransition =
        typeof candidate.metadata?.relationship_transition === "string" ? candidate.metadata.relationship_transition : null;
      const romanticTransition = await isRomanticRelationshipTransition(client, candidate, canonicalPredicate);

      if (romanticTransition && (candidate.predicate === "relationship_ended" || candidate.predicate === "relationship_contact_paused")) {
        const occurredAt = candidate.valid_from ?? candidate.created_at;
        const transition = candidate.predicate === "relationship_contact_paused" ? "paused" : "ended";
        const activeRow = await closeActiveRomanticTenure(client, {
          namespaceId,
          subjectEntityId: candidate.subject_entity_id,
          objectEntityId: candidate.object_entity_id,
          occurredAt,
          candidateId: candidate.id,
          transition
        });

        const transitionReason =
          transition === "paused"
            ? "Closed active romantic relationship tenure from paused-contact evidence."
            : "Closed active romantic relationship tenure from breakup evidence.";
        if (activeRow) {
          await markRelationshipCandidate(client, candidate.id, "accepted", transitionReason);
        } else {
          await markRelationshipCandidate(
            client,
            candidate.id,
            "accepted",
            transition === "paused"
              ? "Accepted paused-contact evidence without an active romantic tenure to close."
              : "Accepted breakup evidence without an active romantic tenure to close."
          );
        }
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: activeRow?.id ?? null,
          action: activeRow ? "superseded" : "accepted",
          reason: activeRow
            ? transitionReason
            : transition === "paused"
              ? "Accepted paused-contact evidence without active romantic tenure."
              : "Accepted breakup evidence without active romantic tenure.",
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason,
            historical_relationship: historicalRelationship,
            relationship_transition: relationshipTransition
          }
        });
        accepted += 1;
        if (activeRow) {
          superseded += 1;
        }
        continue;
      }

      if (romanticTransition && candidate.predicate === "relationship_reconnected") {
        const occurredAt = candidate.valid_from ?? candidate.created_at;
        const exactRomantic = await loadActiveRomanticTenure(
          client,
          namespaceId,
          candidate.subject_entity_id,
          candidate.object_entity_id
        );

        if (exactRomantic) {
          await client.query(
            `
              UPDATE relationship_memory
              SET
                confidence = GREATEST(confidence, $2),
                metadata = relationship_memory.metadata || $3::jsonb
              WHERE id = $1
            `,
            [
              exactRomantic.id,
              effectiveConfidence,
              JSON.stringify({
                last_candidate_id: candidate.id,
                last_reinforced_at: occurredAt,
                last_prior_score: candidate.prior_score,
                last_effective_confidence: effectiveConfidence,
                relationship_transition: "reconnected"
              })
            ]
          );
          await upsertCurrentRelationshipState(client, {
            namespaceId,
            subjectEntityId: candidate.subject_entity_id,
            objectEntityId: candidate.object_entity_id,
            occurredAt,
            sourceMemoryId: candidate.source_memory_id,
            relationshipMemoryId: exactRomantic.id,
            candidateId: candidate.id
          });
          await markRelationshipCandidate(client, candidate.id, "accepted", "Reinforced existing active romantic relationship after reconnection evidence.");
          await logEvent(client, {
            namespaceId,
            candidateId: candidate.id,
            relationshipMemoryId: exactRomantic.id,
            action: "reinforced",
            reason: "Reinforced existing active romantic relationship after reconnection evidence.",
            metadata: {
              run_id: context.runId,
              confidence: candidate.confidence,
              prior_score: candidate.prior_score,
              effective_confidence: effectiveConfidence,
              prior_reason: candidate.prior_reason,
              relationship_transition: relationshipTransition
            }
          });
          reinforced += 1;
          continue;
        }

        const priorClosed = await loadLatestClosedRomanticTenure(
          client,
          namespaceId,
          candidate.subject_entity_id,
          candidate.object_entity_id
        );
        if (priorClosed?.valid_from === occurredAt) {
          await markRelationshipCandidate(
            client,
            candidate.id,
            "accepted",
            "Accepted reconnection evidence as historical-only because the source collapsed multiple romantic transitions onto the same timestamp."
          );
          await logEvent(client, {
            namespaceId,
            candidateId: candidate.id,
            relationshipMemoryId: priorClosed.id,
            action: "accepted",
            reason: "Accepted reconnection evidence as historical-only because the source collapsed multiple romantic transitions onto the same timestamp.",
            metadata: {
              run_id: context.runId,
              confidence: candidate.confidence,
              prior_score: candidate.prior_score,
              effective_confidence: effectiveConfidence,
              prior_reason: candidate.prior_reason,
              relationship_transition: relationshipTransition,
              collapsed_same_timestamp: true
            }
          });
          accepted += 1;
          continue;
        }

        const inserted = await client.query<{ id: string }>(
          `
            INSERT INTO relationship_memory (
              namespace_id,
              subject_entity_id,
              predicate,
              object_entity_id,
              confidence,
              status,
              valid_from,
              source_candidate_id,
              metadata
            )
            VALUES ($1, $2, 'significant_other_of', $3, $4, 'active', $5, $6, $7::jsonb)
            RETURNING id
          `,
          [
            namespaceId,
            candidate.subject_entity_id,
            candidate.object_entity_id,
            effectiveConfidence,
            occurredAt,
            candidate.id,
            JSON.stringify({
              run_id: context.runId,
              source_memory_id: candidate.source_memory_id,
              prior_score: candidate.prior_score,
              effective_confidence: effectiveConfidence,
              prior_reason: candidate.prior_reason,
              relationship_kind: "romantic",
              relationship_transition: "reconnected",
              original_predicate: candidate.predicate
            })
          ]
        );

        const relationshipMemoryId = inserted.rows[0]?.id;
        if (!relationshipMemoryId) {
          throw new Error("Failed to insert reconnected romantic relationship memory");
        }

        if (priorClosed) {
          await client.query(
            `
              UPDATE relationship_memory
              SET
                superseded_by_id = $2,
                metadata = relationship_memory.metadata || $3::jsonb
              WHERE id = $1
            `,
            [
              priorClosed.id,
              relationshipMemoryId,
              JSON.stringify({
                superseded_by_candidate_id: candidate.id,
                reconnected_at: occurredAt
              })
            ]
          );
        }

        await upsertCurrentRelationshipState(client, {
          namespaceId,
          subjectEntityId: candidate.subject_entity_id,
          objectEntityId: candidate.object_entity_id,
          occurredAt,
          sourceMemoryId: candidate.source_memory_id,
          relationshipMemoryId,
          candidateId: candidate.id
        });

        await markRelationshipCandidate(client, candidate.id, "accepted", "Reopened romantic relationship tenure from reconnection evidence.");
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId,
          action: "accepted",
          reason: "Reopened romantic relationship tenure from reconnection evidence.",
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason,
            relationship_transition: relationshipTransition,
            reopened_prior_tenure_id: priorClosed?.id ?? null
          }
        });
        accepted += 1;
        continue;
      }

      if (
        historicalRelationship &&
        candidate.predicate !== "was_with" &&
        candidate.predicate !== "relationship_ended"
      ) {
        const reason = "Historical relationship transition retained as accepted evidence without active relationship promotion.";
        await markRelationshipCandidate(client, candidate.id, "accepted", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "accepted",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason,
            historical_relationship: true,
            relationship_transition: relationshipTransition
          }
        });
        accepted += 1;
        continue;
      }

      if (!providerAccepted && effectiveConfidence < rejectThreshold) {
        const reason = `Rejected deterministic adjudication: effective confidence ${effectiveConfidence.toFixed(2)} < ${rejectThreshold.toFixed(2)} (raw ${candidate.confidence.toFixed(2)}, prior ${candidate.prior_score.toFixed(2)}).`;
        await markRelationshipCandidate(client, candidate.id, "rejected", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "rejected",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason
          }
        });
        rejected += 1;
        continue;
      }

      if (!providerAccepted && effectiveConfidence < acceptThreshold) {
        const reason = `Rejected deterministic adjudication: effective confidence ${effectiveConfidence.toFixed(2)} below accept threshold ${acceptThreshold.toFixed(2)} (raw ${candidate.confidence.toFixed(2)}, prior ${candidate.prior_score.toFixed(2)}).`;
        await markRelationshipCandidate(client, candidate.id, "rejected", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "rejected",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason
          }
        });
        rejected += 1;
        continue;
      }

      if (await hasMoreSpecificResidenceCandidate(client, candidate)) {
        const reason = "Rejected broader residence edge because a more specific contained place exists in the same source context.";
        await markRelationshipCandidate(client, candidate.id, "rejected", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "rejected",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason
          }
        });
        rejected += 1;
        continue;
      }

      const occurredAt = candidate.valid_from ?? candidate.created_at;
      if (canonicalPredicate === "member_of" && candidate.metadata?.membership_signal === "participation") {
        const signalCount = await countParticipationMembershipSignals(client, candidate, occurredAt);
        if (signalCount < 3) {
          await markRelationshipCandidate(
            client,
            candidate.id,
            "accepted",
            `Membership participation threshold not met (${signalCount}/3 signals in 180 days).`
          );
          await logEvent(client, {
            namespaceId,
            candidateId: candidate.id,
            relationshipMemoryId: null,
            action: "accepted",
            reason: `Membership participation threshold not met (${signalCount}/3 signals in 180 days).`,
            metadata: {
              run_id: context.runId,
              confidence: candidate.confidence,
              prior_score: candidate.prior_score,
              effective_confidence: effectiveConfidence,
              prior_reason: candidate.prior_reason,
              signal_count: signalCount
            }
          });
          accepted += 1;
          continue;
        }
      }

      if (historicalRelationship && canonicalPredicate === "significant_other_of" && await hasCollapsedRomanticTransitionContext(client, candidate)) {
        const reason =
          "Historical romantic evidence retained without active tenure promotion because the source collapses dating, breakup, and reconnection transitions onto the same timestamp.";
        await markRelationshipCandidate(client, candidate.id, "accepted", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "accepted",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason,
            historical_relationship: true,
            collapsed_transition_source: true
          }
        });
        accepted += 1;
        continue;
      }

      const exactActive = await client.query<ActiveRelationshipRow>(
        `
          SELECT id, object_entity_id
          FROM relationship_memory
          WHERE namespace_id = $1
            AND subject_entity_id = $2
            AND predicate = $3
            AND object_entity_id = $4
            AND status = 'active'
            AND valid_until IS NULL
          ORDER BY valid_from DESC
          LIMIT 1
        `,
        [namespaceId, candidate.subject_entity_id, canonicalPredicate, candidate.object_entity_id]
      );

      const exactMatch = exactActive.rows[0];
      if (exactMatch) {
        await client.query(
          `
            UPDATE relationship_memory
            SET
              confidence = GREATEST(confidence, $2),
              metadata = relationship_memory.metadata || $3::jsonb
            WHERE id = $1
          `,
          [
            exactMatch.id,
            effectiveConfidence,
            JSON.stringify({
              last_candidate_id: candidate.id,
              last_reinforced_at: occurredAt,
              last_prior_score: candidate.prior_score,
              last_effective_confidence: effectiveConfidence
            })
          ]
        );

        if (canonicalPredicate === "significant_other_of") {
          await upsertCurrentRelationshipState(client, {
            namespaceId,
            subjectEntityId: candidate.subject_entity_id,
            objectEntityId: candidate.object_entity_id,
            occurredAt,
            sourceMemoryId: candidate.source_memory_id,
            relationshipMemoryId: exactMatch.id,
            candidateId: candidate.id
          });
        }

        await markRelationshipCandidate(client, candidate.id, "accepted", "Reinforced existing active relationship edge.");
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: exactMatch.id,
          action: "reinforced",
          reason: "Reinforced existing active relationship edge.",
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason
          }
        });
        reinforced += 1;
        continue;
      }

      const conflictingActive = await client.query<ActiveRelationshipRow>(
        `
          SELECT id, object_entity_id
          FROM relationship_memory
          WHERE namespace_id = $1
            AND subject_entity_id = $2
            AND predicate = $3
            AND status = 'active'
            AND valid_until IS NULL
          ORDER BY valid_from DESC
        `,
        [namespaceId, candidate.subject_entity_id, canonicalPredicate]
      );

      const activeConflicts = isExclusivePredicate(canonicalPredicate)
        ? conflictingActive.rows.filter((row) => row.object_entity_id !== candidate.object_entity_id)
        : [];

      const semanticConflicts: ActiveRelationshipRow[] = [];
      for (const prior of activeConflicts) {
        if (await hasSemanticExclusiveConflict(client, candidate.object_entity_id, prior.object_entity_id)) {
          semanticConflicts.push(prior);
        }
      }
      if (semanticConflicts.length > 0) {
        const reason =
          "Accepted relationship evidence without active promotion because the new tenure conflicts semantically with an existing active alias/persona and needs merge or clarification before supersession.";
        await markRelationshipCandidate(client, candidate.id, "accepted", reason);
        await logEvent(client, {
          namespaceId,
          candidateId: candidate.id,
          relationshipMemoryId: null,
          action: "accepted",
          reason,
          metadata: {
            run_id: context.runId,
            confidence: candidate.confidence,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason,
            semantic_conflict_object_entity_ids: semanticConflicts.map((row) => row.object_entity_id),
            semantic_conflict_count: semanticConflicts.length
          }
        });
        accepted += 1;
        continue;
      }

      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO relationship_memory (
            namespace_id,
            subject_entity_id,
            predicate,
            object_entity_id,
            confidence,
            status,
            valid_from,
            source_candidate_id,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8::jsonb)
          RETURNING id
        `,
        [
          namespaceId,
          candidate.subject_entity_id,
          canonicalPredicate,
          candidate.object_entity_id,
          effectiveConfidence,
          occurredAt,
          candidate.id,
          JSON.stringify({
            run_id: context.runId,
            source_memory_id: candidate.source_memory_id,
              prior_score: candidate.prior_score,
              effective_confidence: effectiveConfidence,
              prior_reason: candidate.prior_reason,
              relationship_kind: relationshipKind(candidate.metadata),
              relationship_transition: relationshipTransition,
              original_predicate: candidate.predicate
            })
        ]
      );

      const relationshipMemoryId = inserted.rows[0]?.id;
      if (!relationshipMemoryId) {
        throw new Error("Failed to insert relationship memory");
      }

      if (canonicalPredicate === "significant_other_of") {
        await upsertCurrentRelationshipState(client, {
          namespaceId,
          subjectEntityId: candidate.subject_entity_id,
          objectEntityId: candidate.object_entity_id,
          occurredAt,
          sourceMemoryId: candidate.source_memory_id,
          relationshipMemoryId,
          candidateId: candidate.id
        });
      }

      for (const prior of activeConflicts) {
        await client.query(
          `
            UPDATE relationship_memory
            SET
              status = 'superseded',
              valid_until = $2,
              superseded_by_id = $3,
              metadata = relationship_memory.metadata || $4::jsonb
            WHERE id = $1
          `,
          [
            prior.id,
            occurredAt,
            relationshipMemoryId,
            JSON.stringify({
              superseded_at: occurredAt,
              superseded_by_candidate_id: candidate.id,
              superseded_by_predicate: canonicalPredicate,
              superseded_by_object_entity_id: candidate.object_entity_id
            })
          ]
        );
      }

      await markRelationshipCandidate(client, candidate.id, "accepted", "Promoted candidate into relationship memory.");
      await logEvent(client, {
        namespaceId,
        candidateId: candidate.id,
        relationshipMemoryId,
        action: activeConflicts.length > 0 ? "superseded" : "accepted",
        reason:
          activeConflicts.length > 0
            ? `Promoted relationship and superseded ${activeConflicts.length} conflicting active edge(s).`
            : "Promoted relationship candidate into active relationship memory.",
        metadata: {
          run_id: context.runId,
          confidence: candidate.confidence,
          prior_score: candidate.prior_score,
          effective_confidence: effectiveConfidence,
          prior_reason: candidate.prior_reason,
          superseded_count: activeConflicts.length
        }
      });

      accepted += 1;
      superseded += activeConflicts.length;
    }

    return {
      context,
      namespaceId,
      scanned: candidates.rowCount ?? 0,
      accepted,
      reinforced,
      superseded,
      rejected
    };
  });

  await refreshRelationshipPriors(namespaceId);
  return summary;
}
