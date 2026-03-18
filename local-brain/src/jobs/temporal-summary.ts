import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import type { JobRunContext } from "./types.js";

export type TemporalLayer = "day" | "week" | "month" | "year";

interface TemporalBucketRow {
  readonly bucket_start: string;
  readonly bucket_end: string;
  readonly event_count: string;
  readonly memory_ids: readonly string[];
}

interface RoleCountRow {
  readonly role: string;
  readonly count: string;
}

interface TopEntityRow {
  readonly canonical_name: string;
  readonly mention_count: string;
}

export interface TemporalSummaryRunSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly layer: TemporalLayer;
  readonly scannedBuckets: number;
  readonly upsertedNodes: number;
  readonly linkedMembers: number;
}

function intervalForLayer(layer: TemporalLayer): string {
  if (layer === "day") {
    return "1 day";
  }
  if (layer === "week") {
    return "1 week";
  }
  if (layer === "month") {
    return "1 month";
  }
  return "1 year";
}

function buildBucketExpression(layer: TemporalLayer): string {
  if (layer === "day") {
    return "date_trunc('day', et.occurred_at)";
  }
  if (layer === "week") {
    return "date_trunc('week', et.occurred_at)";
  }
  if (layer === "month") {
    return "date_trunc('month', et.occurred_at)";
  }
  return "date_trunc('year', et.occurred_at)";
}

function depthForLayer(layer: TemporalLayer): number {
  switch (layer) {
    case "day":
      return 2;
    case "week":
      return 3;
    case "month":
      return 4;
    case "year":
      return 5;
    default:
      return 0;
  }
}

async function linkTemporalHierarchy(client: PoolClient, namespaceId: string): Promise<void> {
  const linkSpecs: ReadonlyArray<{ readonly child: TemporalLayer; readonly parent: TemporalLayer }> = [
    { child: "day", parent: "week" },
    { child: "week", parent: "month" },
    { child: "month", parent: "year" }
  ];

  for (const spec of linkSpecs) {
    await client.query(
      `
        UPDATE temporal_nodes child
        SET
          parent_id = resolved.parent_id,
          depth = resolved.child_depth
        FROM (
          SELECT
            c.id AS child_id,
            parent.id AS parent_id,
            CASE c.layer
              WHEN 'day' THEN 2
              WHEN 'week' THEN 3
              WHEN 'month' THEN 4
              WHEN 'year' THEN 5
              ELSE 0
            END AS child_depth
          FROM temporal_nodes c
          JOIN LATERAL (
            SELECT p.id
            FROM temporal_nodes p
            WHERE p.namespace_id = c.namespace_id
              AND p.layer = $2
              AND p.period_start <= c.period_start
              AND p.period_end >= c.period_end
            ORDER BY p.period_start DESC, p.period_end ASC
            LIMIT 1
          ) parent ON TRUE
          WHERE c.namespace_id = $1
            AND c.layer = $3
        ) AS resolved
        WHERE child.id = resolved.child_id
          AND child.parent_id IS DISTINCT FROM resolved.parent_id
      `,
      [namespaceId, spec.parent, spec.child]
    );
  }
}

async function loadRoleCounts(
  client: PoolClient,
  namespaceId: string,
  periodStart: string,
  periodEnd: string
): Promise<string> {
  const roleCounts = await client.query<RoleCountRow>(
    `
      SELECT role, count(*)::text AS count
      FROM episodic_timeline
      WHERE namespace_id = $1
        AND occurred_at >= $2::timestamptz
        AND occurred_at < $3::timestamptz
      GROUP BY role
      ORDER BY role
    `,
    [namespaceId, periodStart, periodEnd]
  );

  if ((roleCounts.rowCount ?? 0) === 0) {
    return "none";
  }

  return roleCounts.rows.map((row) => `${row.role}:${row.count}`).join(", ");
}

async function loadTopEntities(
  client: PoolClient,
  namespaceId: string,
  periodStart: string,
  periodEnd: string
): Promise<string> {
  const topEntities = await client.query<TopEntityRow>(
    `
      SELECT e.canonical_name, count(*)::text AS mention_count
      FROM memory_entity_mentions mem
      JOIN entities e ON e.id = mem.entity_id
      WHERE mem.namespace_id = $1
        AND mem.occurred_at >= $2::timestamptz
        AND mem.occurred_at < $3::timestamptz
      GROUP BY e.canonical_name
      ORDER BY count(*) DESC, e.canonical_name ASC
      LIMIT 5
    `,
    [namespaceId, periodStart, periodEnd]
  );

  if ((topEntities.rowCount ?? 0) === 0) {
    return "none";
  }

  return topEntities.rows.map((row) => `${row.canonical_name}:${row.mention_count}`).join(", ");
}

