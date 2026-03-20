import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/client.js";
import type { JobRunContext } from "./types.js";

interface DecayCandidateRow {
  readonly id: string;
  readonly importance_score: number;
  readonly decay_floor: number;
  readonly canonical_key: string | null;
  readonly memory_kind: string;
  readonly last_accessed_at: string;
  readonly access_count: number;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly status: "active" | "superseded" | "invalid" | "archived";
  readonly metadata: Record<string, unknown> | null;
}

export interface SemanticDecayRunSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly scanned: number;
  readonly decayed: number;
  readonly archived: number;
}

export async function runSemanticDecay(
  namespaceId: string,
  options?: {
    readonly limit?: number;
    readonly inactivityHours?: number;
    readonly coldInactivityHours?: number;
    readonly decayFactor?: number;
    readonly hotImportanceThreshold?: number;
    readonly hotAccessThreshold?: number;
    readonly minimumScore?: number;
  }
): Promise<SemanticDecayRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  const limit = Math.max(1, options?.limit ?? 200);
  const inactivityHours = Math.max(1, options?.inactivityHours ?? 24 * 30);
  const coldInactivityHours = Math.max(inactivityHours + 1, options?.coldInactivityHours ?? 24 * 120);
  const decayFactor = Math.min(0.999, Math.max(0.1, options?.decayFactor ?? 0.5));
  const hotImportanceThreshold = Math.min(1, Math.max(0, options?.hotImportanceThreshold ?? 0.8));
  const hotAccessThreshold = Math.max(0, options?.hotAccessThreshold ?? 10);
  const minimumScore = Math.min(1, Math.max(0.01, options?.minimumScore ?? 0.1));

  return withTransaction(async (client) => {
    const candidates = await client.query<DecayCandidateRow>(
      `
        SELECT
          sm.id,
          sm.importance_score,
          sm.decay_floor,
          sm.canonical_key,
          sm.memory_kind,
          sm.last_accessed_at,
          sm.access_count,
          sm.valid_from,
          sm.valid_until,
          sm.status,
          sm.metadata
        FROM semantic_memory sm
        WHERE sm.namespace_id = $1
          AND sm.status IN ('active', 'superseded')
          AND sm.is_anchor = false
          AND sm.decay_exempt = false
          AND (
            sm.canonical_key LIKE 'reconsolidated:%'
            OR sm.memory_kind IN ('state_summary', 'profile_summary', 'belief_summary', 'day_summary')
          )
        ORDER BY COALESCE(sm.last_accessed_at, sm.valid_from) ASC, sm.importance_score ASC, sm.id ASC
        LIMIT $2
      `,
      [namespaceId, limit]
    );

    let decayed = 0;
    let archived = 0;

    for (const row of candidates.rows) {
      const floor = Math.max(minimumScore, row.decay_floor);
      const lastTouchedAt = row.last_accessed_at || row.valid_from;
      const inactivityMs = Math.max(0, Date.now() - Date.parse(lastTouchedAt));
      const inactivityAgeHours = inactivityMs / (1000 * 60 * 60);
      const shouldArchive =
        row.status !== "active" ||
        row.valid_until !== null ||
        inactivityAgeHours >= coldInactivityHours ||
        row.importance_score <= floor + Number.EPSILON;
      const shouldRemainHot =
        !shouldArchive &&
        (row.importance_score >= hotImportanceThreshold ||
          row.access_count >= hotAccessThreshold ||
          inactivityAgeHours < inactivityHours);
      const nextTier = shouldArchive ? "cold" : shouldRemainHot ? "hot" : "warm";
      const decayedScore = shouldArchive
        ? floor
        : shouldRemainHot
          ? row.importance_score
          : Math.max(floor, row.importance_score * decayFactor);
      const action = shouldArchive ? "archived" : shouldRemainHot ? null : "decayed";
      const archivalReason = shouldArchive
        ? row.status !== "active" || row.valid_until !== null
          ? "Superseded derived semantic memory moved to cold archival."
          : "Inactive derived semantic memory crossed the cold archival threshold."
        : shouldRemainHot
          ? "Derived semantic memory remains hot due to recency, importance, or access."
          : "Inactive derived semantic memory was demoted to the warm tier.";
      const nextMetadata = {
        ...(row.metadata ?? {}),
        archival_policy: "hot_warm_cold_v1",
        archival_tier: nextTier,
        archival_reason: archivalReason,
        archival_state_updated_at: new Date().toISOString(),
        inactivity_hours: Number(inactivityAgeHours.toFixed(2)),
        access_count: row.access_count
      };

      if (shouldArchive) {
        await client.query(
          `
            UPDATE semantic_memory
            SET
              importance_score = $2,
              status = 'archived',
              valid_until = COALESCE(valid_until, now()),
              embedding = NULL,
              embedding_model = NULL,
              metadata = $3::jsonb
            WHERE id = $1
          `,
          [row.id, decayedScore, JSON.stringify(nextMetadata)]
        );
        archived += 1;
      } else if (!shouldRemainHot) {
        await client.query(
          `
            UPDATE semantic_memory
            SET
              importance_score = $2,
              metadata = $3::jsonb
            WHERE id = $1
          `,
          [row.id, decayedScore, JSON.stringify(nextMetadata)]
        );
        decayed += 1;
      } else {
        await client.query(
          `
            UPDATE semantic_memory
            SET metadata = $2::jsonb
            WHERE id = $1
          `,
          [row.id, JSON.stringify(nextMetadata)]
        );
      }

      if (action) {
        await client.query(
          `
            INSERT INTO semantic_decay_events (
              namespace_id,
              semantic_memory_id,
              action,
              previous_importance_score,
              new_importance_score,
              reason,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          `,
          [
            namespaceId,
            row.id,
            action,
            row.importance_score,
            decayedScore,
            archivalReason,
            JSON.stringify({
              run_id: context.runId,
              inactivity_hours: inactivityHours,
              cold_inactivity_hours: coldInactivityHours,
              decay_factor: decayFactor,
              minimum_score: minimumScore,
              canonical_key: row.canonical_key,
              memory_kind: row.memory_kind,
              last_accessed_at: row.last_accessed_at,
              access_count: row.access_count,
              archival_tier: nextTier
            })
          ]
        );
      }
    }

    return {
      context,
      namespaceId,
      scanned: candidates.rowCount ?? 0,
      decayed,
      archived
    };
  });
}
