import { queryRows } from "../db/client.js";
import { readConfig } from "../config.js";

interface CountRow {
  readonly total: string;
}

interface QueueStatusRow {
  readonly status: string;
  readonly count: string;
}

interface TimelineRow {
  readonly memory_id: string;
  readonly content: string;
  readonly occurred_at: string;
  readonly artifact_id: string | null;
  readonly source_uri: string | null;
  readonly metadata: Record<string, unknown>;
}

interface TemporalSummaryRow {
  readonly temporal_node_id: string;
  readonly layer: "session" | "day" | "week" | "month" | "year" | "profile";
  readonly summary_text: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly source_count: number;
  readonly depth: number | null;
  readonly parent_id: string | null;
  readonly metadata: Record<string, unknown>;
}

interface RelationshipGraphRow {
  readonly relationship_id: string;
  readonly subject_entity_id: string;
  readonly subject_name: string;
  readonly subject_type: string;
  readonly object_entity_id: string;
  readonly object_name: string;
  readonly object_type: string;
  readonly predicate: string;
  readonly confidence: number | string | null;
  readonly valid_from: string;
  readonly source_candidate_id: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ClarificationInboxSummaryRow {
  readonly ambiguity_type: string | null;
  readonly total: string;
}

interface ClarificationInboxItemRow {
  readonly candidate_id: string;
  readonly claim_type: string;
  readonly predicate: string;
  readonly subject_text: string | null;
  readonly object_text: string | null;
  readonly confidence: number;
  readonly prior_score: number;
  readonly ambiguity_type: string;
  readonly ambiguity_reason: string | null;
  readonly occurred_at: string;
  readonly scene_text: string | null;
  readonly source_uri: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface QueueSummary {
  readonly pending: number;
  readonly processing: number;
  readonly failed: number;
  readonly completed: number;
  readonly nextAttemptAt?: string;
}

export interface OpsOverview {
  readonly lexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackEnabled: boolean;
  readonly queueSummary: {
    readonly derivation: QueueSummary;
    readonly vectorSync: QueueSummary;
  };
  readonly memorySummary: {
    readonly temporalNodes: number;
    readonly relationshipCandidatesPending: number;
    readonly relationshipMemoryActive: number;
    readonly semanticDecayEvents: number;
    readonly clarificationPending: number;
    readonly outboxPending: number;
  };
}

export interface OpsTimelineItem {
  readonly memoryId: string;
  readonly content: string;
  readonly occurredAt: string;
  readonly artifactId?: string | null;
  readonly sourceUri?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsTemporalSummary {
  readonly temporalNodeId: string;
  readonly layer: "session" | "day" | "week" | "month" | "year" | "profile";
  readonly summaryText: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sourceCount: number;
  readonly depth?: number | null;
  readonly parentId?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsTimelineView {
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly timeline: readonly OpsTimelineItem[];
  readonly summaries: readonly OpsTemporalSummary[];
}

export interface OpsRelationshipGraphNode {
  readonly id: string;
  readonly name: string;
  readonly entityType: string;
  readonly degree: number;
  readonly mentionCount: number;
  readonly isSelected: boolean;
}

export interface OpsRelationshipGraphEdge {
  readonly id: string;
  readonly subjectId: string;
  readonly objectId: string;
  readonly subjectName: string;
  readonly objectName: string;
  readonly predicate: string;
  readonly confidence: number;
  readonly validFrom: string;
  readonly sourceCandidateId?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsRelationshipGraph {
  readonly namespaceId: string;
  readonly selectedEntity?: string;
  readonly nodes: readonly OpsRelationshipGraphNode[];
  readonly edges: readonly OpsRelationshipGraphEdge[];
}

export interface OpsClarificationInboxItem {
  readonly candidateId: string;
  readonly claimType: string;
  readonly predicate: string;
  readonly targetRole: "subject" | "object";
  readonly rawText: string;
  readonly confidence: number;
  readonly priorScore: number;
  readonly ambiguityType: string;
  readonly ambiguityReason?: string | null;
  readonly suggestedMatches: readonly string[];
  readonly occurredAt: string;
  readonly sceneText?: string | null;
  readonly sourceUri?: string | null;
}

export interface OpsClarificationInbox {
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly items: readonly OpsClarificationInboxItem[];
}

function toCount(rows: readonly CountRow[]): number {
  return Number(rows[0]?.total ?? 0);
}

function summarizeQueues(rows: readonly QueueStatusRow[]): QueueSummary {
  const summary = {
    pending: 0,
    processing: 0,
    failed: 0,
    completed: 0
  };

  for (const row of rows) {
    const value = Number(row.count);

    switch (row.status) {
      case "pending":
        summary.pending = value;
        break;
      case "processing":
        summary.processing = value;
        break;
      case "failed":
        summary.failed = value;
        break;
      case "completed":
      case "synced":
        summary.completed += value;
        break;
      default:
        break;
    }
  }

  return summary;
}

export async function getOpsOverview(): Promise<OpsOverview> {
  const config = readConfig();

  const [
    derivationStatusRows,
    derivationNextAttemptRows,
    vectorStatusRows,
    vectorNextAttemptRows,
    temporalNodeRows,
    relationshipCandidateRows,
    relationshipMemoryRows,
    semanticDecayRows,
    clarificationPendingRows,
    outboxPendingRows
  ] = await Promise.all([
    queryRows<QueueStatusRow>(
      `
      SELECT status, COUNT(*)::text AS count
      FROM derivation_jobs
      GROUP BY status
      `
    ),
    queryRows<{ readonly next_attempt_at: string }>(
      `
      SELECT next_attempt_at
      FROM derivation_jobs
      WHERE status IN ('pending', 'processing', 'failed')
      ORDER BY next_attempt_at ASC
      LIMIT 1
      `
    ),
    queryRows<QueueStatusRow>(
      `
      SELECT status, COUNT(*)::text AS count
      FROM vector_sync_jobs
      GROUP BY status
      `
    ),
    queryRows<{ readonly next_attempt_at: string }>(
      `
      SELECT next_attempt_at
      FROM vector_sync_jobs
      WHERE status IN ('pending', 'processing', 'failed')
      ORDER BY next_attempt_at ASC
      LIMIT 1
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM temporal_nodes
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM relationship_candidates
      WHERE processed_at IS NULL
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM relationship_memory
      WHERE status = 'active' AND valid_until IS NULL
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM semantic_decay_events
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM claim_candidates
      WHERE ambiguity_state = 'requires_clarification'
      `
    ),
    queryRows<CountRow>(
      `
      SELECT COUNT(*)::text AS total
      FROM brain_outbox_events
      WHERE status IN ('pending', 'processing', 'failed')
      `
    )
  ]);

  return {
    lexicalProvider: config.lexicalProvider,
    lexicalFallbackEnabled: config.lexicalFallbackEnabled,
    queueSummary: {
      derivation: {
        ...summarizeQueues(derivationStatusRows),
        nextAttemptAt: derivationNextAttemptRows[0]?.next_attempt_at
      },
      vectorSync: {
        ...summarizeQueues(vectorStatusRows),
        nextAttemptAt: vectorNextAttemptRows[0]?.next_attempt_at
      }
    },
    memorySummary: {
      temporalNodes: toCount(temporalNodeRows),
      relationshipCandidatesPending: toCount(relationshipCandidateRows),
      relationshipMemoryActive: toCount(relationshipMemoryRows),
      semanticDecayEvents: toCount(semanticDecayRows),
      clarificationPending: toCount(clarificationPendingRows),
      outboxPending: toCount(outboxPendingRows)
    }
  };
}

function parseSuggestedMatches(metadata: Record<string, unknown>): string[] {
  const raw = metadata.suggested_matches;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") {
        return (value as { name: string }).name;
      }
      return "";
    })
    .filter((value) => typeof value === "string" && value.trim().length > 0);
}

export async function getOpsClarificationInbox(namespaceId: string, limit = 40): Promise<OpsClarificationInbox> {
  const [summaryRows, itemRows] = await Promise.all([
    queryRows<ClarificationInboxSummaryRow>(
      `
      SELECT ambiguity_type, COUNT(*)::text AS total
      FROM claim_candidates
      WHERE namespace_id = $1
        AND ambiguity_state = 'requires_clarification'
      GROUP BY ambiguity_type
      `,
      [namespaceId]
    ),
    queryRows<ClarificationInboxItemRow>(
      `
      SELECT
        cc.id AS candidate_id,
        cc.claim_type,
        cc.predicate,
        cc.subject_text,
        cc.object_text,
        cc.confidence,
        cc.prior_score,
        cc.ambiguity_type,
        cc.ambiguity_reason,
        cc.occurred_at::text,
        ns.scene_text,
        a.uri AS source_uri,
        cc.metadata
      FROM claim_candidates cc
      LEFT JOIN narrative_scenes ns ON ns.id = cc.source_scene_id
      LEFT JOIN artifacts a ON a.id = ns.artifact_id
      WHERE cc.namespace_id = $1
        AND cc.ambiguity_state = 'requires_clarification'
      ORDER BY cc.prior_score DESC, cc.occurred_at DESC, cc.created_at DESC
      LIMIT $2
      `,
      [namespaceId, limit]
    )
  ]);

  const byType: Record<string, number> = {};
  for (const row of summaryRows) {
    byType[row.ambiguity_type ?? "unknown"] = Number(row.total);
  }

  return {
    namespaceId,
    summary: {
      total: Object.values(byType).reduce((sum, value) => sum + value, 0),
      byType
    },
    items: itemRows.map((row) => {
      const targetRole =
        typeof row.metadata.ambiguity_target_role === "string" && (row.metadata.ambiguity_target_role === "subject" || row.metadata.ambiguity_target_role === "object")
          ? row.metadata.ambiguity_target_role
          : row.object_text
            ? "object"
            : "subject";
      const rawText = typeof row.metadata.raw_ambiguous_text === "string"
        ? row.metadata.raw_ambiguous_text
        : targetRole === "subject"
          ? row.subject_text ?? ""
          : row.object_text ?? "";

      return {
        candidateId: row.candidate_id,
        claimType: row.claim_type,
        predicate: row.predicate,
        targetRole,
        rawText,
        confidence: row.confidence,
        priorScore: row.prior_score,
        ambiguityType: row.ambiguity_type,
        ambiguityReason: row.ambiguity_reason,
        suggestedMatches:
          row.ambiguity_type === "possible_misspelling" || row.ambiguity_type === "alias_collision"
            ? parseSuggestedMatches(row.metadata)
            : [],
        occurredAt: row.occurred_at,
        sceneText: row.scene_text,
        sourceUri: row.source_uri
      };
    })
  };
}

export async function getOpsTimelineView(
  namespaceId: string,
  timeStart: string,
  timeEnd: string,
  limit = 40
): Promise<OpsTimelineView> {
  const [timelineRows, summaryRows] = await Promise.all([
    queryRows<TimelineRow>(
      `
      SELECT
        et.memory_id,
        et.content,
        et.occurred_at::text,
        et.artifact_id,
        a.uri AS source_uri,
        et.metadata
      FROM episodic_timeline et
      LEFT JOIN artifacts a ON a.id = et.artifact_id
      WHERE et.namespace_id = $1
        AND et.occurred_at >= $2::timestamptz
        AND et.occurred_at <= $3::timestamptz
      ORDER BY et.occurred_at ASC
      LIMIT $4
      `,
      [namespaceId, timeStart, timeEnd, limit]
    ),
    queryRows<TemporalSummaryRow>(
      `
      WITH ranked AS (
        SELECT
          tn.id AS temporal_node_id,
          tn.layer,
          tn.summary_text,
          tn.period_start::text,
          tn.period_end::text,
          tn.source_count,
          tn.depth,
          tn.parent_id,
          tn.metadata,
          ROW_NUMBER() OVER (
            PARTITION BY tn.layer
            ORDER BY tn.period_start DESC, tn.source_count DESC, tn.id
          ) AS layer_rank
        FROM temporal_nodes tn
        WHERE tn.namespace_id = $1
          AND tn.period_end >= $2::timestamptz
          AND tn.period_start <= $3::timestamptz
      )
      SELECT *
      FROM ranked
      WHERE layer_rank <= 3
      ORDER BY
        CASE layer
          WHEN 'year' THEN 1
          WHEN 'month' THEN 2
          WHEN 'week' THEN 3
          WHEN 'day' THEN 4
          WHEN 'session' THEN 5
          WHEN 'profile' THEN 6
          ELSE 7
        END,
        period_start ASC
      `
      ,
      [namespaceId, timeStart, timeEnd]
    )
  ]);

  return {
    namespaceId,
    timeStart,
    timeEnd,
    timeline: timelineRows.map((row) => ({
      memoryId: row.memory_id,
      content: row.content,
      occurredAt: row.occurred_at,
      artifactId: row.artifact_id,
      sourceUri: row.source_uri,
      metadata: row.metadata
    })),
    summaries: summaryRows.map((row) => ({
      temporalNodeId: row.temporal_node_id,
      layer: row.layer,
      summaryText: row.summary_text,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      sourceCount: row.source_count,
      depth: row.depth,
      parentId: row.parent_id,
      metadata: row.metadata
    }))
  };
}

export async function getOpsRelationshipGraph(
  namespaceId: string,
  options?: {
    readonly entityName?: string;
    readonly timeStart?: string;
    readonly timeEnd?: string;
    readonly limit?: number;
  }
): Promise<OpsRelationshipGraph> {
  const entityName = options?.entityName?.trim();
  const limit = options?.limit ?? 36;
  const rows = await queryRows<RelationshipGraphRow>(
    `
    SELECT
      rm.id AS relationship_id,
      rm.subject_entity_id::text,
      subject.canonical_name AS subject_name,
      subject.entity_type AS subject_type,
      rm.object_entity_id::text,
      object_entity.canonical_name AS object_name,
      object_entity.entity_type AS object_type,
      rm.predicate,
      rm.confidence,
      rm.valid_from::text,
      rm.source_candidate_id::text,
      rm.metadata
    FROM relationship_memory rm
    JOIN entities subject ON subject.id = rm.subject_entity_id
    JOIN entities object_entity ON object_entity.id = rm.object_entity_id
    WHERE rm.namespace_id = $1
      AND rm.status = 'active'
      AND rm.valid_until IS NULL
      AND subject.merged_into_entity_id IS NULL
      AND object_entity.merged_into_entity_id IS NULL
      AND ($2::timestamptz IS NULL OR rm.valid_from >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR rm.valid_from <= $3::timestamptz)
      AND (
        $4::text IS NULL
        OR lower(subject.canonical_name) = lower($4::text)
        OR lower(object_entity.canonical_name) = lower($4::text)
      )
    ORDER BY rm.confidence DESC, rm.valid_from DESC
    LIMIT $5
    `,
    [namespaceId, options?.timeStart ?? null, options?.timeEnd ?? null, entityName ?? null, limit]
  );

  const mentionRows = await queryRows<{ readonly entity_id: string; readonly mention_count: string }>(
    `
    SELECT
      entity_id::text,
      COUNT(*)::text AS mention_count
    FROM memory_entity_mentions
    WHERE namespace_id = $1
      AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz)
    GROUP BY entity_id
    `,
    [namespaceId, options?.timeStart ?? null, options?.timeEnd ?? null]
  );

  const mentionCountByEntity = new Map(mentionRows.map((row) => [row.entity_id, Number(row.mention_count)] as const));
  const degreeByEntity = new Map<string, number>();
  const nodes = new Map<string, OpsRelationshipGraphNode>();

  for (const row of rows) {
    degreeByEntity.set(row.subject_entity_id, (degreeByEntity.get(row.subject_entity_id) ?? 0) + 1);
    degreeByEntity.set(row.object_entity_id, (degreeByEntity.get(row.object_entity_id) ?? 0) + 1);
  }

  for (const row of rows) {
    if (!nodes.has(row.subject_entity_id)) {
      nodes.set(row.subject_entity_id, {
        id: row.subject_entity_id,
        name: row.subject_name,
        entityType: row.subject_type,
        degree: degreeByEntity.get(row.subject_entity_id) ?? 0,
        mentionCount: mentionCountByEntity.get(row.subject_entity_id) ?? 0,
        isSelected: Boolean(entityName) && row.subject_name.toLowerCase() === entityName?.toLowerCase()
      });
    }

    if (!nodes.has(row.object_entity_id)) {
      nodes.set(row.object_entity_id, {
        id: row.object_entity_id,
        name: row.object_name,
        entityType: row.object_type,
        degree: degreeByEntity.get(row.object_entity_id) ?? 0,
        mentionCount: mentionCountByEntity.get(row.object_entity_id) ?? 0,
        isSelected: Boolean(entityName) && row.object_name.toLowerCase() === entityName?.toLowerCase()
      });
    }
  }

  const graphNodes = [...nodes.values()].sort((left, right) => {
    const selectedDelta = Number(right.isSelected) - Number(left.isSelected);
    if (selectedDelta !== 0) {
      return selectedDelta;
    }

    const degreeDelta = right.degree - left.degree;
    if (degreeDelta !== 0) {
      return degreeDelta;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    namespaceId,
    selectedEntity: entityName || undefined,
    nodes: graphNodes,
    edges: rows.map((row) => ({
      id: row.relationship_id,
      subjectId: row.subject_entity_id,
      objectId: row.object_entity_id,
      subjectName: row.subject_name,
      objectName: row.object_name,
      predicate: row.predicate,
      confidence: Number(row.confidence ?? 0),
      validFrom: row.valid_from,
      sourceCandidateId: row.source_candidate_id,
      metadata: row.metadata
    }))
  };
}
