import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ProviderId } from "../providers/types.js";
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

interface TopEventRow {
  readonly event_label: string;
  readonly event_count: string;
}

interface TemporalNodeSemanticRow {
  readonly id: string;
  readonly layer: TemporalLayer;
  readonly period_start: string;
  readonly period_end: string;
  readonly summary_text: string;
  readonly metadata: Record<string, unknown>;
}

interface TemporalArchivalCandidateRow {
  readonly id: string;
  readonly layer: TemporalLayer;
  readonly period_start: string;
  readonly period_end: string;
  readonly status: "active" | "archived";
  readonly archival_tier: "hot" | "warm" | "cold";
  readonly is_anchor: boolean;
  readonly decay_exempt: boolean;
  readonly last_accessed_at: string;
  readonly access_count: number;
  readonly metadata: Record<string, unknown>;
}

interface PriorSummaryRow {
  readonly summary_text: string;
}

interface SampleEvidenceRow {
  readonly content: string;
  readonly occurred_at: string;
}

export interface TemporalSummaryRunSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly layer: TemporalLayer;
  readonly scannedBuckets: number;
  readonly upsertedNodes: number;
  readonly linkedMembers: number;
}

export interface TemporalArchivalRunSummary {
  readonly context: JobRunContext;
  readonly namespaceId: string;
  readonly scanned: number;
  readonly warmed: number;
  readonly archived: number;
}

export const DEFAULT_TEMPORAL_SUMMARY_SYSTEM_PROMPT = `You are the AI Brain 2.0 Semantic Consolidator.

Write semantic day, week, month, and year summaries on top of deterministic temporal rollups for a local-first memory system.

Rules:
1. Ground every statement only in the supplied evidence and deterministic rollup.
2. Do not invent facts. If something is ambiguous or weakly supported, say so explicitly.
3. Preserve exact names, places, project titles, versions, and technical terms.
4. Compress repetition into stable themes without losing important exceptions or changes.
5. Treat provenance as mandatory. The final summary must remain compatible with explicit supporting memory IDs.
6. Normalize first-person phrasing into stable third-person memory language when helpful.
7. Prefer durable patterns, shifts, and active truth over noisy one-off details.

Return structured summary material only.`;

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

function warmDaysForLayer(layer: TemporalLayer): number {
  switch (layer) {
    case "day":
      return 30;
    case "week":
      return 60;
    case "month":
      return 120;
    case "year":
      return 365;
    default:
      return 30;
  }
}

