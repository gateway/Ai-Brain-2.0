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
    readonly decayFactor?: number;
    readonly minimumScore?: number;
  }
): Promise<SemanticDecayRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  const limit = Math.max(1, options?.limit ?? 200);
  const inactivityHours = Math.max(1, options?.inactivityHours ?? 24);
  const decayFactor = Math.min(0.999, Math.max(0.5, options?.decayFactor ?? 0.995));
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
          sm.last_accessed_at
        FROM semantic_memory sm
        WHERE sm.namespace_id = $1
          AND sm.status = 'active'
          AND sm.valid_until IS NULL
          AND sm.is_anchor = false
          AND sm.decay_exempt = false
          AND COALESCE(sm.last_accessed_at, sm.valid_from) <= (now() - ($2::int * interval '1 hour'))
        ORDER BY COALESCE(sm.last_accessed_at, sm.valid_from) ASC, sm.importance_score ASC
        LIMIT $3
      `,
      [namespaceId, inactivityHours, limit]
    );

    let decayed = 0;
    let archived = 0;

    for (const row of candidates.rows) {
      const floor = Math.max(minimumScore, row.decay_floor);
      const decayedScore = Math.max(floor, row.importance_score * decayFactor);
      const shouldArchive = decayedScore <= floor + Number.EPSILON;
      const action = shouldArchive ? "archived" : "decayed";

      if (shouldArchive) {
        await client.query(
          `
            UPDATE semantic_memory
            SET
              importance_score = $2,
              status = 'archived',
              valid_until = now()
            WHERE id = $1
          `,
          [row.id, decayedScore]
        );
        archived += 1;
      } else {
        await client.query(
          `
            UPDATE semantic_memory
            SET importance_score = $2
            WHERE id = $1
          `,
          [row.id, decayedScore]
        );
        decayed += 1;
      }

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
          shouldArchive
            ? "Importance score reached decay floor for inactive non-anchor memory."
            : "Applied inactivity decay to non-anchor semantic memory.",
          JSON.stringify({
            run_id: context.runId,
            inactivity_hours: inactivityHours,
            decay_factor: decayFactor,
            minimum_score: minimumScore,
            canonical_key: row.canonical_key,
            memory_kind: row.memory_kind,
            last_accessed_at: row.last_accessed_at
          })
        ]
      );
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
