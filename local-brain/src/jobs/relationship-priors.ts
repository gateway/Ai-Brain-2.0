import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/client.js";
import type { JobRunContext } from "./types.js";

export interface RelationshipPriorRefreshSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly upsertedPairs: number;
  readonly aliasSignatureUpdates: number;
}

export async function refreshRelationshipPriors(namespaceId: string): Promise<RelationshipPriorRefreshSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  return withTransaction(async (client) => {
    const pairRows = await client.query<{
      entity_a_id: string;
      entity_b_id: string;
      co_occurrence_count: number;
      accepted_relationship_count: number;
      event_support_count: number;
      scene_support_count: number;
      last_co_occurred_at: string | null;
      global_correlation_score: number;
      neighbor_signature: Record<string, unknown>;
    }>(
      `
        WITH event_pairs AS (
          SELECT
            LEAST(mem_a.entity_id, mem_b.entity_id)::uuid AS entity_a_id,
            GREATEST(mem_a.entity_id, mem_b.entity_id)::uuid AS entity_b_id,
            COUNT(DISTINCT mem_a.event_id)::integer AS event_support_count,
            MAX(COALESCE(ne.time_start, ne.created_at)) AS last_co_occurred_at
          FROM narrative_event_members mem_a
          JOIN narrative_event_members mem_b
            ON mem_a.namespace_id = mem_b.namespace_id
           AND mem_a.event_id = mem_b.event_id
           AND mem_a.entity_id < mem_b.entity_id
          LEFT JOIN narrative_events ne ON ne.id = mem_a.event_id
          WHERE mem_a.namespace_id = $1
          GROUP BY 1, 2
        ),
        scene_pairs AS (
          SELECT
            LEAST(cc.subject_entity_id, cc.object_entity_id)::uuid AS entity_a_id,
            GREATEST(cc.subject_entity_id, cc.object_entity_id)::uuid AS entity_b_id,
            COUNT(DISTINCT cc.source_scene_id)::integer AS scene_support_count
          FROM claim_candidates cc
          WHERE cc.namespace_id = $1
            AND cc.subject_entity_id IS NOT NULL
            AND cc.object_entity_id IS NOT NULL
          GROUP BY 1, 2
        ),
        relationship_pairs AS (
          SELECT
            LEAST(rm.subject_entity_id, rm.object_entity_id)::uuid AS entity_a_id,
            GREATEST(rm.subject_entity_id, rm.object_entity_id)::uuid AS entity_b_id,
            COUNT(*)::integer AS accepted_relationship_count,
            MAX(rm.valid_from) AS last_seen_at
          FROM relationship_memory rm
          WHERE rm.namespace_id = $1
          GROUP BY 1, 2
        ),
        merged AS (
          SELECT
            COALESCE(ep.entity_a_id, sp.entity_a_id, rp.entity_a_id) AS entity_a_id,
            COALESCE(ep.entity_b_id, sp.entity_b_id, rp.entity_b_id) AS entity_b_id,
            COALESCE(ep.event_support_count, 0) AS event_support_count,
            COALESCE(sp.scene_support_count, 0) AS scene_support_count,
            COALESCE(rp.accepted_relationship_count, 0) AS accepted_relationship_count,
            GREATEST(
              COALESCE(ep.last_co_occurred_at, '-infinity'::timestamptz),
              COALESCE(rp.last_seen_at, '-infinity'::timestamptz)
            ) AS last_co_occurred_at
          FROM event_pairs ep
          FULL OUTER JOIN scene_pairs sp
            ON ep.entity_a_id = sp.entity_a_id
           AND ep.entity_b_id = sp.entity_b_id
          FULL OUTER JOIN relationship_pairs rp
            ON COALESCE(ep.entity_a_id, sp.entity_a_id) = rp.entity_a_id
           AND COALESCE(ep.entity_b_id, sp.entity_b_id) = rp.entity_b_id
        )
        SELECT
          m.entity_a_id::text,
          m.entity_b_id::text,
          (m.event_support_count + m.scene_support_count + m.accepted_relationship_count)::integer AS co_occurrence_count,
          m.accepted_relationship_count,
          m.event_support_count,
          m.scene_support_count,
          NULLIF(m.last_co_occurred_at, '-infinity'::timestamptz)::text AS last_co_occurred_at,
          LEAST(
            1,
            ROUND(
              (
                (m.accepted_relationship_count * 0.36) +
                (m.event_support_count * 0.24) +
                (m.scene_support_count * 0.12) +
                LEAST(m.event_support_count + m.scene_support_count + m.accepted_relationship_count, 6) * 0.07
              )::numeric,
              3
            )
          )::double precision AS global_correlation_score,
          jsonb_build_object(
            'event_support_count', m.event_support_count,
            'scene_support_count', m.scene_support_count,
            'accepted_relationship_count', m.accepted_relationship_count
          ) AS neighbor_signature
        FROM merged m
        WHERE m.entity_a_id IS NOT NULL
          AND m.entity_b_id IS NOT NULL
          AND m.entity_a_id <> m.entity_b_id
      `,
      [namespaceId]
    );

    for (const row of pairRows.rows) {
      await client.query(
        `
          INSERT INTO relationship_priors (
            namespace_id,
            entity_a_id,
            entity_b_id,
            co_occurrence_count,
            accepted_relationship_count,
            event_support_count,
            scene_support_count,
            last_co_occurred_at,
            global_correlation_score,
            neighbor_signature,
            updated_at
          )
          VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb, now())
          ON CONFLICT (namespace_id, entity_a_id, entity_b_id)
          DO UPDATE SET
            co_occurrence_count = EXCLUDED.co_occurrence_count,
            accepted_relationship_count = EXCLUDED.accepted_relationship_count,
            event_support_count = EXCLUDED.event_support_count,
            scene_support_count = EXCLUDED.scene_support_count,
            last_co_occurred_at = EXCLUDED.last_co_occurred_at,
            global_correlation_score = EXCLUDED.global_correlation_score,
            neighbor_signature = EXCLUDED.neighbor_signature,
            updated_at = now()
        `,
        [
          namespaceId,
          row.entity_a_id,
          row.entity_b_id,
          row.co_occurrence_count,
          row.accepted_relationship_count,
          row.event_support_count,
          row.scene_support_count,
          row.last_co_occurred_at,
          row.global_correlation_score,
          JSON.stringify(row.neighbor_signature ?? {})
        ]
      );
    }

    const aliasSignatureUpdate = await client.query<{ updated_count: string }>(
      `
        WITH neighbor_rollup AS (
          SELECT
            entity_id,
            jsonb_build_object(
              'top_neighbors',
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'neighbor_entity_id', neighbor_entity_id,
                    'score', global_correlation_score
                  )
                  ORDER BY global_correlation_score DESC
                ) FILTER (WHERE rn <= 5),
                '[]'::jsonb
              )
            ) AS signature
          FROM (
            SELECT
              entity_a_id AS entity_id,
              entity_b_id AS neighbor_entity_id,
              global_correlation_score,
              ROW_NUMBER() OVER (PARTITION BY entity_a_id ORDER BY global_correlation_score DESC, entity_b_id) AS rn
            FROM relationship_priors
            WHERE namespace_id = $1
            UNION ALL
            SELECT
              entity_b_id AS entity_id,
              entity_a_id AS neighbor_entity_id,
              global_correlation_score,
              ROW_NUMBER() OVER (PARTITION BY entity_b_id ORDER BY global_correlation_score DESC, entity_a_id) AS rn
            FROM relationship_priors
            WHERE namespace_id = $1
          ) ranked
          GROUP BY entity_id
        ),
        updated AS (
          UPDATE entity_aliases ea
          SET neighbor_signatures = COALESCE(nr.signature, '{}'::jsonb)
          FROM neighbor_rollup nr
          WHERE ea.entity_id = nr.entity_id
          RETURNING 1
        )
        SELECT COUNT(*)::text AS updated_count
        FROM updated
      `,
      [namespaceId]
    );

    return {
      context,
      namespaceId,
      upsertedPairs: pairRows.rowCount ?? 0,
      aliasSignatureUpdates: Number(aliasSignatureUpdate.rows[0]?.updated_count ?? 0)
    };
  });
}
