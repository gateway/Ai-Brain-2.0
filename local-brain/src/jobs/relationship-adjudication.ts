import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import type { JobRunContext } from "./types.js";

interface RelationshipCandidateRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly subject_entity_id: string;
  readonly predicate: string;
  readonly object_entity_id: string;
  readonly confidence: number;
  readonly prior_score: number;
  readonly prior_reason: string | null;
  readonly valid_from: string | null;
  readonly created_at: string;
  readonly source_memory_id: string | null;
}

interface ActiveRelationshipRow {
  readonly id: string;
  readonly object_entity_id: string;
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
  const exclusivePredicates = new Set<string>(["primary_contact", "married_to", "ceo_of"]);
  return exclusivePredicates.has(normalized);
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

  return withTransaction(async (client) => {
    const candidates = await client.query<RelationshipCandidateRow>(
      `
        SELECT
          rc.id,
          rc.namespace_id,
          rc.subject_entity_id,
          rc.predicate,
          rc.object_entity_id,
          rc.confidence,
          rc.prior_score,
          rc.prior_reason,
          rc.valid_from,
          rc.created_at,
          rc.source_memory_id
        FROM relationship_candidates rc
        WHERE rc.namespace_id = $1
          AND rc.status = 'pending'
        ORDER BY ((rc.confidence * 0.72) + (rc.prior_score * 0.28)) DESC, COALESCE(rc.valid_from, rc.created_at) ASC
        LIMIT $2
      `,
      [namespaceId, limit]
    );

    let accepted = 0;
    let reinforced = 0;
    let superseded = 0;
    let rejected = 0;

    for (const candidate of candidates.rows) {
      const effectiveConfidence = Math.max(
        candidate.confidence,
        Math.round(((candidate.confidence * 0.72) + (candidate.prior_score * 0.28)) * 1000) / 1000
      );

      if (effectiveConfidence < rejectThreshold) {
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

      if (effectiveConfidence < acceptThreshold) {
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

      const occurredAt = candidate.valid_from ?? candidate.created_at;
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
        [namespaceId, candidate.subject_entity_id, candidate.predicate, candidate.object_entity_id]
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
        [namespaceId, candidate.subject_entity_id, candidate.predicate]
      );

      const activeConflicts = isExclusivePredicate(candidate.predicate)
        ? conflictingActive.rows.filter((row) => row.object_entity_id !== candidate.object_entity_id)
        : [];

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
          candidate.predicate,
          candidate.object_entity_id,
          effectiveConfidence,
          occurredAt,
          candidate.id,
          JSON.stringify({
            run_id: context.runId,
            source_memory_id: candidate.source_memory_id,
            prior_score: candidate.prior_score,
            effective_confidence: effectiveConfidence,
            prior_reason: candidate.prior_reason
          })
        ]
      );

      const relationshipMemoryId = inserted.rows[0]?.id;
      if (!relationshipMemoryId) {
        throw new Error("Failed to insert relationship memory");
      }

      for (const prior of activeConflicts) {
        await client.query(
          `
            UPDATE relationship_memory
            SET
              status = 'superseded',
              valid_until = $2,
              superseded_by_id = $3
            WHERE id = $1
          `,
          [prior.id, occurredAt, relationshipMemoryId]
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
}