function coldDaysForLayer(layer: TemporalLayer): number {
  switch (layer) {
    case "day":
      return 90;
    case "week":
      return 180;
    case "month":
      return 365;
    case "year":
      return 730;
    default:
      return 90;
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
              AND p.status = 'active'
              AND p.layer = $2
              AND p.period_start <= c.period_start
              AND p.period_end >= c.period_end
            ORDER BY p.period_start DESC, p.period_end ASC
            LIMIT 1
          ) parent ON TRUE
          WHERE c.namespace_id = $1
            AND c.status = 'active'
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

async function loadTopEvents(
  client: PoolClient,
  namespaceId: string,
  periodStart: string,
  periodEnd: string
): Promise<string> {
  const topEvents = await client.query<TopEventRow>(
    `
      SELECT ne.event_label, count(*)::text AS event_count
      FROM narrative_events ne
      LEFT JOIN LATERAL (
        SELECT em.occurred_at
        FROM episodic_memory em
        WHERE em.namespace_id = ne.namespace_id
          AND em.artifact_observation_id = ne.artifact_observation_id
        ORDER BY em.occurred_at ASC, em.id ASC
        LIMIT 1
      ) AS source_memory ON TRUE
      WHERE ne.namespace_id = $1
        AND COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) >= $2::timestamptz
        AND COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) < $3::timestamptz
      GROUP BY ne.event_label
      ORDER BY count(*) DESC, ne.event_label ASC
      LIMIT 6
    `,
    [namespaceId, periodStart, periodEnd]
  );

  if ((topEvents.rowCount ?? 0) === 0) {
    return "none";
  }

  return topEvents.rows.map((row) => `${row.event_label}:${row.event_count}`).join(", ");
}

function summarizeBucket(
  layer: TemporalLayer,
  periodStart: string,
  periodEnd: string,
  eventCount: number,
  roleSummary: string,
  topEntitySummary: string,
  topEventSummary: string
): string {
  return [
    `${layer.toUpperCase()} rollup ${periodStart} -> ${periodEnd}.`,
    `events=${eventCount}.`,
    `activities=${topEventSummary}.`,
    `roles=${roleSummary}.`,
    `top_entities=${topEntitySummary}.`
  ].join(" ");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function semanticSummaryInstruction(options: {
  readonly layer: TemporalLayer;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly deterministicSummary: string;
  readonly priorSummaries: readonly string[];
  readonly sampleEvidence: readonly string[];
  readonly sourceMemoryIds: readonly string[];
}): string {
  return [
    "Return strict JSON with keys summary, recurring_themes, uncertainties.",
    "summary must be 2-4 sentences and grounded only in the provided evidence.",
    "recurring_themes must be an array of short grounded phrases.",
    "uncertainties must be an array of explicit unknowns or ambiguities.",
    "Do not invent facts. Preserve exact names, places, versions, and project names.",
    "",
    `LAYER: ${options.layer}`,
    `INTERVAL: ${options.periodStart} -> ${options.periodEnd}`,
    `DETERMINISTIC_ROLLUP: ${options.deterministicSummary}`,
    `SUPPORTING_MEMORY_IDS: ${options.sourceMemoryIds.join(", ") || "none"}`,
    `PRIOR_SAME_LEVEL_SUMMARIES:\n${options.priorSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n") || "none"}`,
    `SAMPLE_EVIDENCE:\n${options.sampleEvidence.map((item, index) => `${index + 1}. ${item}`).join("\n") || "none"}`
  ].join("\n");
}

function buildSemanticSummaryText(options: {
  readonly layer: TemporalLayer;
  readonly summary: string;
  readonly recurringThemes: readonly string[];
  readonly uncertainties: readonly string[];
  readonly sourceMemoryIds: readonly string[];
}): string {
  const lines = [
    `${options.layer.toUpperCase()} semantic summary.`,
    options.summary.trim(),
    options.recurringThemes.length > 0 ? `Recurring themes: ${options.recurringThemes.join("; ")}.` : "",
    options.uncertainties.length > 0 ? `Uncertainty: ${options.uncertainties.join("; ")}.` : "",
    options.sourceMemoryIds.length > 0 ? `Support IDs: ${options.sourceMemoryIds.join(", ")}.` : ""
  ].filter(Boolean);
  return lines.join(" ");
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
      const topEventSummary = await loadTopEvents(client, namespaceId, periodStart, periodEnd);
      const summaryText = summarizeBucket(options.layer, periodStart, periodEnd, eventCount, roleSummary, topEntitySummary, topEventSummary);

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
            status,
            archival_tier,
            archived_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'deterministic_rollup', $8::jsonb, 'active', 'hot', NULL, now())
          ON CONFLICT (namespace_id, layer, period_start, period_end, summary_version)
          DO UPDATE SET
            depth = EXCLUDED.depth,
            summary_text = EXCLUDED.summary_text,
            source_count = EXCLUDED.source_count,
            generated_by = EXCLUDED.generated_by,
            metadata = EXCLUDED.metadata,
            status = 'active',
            archival_tier = 'hot',
            archived_at = NULL,
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
            top_entities: topEntitySummary,
            top_events: topEventSummary
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
            source_scene_id,
            source_event_id,
            member_role,
            metadata
          )
          SELECT
            $1,
            $2,
            member_id,
            linked.scene_id,
            linked.event_id,
            'summary_input',
            $3::jsonb
          FROM unnest($4::uuid[]) AS member_id
          LEFT JOIN LATERAL (
            SELECT
              cc.source_scene_id AS scene_id,
              cc.source_event_id AS event_id
            FROM claim_candidates cc
            WHERE cc.namespace_id = $1
              AND cc.source_memory_id = member_id
            ORDER BY cc.created_at ASC
            LIMIT 1
          ) AS linked ON TRUE
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

export async function runTemporalNodeArchival(
  namespaceId: string,
  options?: {
    readonly limit?: number;
    readonly hotAccessThreshold?: number;
  }
): Promise<TemporalArchivalRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };
  const limit = Math.max(1, options?.limit ?? 500);
  const hotAccessThreshold = Math.max(0, options?.hotAccessThreshold ?? 10);

  return withTransaction(async (client) => {
    const candidates = await client.query<TemporalArchivalCandidateRow>(
      `
        SELECT
          tn.id::text,
          tn.layer,
          tn.period_start::text,
          tn.period_end::text,
          tn.status,
          tn.archival_tier,
          tn.is_anchor,
          tn.decay_exempt,
          tn.last_accessed_at::text,
          tn.access_count,
          tn.metadata
        FROM temporal_nodes tn
        WHERE tn.namespace_id = $1
          AND tn.status = 'active'
          AND tn.is_anchor = false
          AND tn.decay_exempt = false
        ORDER BY tn.period_end ASC, tn.id ASC
        LIMIT $2
      `,
      [namespaceId, limit]
    );

    let warmed = 0;
    let archived = 0;

    for (const row of candidates.rows) {
      const effectiveTouchedAt = row.access_count > 0 ? (row.last_accessed_at || row.period_end) : row.period_end;
      const inactivityMs = Math.max(0, Date.now() - Date.parse(effectiveTouchedAt));
      const inactivityDays = inactivityMs / (1000 * 60 * 60 * 24);
      const nextTier =
        inactivityDays >= coldDaysForLayer(row.layer)
          ? "cold"
          : inactivityDays >= warmDaysForLayer(row.layer) && row.access_count < hotAccessThreshold
            ? "warm"
            : "hot";

      if (nextTier === row.archival_tier && nextTier !== "cold") {
        continue;
      }

      const reason =
        nextTier === "cold"
          ? "Temporal summary aged past the cold archival threshold."
          : nextTier === "warm"
            ? "Temporal summary aged past the warm archival threshold."
            : "Temporal summary remains hot due to recency or access.";
      const nextMetadata = {
        ...(row.metadata ?? {}),
        archival_policy: "hot_warm_cold_v1",
        archival_tier: nextTier,
        archival_reason: reason,
        archival_state_updated_at: new Date().toISOString(),
        inactivity_days: Number(inactivityDays.toFixed(2)),
        access_count: row.access_count
      };

      if (nextTier === "cold") {
        await client.query(
          `
            UPDATE temporal_nodes
            SET
              status = 'archived',
              archival_tier = 'cold',
              archived_at = COALESCE(archived_at, now()),
              metadata = $2::jsonb,
              updated_at = now()
            WHERE id = $1::uuid
          `,
          [row.id, JSON.stringify(nextMetadata)]
        );
        archived += 1;
      } else {
        await client.query(
          `
            UPDATE temporal_nodes
            SET
              archival_tier = $2,
              metadata = $3::jsonb,
              updated_at = now()
            WHERE id = $1::uuid
          `,
          [row.id, nextTier, JSON.stringify(nextMetadata)]
        );
        warmed += nextTier === "warm" ? 1 : 0;
      }

      if (nextTier !== "hot") {
        await client.query(
          `
            INSERT INTO temporal_decay_events (
              namespace_id,
              temporal_node_id,
              action,
              previous_tier,
              new_tier,
              reason,
              metadata
            )
            VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb)
          `,
          [
            namespaceId,
            row.id,
            nextTier === "cold" ? "archived" : "warmed",
            row.archival_tier,
            nextTier,
            reason,
            JSON.stringify({
              run_id: context.runId,
              layer: row.layer,
              period_start: row.period_start,
              period_end: row.period_end,
              inactivity_days: Number(inactivityDays.toFixed(2))
            })
          ]
        );
      }
    }

    return {
      context,
      namespaceId,
      scanned: candidates.rowCount ?? 0,
      warmed,
      archived
    };
  });
}