function summarizeBucket(
  layer: TemporalLayer,
  periodStart: string,
  periodEnd: string,
  eventCount: number,
  roleSummary: string,
  topEntitySummary: string
): string {
  return [
    `${layer.toUpperCase()} rollup ${periodStart} -> ${periodEnd}.`,
    `events=${eventCount}.`,
    `roles=${roleSummary}.`,
    `top_entities=${topEntitySummary}.`
  ].join(" ");
}

export async function runTemporalSummaryScaffold(
  namespaceId: string,
  options: {
    readonly layer: TemporalLayer;
    readonly lookbackDays?: number;
    readonly maxMembersPerNode?: number;
  }
): Promise<TemporalSummaryRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };
  const lookbackDays = Math.max(1, options.lookbackDays ?? 30);
  const maxMembersPerNode = Math.max(1, options.maxMembersPerNode ?? 500);
  const interval = intervalForLayer(options.layer);
  const bucketExpression = buildBucketExpression(options.layer);

  return withTransaction(async (client) => {
    const buckets = await client.query<TemporalBucketRow>(
      `
        SELECT
          ${bucketExpression} AS bucket_start,
          (${bucketExpression} + $2::interval) AS bucket_end,
          count(*)::text AS event_count,
          array_agg(et.memory_id ORDER BY et.occurred_at ASC) AS memory_ids
        FROM episodic_timeline et
        WHERE et.namespace_id = $1
          AND et.occurred_at >= (now() - ($3::int * interval '1 day'))
        GROUP BY ${bucketExpression}
        ORDER BY ${bucketExpression} ASC
      `,
      [namespaceId, interval, lookbackDays]
    );

    let upsertedNodes = 0;
    let linkedMembers = 0;

    for (const bucket of buckets.rows) {
      const periodStart = bucket.bucket_start;
      const periodEnd = bucket.bucket_end;
      const eventCount = Number(bucket.event_count);
      const roleSummary = await loadRoleCounts(client, namespaceId, periodStart, periodEnd);
      const topEntitySummary = await loadTopEntities(client, namespaceId, periodStart, periodEnd);
      const summaryText = summarizeBucket(options.layer, periodStart, periodEnd, eventCount, roleSummary, topEntitySummary);

      const nodeResult = await client.query<{ id: string }>(
        `
          INSERT INTO temporal_nodes (
            namespace_id,
            layer,
            depth,
            period_start,
            period_end,
            summary_text,
            source_count,
            summary_version,
            generated_by,
            metadata,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'deterministic_rollup', $8::jsonb, now())
          ON CONFLICT (namespace_id, layer, period_start, period_end, summary_version)
          DO UPDATE SET
            depth = EXCLUDED.depth,
            summary_text = EXCLUDED.summary_text,
            source_count = EXCLUDED.source_count,
            generated_by = EXCLUDED.generated_by,
            metadata = EXCLUDED.metadata,
            updated_at = now()
          RETURNING id
        `,
        [
          namespaceId,
          options.layer,
          depthForLayer(options.layer),
          periodStart,
          periodEnd,
          summaryText,
          eventCount,
          JSON.stringify({
            role_summary: roleSummary,
            top_entities: topEntitySummary
          })
        ]
      );

      const temporalNodeId = nodeResult.rows[0]?.id;
      if (!temporalNodeId) {
        throw new Error("Failed to upsert temporal node");
      }
      upsertedNodes += 1;

      await client.query(
        `
          DELETE FROM temporal_node_members
          WHERE temporal_node_id = $1
            AND member_role = 'summary_input'
        `,
        [temporalNodeId]
      );

      const memberIds = bucket.memory_ids.slice(0, maxMembersPerNode);
      if (memberIds.length === 0) {
        continue;
      }

      const insertedMembers = await client.query(
        `
          INSERT INTO temporal_node_members (
            namespace_id,
            temporal_node_id,
            source_memory_id,
            member_role,
            metadata
          )
          SELECT
            $1,
            $2,
            member_id,
            'summary_input',
            $3::jsonb
          FROM unnest($4::uuid[]) AS member_id
          ON CONFLICT DO NOTHING
        `,
        [
          namespaceId,
          temporalNodeId,
          JSON.stringify({
            run_id: context.runId,
            layer: options.layer
          }),
          memberIds
        ]
      );

      linkedMembers += insertedMembers.rowCount ?? 0;
    }

    await linkTemporalHierarchy(client, namespaceId);

    return {
      context,
      namespaceId,
      layer: options.layer,
      scannedBuckets: buckets.rowCount ?? 0,
      upsertedNodes,
      linkedMembers
    };
  });
}