export async function runSemanticTemporalSummaryOverlay(
  namespaceId: string,
  options: {
    readonly layer: TemporalLayer;
    readonly lookbackDays?: number;
    readonly provider: ProviderId;
    readonly model?: string;
    readonly presetId?: string;
    readonly systemPrompt?: string;
  }
): Promise<{ readonly updatedNodes: number }> {
  const lookbackDays = Math.max(1, options.lookbackDays ?? 30);
  const adapter = getProviderAdapter(options.provider);

  return withTransaction(async (client) => {
    const nodes = await client.query<TemporalNodeSemanticRow>(
      `
        SELECT
          tn.id::text,
          tn.layer,
          tn.period_start,
          tn.period_end,
          tn.summary_text,
          tn.metadata
        FROM temporal_nodes tn
        WHERE tn.namespace_id = $1
          AND tn.status = 'active'
          AND tn.layer = $2
          AND tn.period_start >= (now() - ($3::int * interval '1 day'))
        ORDER BY tn.period_start ASC
      `,
      [namespaceId, options.layer, lookbackDays]
    );

    let updatedNodes = 0;

    for (const node of nodes.rows) {
      const priorSummaries = await client.query<PriorSummaryRow>(
        `
          SELECT summary_text
          FROM temporal_nodes
          WHERE namespace_id = $1
            AND status = 'active'
            AND layer = $2
            AND period_end <= $3::timestamptz
          ORDER BY period_end DESC
          LIMIT 3
        `,
        [namespaceId, options.layer, node.period_start]
      );

      const evidenceRows = await client.query<SampleEvidenceRow & { readonly memory_id: string }>(
        `
          SELECT
            et.memory_id::text,
            et.content,
            et.occurred_at::text
          FROM temporal_node_members tnm
          JOIN episodic_timeline et ON et.memory_id = tnm.source_memory_id
          WHERE tnm.temporal_node_id = $1::uuid
            AND tnm.member_role = 'summary_input'
          ORDER BY et.occurred_at ASC
          LIMIT 8
        `,
        [node.id]
      );

      const sourceMemoryIds = evidenceRows.rows.map((row) => row.memory_id);
      const sampleEvidence = evidenceRows.rows.map((row) => `${row.occurred_at}: ${row.content}`);
      const response = await adapter.classifyText({
        text: JSON.stringify({
          namespaceId,
          layer: node.layer,
          periodStart: node.period_start,
          periodEnd: node.period_end
        }),
        model: options.model,
        systemPrompt: options.systemPrompt ?? DEFAULT_TEMPORAL_SUMMARY_SYSTEM_PROMPT,
        instruction: semanticSummaryInstruction({
          layer: node.layer,
          periodStart: node.period_start,
          periodEnd: node.period_end,
          deterministicSummary: node.summary_text,
          priorSummaries: priorSummaries.rows.map((row) => row.summary_text),
          sampleEvidence,
          sourceMemoryIds
        }),
        maxOutputTokens: 900,
        metadata: options.presetId ? { preset_id: options.presetId } : {}
      });

      const semanticOutput = response.output;
      const semanticSummary = typeof semanticOutput.summary === "string" ? semanticOutput.summary : node.summary_text;
      const recurringThemes = asStringArray(semanticOutput.recurring_themes);
      const uncertainties = asStringArray(semanticOutput.uncertainties);
      const semanticText = buildSemanticSummaryText({
        layer: node.layer,
        summary: semanticSummary,
        recurringThemes,
        uncertainties,
        sourceMemoryIds: sourceMemoryIds.slice(0, 12)
      });

      await client.query(
        `
          UPDATE temporal_nodes
          SET
            summary_text = $2,
            generated_by = 'semantic_consolidator',
            metadata = $3::jsonb,
            updated_at = now()
          WHERE id = $1::uuid
        `,
        [
          node.id,
          semanticText,
          JSON.stringify({
            ...(node.metadata ?? {}),
            deterministic_summary_text: node.summary_text,
            semantic_summary_text: semanticText,
            semantic_summary_provider: response.provider,
            semantic_summary_model: response.model,
            semantic_summary_preset: options.presetId ?? null,
            semantic_summary_updated_at: new Date().toISOString(),
            semantic_summary_recurring_themes: recurringThemes,
            semantic_summary_uncertainties: uncertainties
          })
        ]
      );

      updatedNodes += 1;
    }

    return { updatedNodes };
  });
}
