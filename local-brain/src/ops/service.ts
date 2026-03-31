import { queryRows } from "../db/client.js";
import { readConfig } from "../config.js";
import { resolveCanonicalEntityReference } from "../identity/service.js";

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
  readonly generated_by: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly source_count: number;
  readonly depth: number | null;
  readonly parent_id: string | null;
  readonly metadata: Record<string, unknown>;
}

interface TemporalContainmentViolationRow {
  readonly parent_id: string;
  readonly parent_layer: string;
  readonly parent_start: string;
  readonly parent_end: string;
  readonly child_id: string;
  readonly child_layer: string;
  readonly child_start: string;
  readonly child_end: string;
}

interface CausalOverlayRow {
  readonly overlay_kind: string;
  readonly source_id: string;
  readonly target_id: string | null;
  readonly occurred_at: string;
  readonly label: string;
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
  readonly status: string | null;
  readonly confidence: number | string | null;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly source_candidate_id: string | null;
  readonly source_memory_id: string | null;
  readonly source_uri: string | null;
  readonly metadata: Record<string, unknown>;
}

interface EntityHierarchyGraphRow {
  readonly child_entity_id: string;
  readonly child_name: string;
  readonly child_type: string;
  readonly parent_entity_id: string;
  readonly parent_name: string;
  readonly parent_type: string;
}

interface FocusEventGraphRow {
  readonly event_id: string;
  readonly event_label: string;
  readonly event_kind: string;
  readonly occurred_at: string;
  readonly entity_id: string;
  readonly entity_name: string;
  readonly entity_type: string;
  readonly member_role: string;
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

interface GraphAmbiguityRow {
  readonly candidate_id: string;
  readonly ambiguity_type: string;
  readonly ambiguity_reason: string | null;
  readonly total_count: string;
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
  readonly generatedBy: string;
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
  readonly containmentAudit: {
    readonly violationCount: number;
    readonly violations: readonly {
      readonly parentId: string;
      readonly parentLayer: string;
      readonly parentStart: string;
      readonly parentEnd: string;
      readonly childId: string;
      readonly childLayer: string;
      readonly childStart: string;
      readonly childEnd: string;
    }[];
  };
  readonly causalOverlays: readonly {
    readonly kind: string;
    readonly sourceId: string;
    readonly targetId?: string | null;
    readonly occurredAt: string;
    readonly label: string;
    readonly metadata: Record<string, unknown>;
  }[];
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
  readonly status?: string | null;
  readonly confidence: number;
  readonly validFrom: string;
  readonly validUntil?: string | null;
  readonly sourceCandidateId?: string | null;
  readonly sourceMemoryId?: string | null;
  readonly sourceUri?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsRelationshipGraph {
  readonly namespaceId: string;
  readonly selectedEntity?: string;
  readonly requestedEntity?: string;
  readonly ambiguityState?: "clear" | "ambiguous" | "unknown";
  readonly ambiguityType?: string | null;
  readonly ambiguityReason?: string | null;
  readonly clarificationCount?: number;
  readonly suggestedMatches?: readonly string[];
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
  readonly ambiguityClass: string;
  readonly ambiguityReason?: string | null;
  readonly suggestedMatches: readonly string[];
  readonly occurredAt: string;
  readonly sceneText?: string | null;
  readonly sourceUri?: string | null;
  readonly priorityScore: number;
  readonly priorityLevel: 1 | 2 | 3;
  readonly priorityLabel: string;
  readonly priorityReasons: readonly string[];
}

export interface OpsClarificationInbox {
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
    readonly byPriority: Record<"priority_1" | "priority_2" | "priority_3", number>;
  };
  readonly items: readonly OpsClarificationInboxItem[];
}

export interface OpsIdentityConflictEntity {
  readonly entityId: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly entityType: string;
  readonly aliases: readonly string[];
  readonly mentionCount: number;
  readonly relationshipCount: number;
  readonly identityProfileId?: string | null;
}

export interface OpsIdentityConflict {
  readonly namespaceId: string;
  readonly crossLane: boolean;
  readonly confidence: number;
  readonly suggestedCanonicalName: string;
  readonly reasons: readonly string[];
  readonly sharedNeighborNames: readonly string[];
  readonly sharedPredicates: readonly string[];
  readonly left: OpsIdentityConflictEntity;
  readonly right: OpsIdentityConflictEntity;
}

export interface OpsAmbiguityWorkbench {
  readonly namespaceId: string;
  readonly inbox: OpsClarificationInbox;
  readonly identityConflicts: readonly OpsIdentityConflict[];
  readonly identityHistory: readonly OpsIdentityConflictHistoryItem[];
}

export interface OpsNamespaceChoice {
  readonly namespaceId: string;
  readonly activityAt: string;
  readonly category: "durable" | "system";
  readonly artifactCount: number;
  readonly relationshipCount: number;
  readonly hasSelfProfile: boolean;
}

export interface OpsNamespaceCatalog {
  readonly defaultNamespaceId?: string;
  readonly namespaces: readonly OpsNamespaceChoice[];
}

interface EntityConflictRow {
  readonly entity_id: string;
  readonly namespace_id: string;
  readonly canonical_name: string;
  readonly entity_type: string;
  readonly aliases: readonly string[] | null;
  readonly mention_count: string;
  readonly relationship_count: string;
  readonly identity_profile_id: string | null;
}

interface EntityNeighborRow {
  readonly entity_id: string;
  readonly neighbor_name: string;
  readonly neighbor_label: string;
  readonly predicate: string;
}

interface IdentityConflictDecisionRow {
  readonly entity_a_id: string;
  readonly entity_b_id: string;
}

interface IdentityConflictHistoryRow {
  readonly decision_id: string;
  readonly decision: "merge" | "keep_separate";
  readonly canonical_name: string | null;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly left_entity_id: string;
  readonly left_namespace_id: string;
  readonly left_name: string;
  readonly left_entity_type: string;
  readonly right_entity_id: string;
  readonly right_namespace_id: string;
  readonly right_name: string;
  readonly right_entity_type: string;
}

export interface OpsIdentityConflictHistoryItem {
  readonly decisionId: string;
  readonly decision: "merge" | "keep_separate";
  readonly canonicalName?: string | null;
  readonly note?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly left: {
    readonly entityId: string;
    readonly namespaceId: string;
    readonly name: string;
    readonly entityType: string;
  };
  readonly right: {
    readonly entityId: string;
    readonly namespaceId: string;
    readonly name: string;
    readonly entityType: string;
  };
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

function normalizeEntityLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function phoneticKey(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z]/gu, "");
  if (!normalized) {
    return "";
  }

  const first = normalized[0] ?? "";
  const tail = normalized
    .slice(1)
    .replace(/[aeiouyhw]/g, "")
    .replace(/(.)\1+/g, "$1");

  return `${first}${tail}`;
}

function bigrams(value: string): string[] {
  const normalized = ` ${normalizeEntityLabel(value)} `;
  const grams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.push(normalized.slice(index, index + 2));
  }
  return grams;
}

function diceSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const gram of a) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const gram of b) {
    const current = counts.get(gram) ?? 0;
    if (current > 0) {
      overlap += 1;
      counts.set(gram, current - 1);
    }
  }

  return (2 * overlap) / (a.length + b.length);
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function canonicalChoice(left: string, right: string): string {
  if (left.length !== right.length) {
    return left.length >= right.length ? left : right;
  }
  return left.localeCompare(right) <= 0 ? left : right;
}

function isLowSignalAtlasEntity(name: string, entityType: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (["and", "of", "you", "where", "when", "what", "we", "they", "so"].includes(normalized)) {
    return true;
  }

  if (entityType === "project" && /^(right now is|and\b|of\b|where\b)/iu.test(normalized)) {
    return true;
  }

  return false;
}

function lexicalConflictScore(leftNames: readonly string[], rightNames: readonly string[]): {
  readonly score: number;
  readonly reasons: string[];
} {
  let bestScore = 0;
  let matchedPhonetic = false;

  for (const left of leftNames) {
    for (const right of rightNames) {
      const dice = diceSimilarity(left, right);
      const leftKey = phoneticKey(left);
      const rightKey = phoneticKey(right);
      const phoneticMatch = Boolean(leftKey) && leftKey === rightKey;
      const score = Math.max(dice, phoneticMatch ? 0.88 : 0);
      bestScore = Math.max(bestScore, score);
      matchedPhonetic = matchedPhonetic || phoneticMatch;
    }
  }

  const reasons: string[] = [];
  if (matchedPhonetic) {
    reasons.push("phonetic collision");
  }
  if (bestScore >= 0.92) {
    reasons.push("strong lexical overlap");
  } else if (bestScore >= 0.8) {
    reasons.push("close lexical overlap");
  }

  return {
    score: bestScore,
    reasons
  };
}

function namespaceCategory(namespaceId: string): "durable" | "system" {
  return /^(eval_|benchmark_|narrative_)/.test(namespaceId) ? "system" : "durable";
}

function namespaceLanePriority(namespaceId: string): number {
  if (namespaceId === "personal") {
    return 0;
  }

  if (/(^|[_:-])(personal|friends?|home|life|shared)([_:-]|$)/i.test(namespaceId)) {
    return 1;
  }

  if (/(^|[_:-])(project|work|client)([_:-]|$)/i.test(namespaceId)) {
    return 3;
  }

  return 2;
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

export async function getOpsNamespaceCatalog(limit = 16): Promise<OpsNamespaceCatalog> {
  const rows = await queryRows<{
    readonly namespace_id: string;
    readonly activity_at: string;
    readonly artifact_count: string;
    readonly relationship_count: string;
    readonly has_self_profile: boolean;
  }>(
    `
      WITH namespace_activity AS (
        SELECT namespace_id, max(activity_at) AS activity_at
        FROM (
          SELECT namespace_id, max(last_seen_at) AS activity_at
          FROM artifacts
          GROUP BY namespace_id

          UNION ALL

          SELECT namespace_id, max(created_at) AS activity_at
          FROM claim_candidates
          GROUP BY namespace_id

          UNION ALL

          SELECT namespace_id, max(created_at) AS activity_at
          FROM relationship_candidates
          GROUP BY namespace_id

          UNION ALL

          SELECT namespace_id, max(valid_from) AS activity_at
          FROM relationship_memory
          GROUP BY namespace_id

          UNION ALL

          SELECT namespace_id, max(updated_at) AS activity_at
          FROM procedural_memory
          GROUP BY namespace_id

          UNION ALL

          SELECT namespace_id, max(valid_from) AS activity_at
          FROM semantic_memory
          GROUP BY namespace_id
        ) activity_sources
        GROUP BY namespace_id
      ),
      artifact_counts AS (
        SELECT namespace_id, COUNT(*)::text AS artifact_count
        FROM artifacts
        GROUP BY namespace_id
      ),
      relationship_counts AS (
        SELECT namespace_id, COUNT(*)::text AS relationship_count
        FROM relationship_memory
        WHERE status = 'active'
          AND valid_until IS NULL
        GROUP BY namespace_id
      )
      SELECT
        na.namespace_id,
        na.activity_at::text,
        COALESCE(ac.artifact_count, '0') AS artifact_count,
        COALESCE(rc.relationship_count, '0') AS relationship_count,
        EXISTS (
          SELECT 1
          FROM namespace_self_bindings nsb
          WHERE nsb.namespace_id = na.namespace_id
        ) AS has_self_profile
      FROM namespace_activity na
      LEFT JOIN artifact_counts ac ON ac.namespace_id = na.namespace_id
      LEFT JOIN relationship_counts rc ON rc.namespace_id = na.namespace_id
      ORDER BY
        CASE WHEN na.namespace_id ~ '^(eval_|benchmark_|narrative_)' THEN 1 ELSE 0 END ASC,
        CASE
          WHEN na.namespace_id = 'personal' THEN 0
          WHEN na.namespace_id ~* '(^|[_:-])(personal|friends?|home|life|shared)([_:-]|$)' THEN 1
          WHEN na.namespace_id ~* '(^|[_:-])(project|work|client)([_:-]|$)' THEN 3
          ELSE 2
        END ASC,
        EXISTS (
          SELECT 1
          FROM namespace_self_bindings nsb
          WHERE nsb.namespace_id = na.namespace_id
        ) DESC,
        na.activity_at DESC,
        na.namespace_id ASC
      LIMIT $1
    `,
    [limit]
  );

  const namespaces = rows.map((row) => ({
    namespaceId: row.namespace_id,
    activityAt: row.activity_at,
    category: namespaceCategory(row.namespace_id),
    artifactCount: Number(row.artifact_count),
    relationshipCount: Number(row.relationship_count),
    hasSelfProfile: row.has_self_profile
  }));

  const defaultNamespaceId =
    namespaces.find((item) => item.category === "durable" && namespaceLanePriority(item.namespaceId) <= 1)?.namespaceId ??
    namespaces.find((item) => item.category === "durable" && item.hasSelfProfile)?.namespaceId ??
    namespaces.find((item) => item.category === "durable")?.namespaceId ??
    namespaces[0]?.namespaceId;

  return {
    defaultNamespaceId,
    namespaces
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

function classifyClarificationClass(
  ambiguityType: string | null,
  targetRole: "subject" | "object",
  rawText: string,
  metadata: Record<string, unknown>
): string {
  switch (ambiguityType) {
    case "kinship_resolution":
    case "undefined_kinship":
      return "kinship_person";
    case "place_grounding":
    case "vague_place":
      return "vague_place";
    case "alias_collision":
    case "possible_misspelling":
    case "asr_correction":
      return "alias_collision";
    case "unknown_reference": {
      const normalized = rawText.trim().toLowerCase().replace(/^the\s+/u, "");
      const sourceKind = typeof metadata.source_kind === "string" ? metadata.source_kind : "";
      if (targetRole === "subject" && (["doctor", "therapist", "trainer", "teacher"].includes(normalized) || sourceKind.includes("speaker"))) {
        return "speaker_subject_conflict";
      }
      return "nickname_person";
    }
    default:
      return "alias_collision";
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function clarificationTypeWeight(ambiguityType: string | null): number {
  switch (ambiguityType) {
    case "kinship_resolution":
      return 0.24;
    case "place_grounding":
    case "vague_place":
      return 0.2;
    case "possible_misspelling":
    case "alias_collision":
      return 0.14;
    case "organization_match":
      return 0.08;
    default:
      return 0.04;
  }
}

function clarificationPriority(input: {
  readonly ambiguityType: string | null;
  readonly priorScore: number | null;
  readonly confidence: number | null;
  readonly occurredAt: string;
}): {
  readonly score: number;
  readonly level: 1 | 2 | 3;
  readonly label: string;
  readonly reasons: readonly string[];
} {
  const prior = clamp01(input.priorScore ?? 0);
  const confidence = clamp01(input.confidence ?? 0);
  const typeWeight = clarificationTypeWeight(input.ambiguityType);
  const occurredMs = Date.parse(input.occurredAt);
  const ageDays = Number.isFinite(occurredMs) ? Math.max(0, (Date.now() - occurredMs) / 86_400_000) : Number.POSITIVE_INFINITY;
  const recencyWeight = ageDays <= 7 ? 0.08 : ageDays <= 30 ? 0.04 : ageDays <= 120 ? 0.02 : 0;
  const score = clamp01(prior * 0.58 + confidence * 0.18 + typeWeight + recencyWeight);
  const reasons: string[] = [];

  if (input.ambiguityType === "kinship_resolution") {
    reasons.push("kinship ambiguity can distort identity grounding");
  } else if (input.ambiguityType === "place_grounding" || input.ambiguityType === "vague_place") {
    reasons.push("place ambiguity can poison recall and timeline grounding");
  } else if (input.ambiguityType === "possible_misspelling" || input.ambiguityType === "alias_collision") {
    reasons.push("name ambiguity can fragment entities and relationships");
  }

  if (prior >= 0.8) {
    reasons.push("high prior score from the extraction pipeline");
  } else if (prior >= 0.55) {
    reasons.push("moderate prior score suggests this will surface again");
  }

  if (confidence >= 0.7) {
    reasons.push("the candidate is strong enough to resolve instead of ignore");
  }

  if (recencyWeight >= 0.08) {
    reasons.push("recent evidence means this ambiguity is still active");
  }

  if (score >= 0.8) {
    return {
      score,
      level: 1,
      label: "Priority 1",
      reasons
    };
  }
  if (score >= 0.58) {
    return {
      score,
      level: 2,
      label: "Priority 2",
      reasons
    };
  }
  return {
    score,
    level: 3,
    label: "Priority 3",
    reasons
  };
}

export async function getOpsClarificationInbox(namespaceId: string, limit = 40): Promise<OpsClarificationInbox> {
  const itemRows = await queryRows<ClarificationInboxItemRow>(
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
  );

  const items = itemRows.map((row) => {
    const priority = clarificationPriority({
      ambiguityType: row.ambiguity_type,
      priorScore: row.prior_score,
      confidence: row.confidence,
      occurredAt: row.occurred_at
    });

    const targetRole: "subject" | "object" =
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
      ambiguityClass: classifyClarificationClass(row.ambiguity_type, targetRole, rawText, row.metadata),
      ambiguityReason: row.ambiguity_reason,
      suggestedMatches:
        row.ambiguity_type === "possible_misspelling" || row.ambiguity_type === "alias_collision"
          ? parseSuggestedMatches(row.metadata)
          : [],
      occurredAt: row.occurred_at,
      sceneText: row.scene_text,
      sourceUri: row.source_uri,
      priorityScore: priority.score,
      priorityLevel: priority.level,
      priorityLabel: priority.label,
      priorityReasons: priority.reasons
    };
  });

  const filteredItems = (
    await Promise.all(
      items.map(async (item) => {
        if (!shouldSuppressClarificationItem(item)) {
          return item;
        }
        const resolved = await resolveCanonicalEntityReference(namespaceId, item.rawText, {
          entityTypes: ["person", "place", "project", "concept", "unknown"]
        });
        return resolved ? null : item;
      })
    )
  ).filter((item): item is (typeof items)[number] => item !== null);

  const byType: Record<string, number> = {};
  const byPriority: Record<"priority_1" | "priority_2" | "priority_3", number> = {
    priority_1: 0,
    priority_2: 0,
    priority_3: 0
  };
  for (const item of filteredItems) {
    byType[item.ambiguityType ?? "unknown"] = (byType[item.ambiguityType ?? "unknown"] ?? 0) + 1;
    byPriority[`priority_${item.priorityLevel}`] += 1;
  }

  return {
    namespaceId,
    summary: {
      total: filteredItems.length,
      byType,
      byPriority
    },
    items: filteredItems
  };
}

function shouldSuppressClarificationItem(item: OpsClarificationInbox["items"][number]): boolean {
  const raw = item.rawText.trim().toLowerCase().replace(/^the\s+/u, "");
  if (!raw) {
    return false;
  }

  if (item.ambiguityType === "kinship_resolution") {
    return ["uncle", "aunt", "mom", "mother", "dad", "father", "brother", "sister", "cousin"].includes(raw);
  }

  return false;
}

export async function getOpsIdentityConflicts(namespaceId: string, limit = 20): Promise<readonly OpsIdentityConflict[]> {
  const namespaceCatalog = await getOpsNamespaceCatalog(64);
  const scopedNamespaceIds = namespaceCatalog.namespaces
    .filter((item) => item.category === "durable")
    .map((item) => item.namespaceId);
  if (!scopedNamespaceIds.includes(namespaceId)) {
    scopedNamespaceIds.unshift(namespaceId);
  }

  const [entityRows, neighborRows, decisionRows] = await Promise.all([
    queryRows<EntityConflictRow>(
      `
      WITH mention_counts AS (
        SELECT namespace_id, entity_id, COUNT(*)::text AS mention_count
        FROM memory_entity_mentions
        WHERE namespace_id = ANY($1::text[])
        GROUP BY namespace_id, entity_id
      ),
      relationship_counts AS (
        SELECT namespace_id, entity_id, COUNT(*)::text AS relationship_count
        FROM (
          SELECT namespace_id, subject_entity_id AS entity_id
          FROM relationship_memory
          WHERE namespace_id = ANY($1::text[])
            AND status = 'active'
            AND valid_until IS NULL
          UNION ALL
          SELECT namespace_id, object_entity_id AS entity_id
          FROM relationship_memory
          WHERE namespace_id = ANY($1::text[])
            AND status = 'active'
            AND valid_until IS NULL
        ) edges
        GROUP BY namespace_id, entity_id
      )
      SELECT
        e.id::text AS entity_id,
        e.namespace_id,
        e.canonical_name,
        e.entity_type,
        COALESCE(array_agg(DISTINCT ea.alias) FILTER (WHERE ea.alias IS NOT NULL), ARRAY[]::text[]) AS aliases,
        COALESCE(mc.mention_count, '0') AS mention_count,
        COALESCE(rc.relationship_count, '0') AS relationship_count,
        e.identity_profile_id::text
      FROM entities e
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      LEFT JOIN mention_counts mc ON mc.entity_id = e.id AND mc.namespace_id = e.namespace_id
      LEFT JOIN relationship_counts rc ON rc.entity_id = e.id AND rc.namespace_id = e.namespace_id
      WHERE e.namespace_id = ANY($1::text[])
        AND e.merged_into_entity_id IS NULL
        AND e.entity_type IN ('person', 'place', 'org', 'project')
      GROUP BY e.id, e.canonical_name, e.entity_type, mc.mention_count, rc.relationship_count
      ORDER BY e.namespace_id, e.entity_type, e.canonical_name
      `
      ,
      [scopedNamespaceIds]
    ),
    queryRows<EntityNeighborRow>(
      `
      SELECT
        rel.entity_id::text AS entity_id,
        rel.neighbor_name,
        rel.neighbor_label,
        rel.predicate
      FROM (
        SELECT
          rm.subject_entity_id AS entity_id,
          object_entity.canonical_name AS neighbor_name,
          object_entity.normalized_name AS neighbor_label,
          rm.predicate
        FROM relationship_memory rm
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        WHERE rm.namespace_id = ANY($1::text[])
          AND rm.status = 'active'
          AND rm.valid_until IS NULL
        UNION ALL
        SELECT
          rm.object_entity_id AS entity_id,
          subject.canonical_name AS neighbor_name,
          subject.normalized_name AS neighbor_label,
          rm.predicate
        FROM relationship_memory rm
        JOIN entities subject ON subject.id = rm.subject_entity_id
        WHERE rm.namespace_id = ANY($1::text[])
          AND rm.status = 'active'
          AND rm.valid_until IS NULL
      ) rel
      `
      ,
      [scopedNamespaceIds]
    ),
    queryRows<IdentityConflictDecisionRow>(
      `
      SELECT entity_a_id::text, entity_b_id::text
      FROM identity_conflict_decisions
      `
    )
  ]);

  const ignoredPairs = new Set(decisionRows.map((row) => `${row.entity_a_id}:${row.entity_b_id}`));

  const entityMap = new Map(
    entityRows.map((row) => [
      row.entity_id,
      {
        entityId: row.entity_id,
        namespaceId: row.namespace_id,
        name: row.canonical_name,
        entityType: row.entity_type,
        aliases: uniqueNormalized([row.canonical_name, ...(row.aliases ?? [])]),
        mentionCount: Number(row.mention_count),
        relationshipCount: Number(row.relationship_count),
        identityProfileId: row.identity_profile_id
      } satisfies OpsIdentityConflictEntity
    ] as const)
  );

  const focusEntities = [...entityMap.values()].filter((entity) => entity.namespaceId === namespaceId);
  const otherEntities = [...entityMap.values()];

  const neighborMap = new Map<string, Map<string, string>>();
  const predicateMap = new Map<string, Set<string>>();

  for (const row of neighborRows) {
    if (!neighborMap.has(row.entity_id)) {
      neighborMap.set(row.entity_id, new Map<string, string>());
    }
    if (!predicateMap.has(row.entity_id)) {
      predicateMap.set(row.entity_id, new Set<string>());
    }

    neighborMap.get(row.entity_id)?.set(normalizeEntityLabel(row.neighbor_name), row.neighbor_name);
    predicateMap.get(row.entity_id)?.add(row.predicate);
  }

  const results: OpsIdentityConflict[] = [];
  const seenPairs = new Set<string>();

  for (const left of focusEntities) {
    for (const right of otherEntities) {
      if (!left || !right || left.entityId === right.entityId || left.entityType !== right.entityType) {
        continue;
      }

      const orderedPair = left.entityId.localeCompare(right.entityId) <= 0 ? `${left.entityId}:${right.entityId}` : `${right.entityId}:${left.entityId}`;
      if (seenPairs.has(orderedPair) || ignoredPairs.has(orderedPair)) {
        continue;
      }
      seenPairs.add(orderedPair);

      if (left.identityProfileId && right.identityProfileId && left.identityProfileId === right.identityProfileId) {
        continue;
      }

      const lexical = lexicalConflictScore(left.aliases, right.aliases);
      const leftNeighbors = neighborMap.get(left.entityId) ?? new Map<string, string>();
      const rightNeighbors = neighborMap.get(right.entityId) ?? new Map<string, string>();
      const leftPredicates = predicateMap.get(left.entityId) ?? new Set<string>();
      const rightPredicates = predicateMap.get(right.entityId) ?? new Set<string>();
      const sharedNeighborLabels = [...leftNeighbors.keys()].filter((label) => rightNeighbors.has(label)).sort();
      const sharedNeighborNames = sharedNeighborLabels
        .map((label) => leftNeighbors.get(label) ?? rightNeighbors.get(label) ?? label)
        .sort();
      const sharedPredicates = [...leftPredicates].filter((predicate) => rightPredicates.has(predicate)).sort();

      const neighborScore =
        sharedNeighborNames.length === 0
          ? 0
          : Math.min(0.4, sharedNeighborNames.length * 0.16 + (sharedPredicates.length > 0 ? 0.08 : 0));

      const profileHintScore = left.identityProfileId || right.identityProfileId ? 0.1 : 0;
      const confidence = Math.min(0.99, lexical.score * 0.68 + neighborScore + profileHintScore);
      const enoughSignal =
        lexical.score >= 0.84 ||
        (lexical.score >= 0.72 && sharedNeighborNames.length > 0) ||
        (lexical.score >= 0.6 && sharedNeighborNames.length >= 2);

      if (!enoughSignal || confidence < 0.72) {
        continue;
      }

      const reasons = [
        ...lexical.reasons,
        ...(sharedNeighborNames.length > 0 ? [`shared neighbors: ${sharedNeighborNames.slice(0, 3).join(", ")}`] : []),
        ...(sharedPredicates.length > 0 ? [`shared predicates: ${sharedPredicates.slice(0, 3).join(", ")}`] : []),
        ...(left.namespaceId !== right.namespaceId ? ["cross-lane match candidate"] : [])
      ];

      results.push({
        namespaceId,
        crossLane: left.namespaceId !== right.namespaceId,
        confidence,
        suggestedCanonicalName: canonicalChoice(left.name, right.name),
        reasons,
        sharedNeighborNames,
        sharedPredicates,
        left,
        right
      });
    }
  }

  return results
    .sort((left, right) => {
      const crossLaneDelta = Number(right.crossLane) - Number(left.crossLane);
      if (crossLaneDelta !== 0) {
        return crossLaneDelta;
      }
      return right.confidence - left.confidence || left.suggestedCanonicalName.localeCompare(right.suggestedCanonicalName);
    })
    .slice(0, limit);
}

export async function getOpsIdentityConflictHistory(namespaceId: string, limit = 20): Promise<readonly OpsIdentityConflictHistoryItem[]> {
  const rows = await queryRows<IdentityConflictHistoryRow>(
    `
      SELECT
        icd.id::text AS decision_id,
        icd.decision,
        icd.canonical_name,
        icd.note,
        icd.created_at::text,
        icd.updated_at::text,
        left_entity.id::text AS left_entity_id,
        left_entity.namespace_id AS left_namespace_id,
        left_entity.canonical_name AS left_name,
        left_entity.entity_type AS left_entity_type,
        right_entity.id::text AS right_entity_id,
        right_entity.namespace_id AS right_namespace_id,
        right_entity.canonical_name AS right_name,
        right_entity.entity_type AS right_entity_type
      FROM identity_conflict_decisions icd
      JOIN entities left_entity ON left_entity.id = icd.entity_a_id
      JOIN entities right_entity ON right_entity.id = icd.entity_b_id
      WHERE left_entity.namespace_id = $1
         OR right_entity.namespace_id = $1
      ORDER BY icd.updated_at DESC, icd.created_at DESC
      LIMIT $2
    `,
    [namespaceId, limit]
  );

  return rows.map((row) => ({
    decisionId: row.decision_id,
    decision: row.decision,
    canonicalName: row.canonical_name,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    left: {
      entityId: row.left_entity_id,
      namespaceId: row.left_namespace_id,
      name: row.left_name,
      entityType: row.left_entity_type
    },
    right: {
      entityId: row.right_entity_id,
      namespaceId: row.right_namespace_id,
      name: row.right_name,
      entityType: row.right_entity_type
    }
  }));
}

export async function getOpsAmbiguityWorkbench(namespaceId: string, limit = 40): Promise<OpsAmbiguityWorkbench> {
  const [inbox, identityConflicts, identityHistory] = await Promise.all([
    getOpsClarificationInbox(namespaceId, limit),
    getOpsIdentityConflicts(namespaceId, Math.max(10, Math.ceil(limit / 2))),
    getOpsIdentityConflictHistory(namespaceId, Math.max(10, Math.ceil(limit / 2)))
  ]);

  return {
    namespaceId,
    inbox,
    identityConflicts,
    identityHistory
  };
}

export async function getOpsTimelineView(
  namespaceId: string,
  timeStart: string,
  timeEnd: string,
  limit = 40
): Promise<OpsTimelineView> {
  const [timelineRows, summaryRows, containmentRows, causalRows] = await Promise.all([
    queryRows<TimelineRow>(
      `
      SELECT
        em.id AS memory_id,
        em.content,
        em.occurred_at::text,
        em.artifact_id,
        a.uri AS source_uri,
        em.metadata
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.occurred_at >= $2::timestamptz
        AND em.occurred_at <= $3::timestamptz
      ORDER BY em.occurred_at ASC
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
          tn.generated_by,
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
    ),
    queryRows<TemporalContainmentViolationRow>(
      `
      SELECT
        parent.id::text AS parent_id,
        parent.layer AS parent_layer,
        parent.period_start::text AS parent_start,
        parent.period_end::text AS parent_end,
        child.id::text AS child_id,
        child.layer AS child_layer,
        child.period_start::text AS child_start,
        child.period_end::text AS child_end
      FROM temporal_nodes child
      JOIN temporal_nodes parent ON parent.id = child.parent_id
      WHERE child.namespace_id = $1
        AND parent.namespace_id = $1
        AND child.period_end >= $2::timestamptz
        AND child.period_start <= $3::timestamptz
        AND (
          parent.period_start > child.period_start
          OR parent.period_end < child.period_end
        )
      ORDER BY child.period_start ASC, child.id ASC
      LIMIT 25
      `,
      [namespaceId, timeStart, timeEnd]
    ),
    queryRows<CausalOverlayRow>(
      `
      SELECT *
      FROM (
        SELECT
          'procedural_supersession'::text AS overlay_kind,
          previous_state.id::text AS source_id,
          next_state.id::text AS target_id,
          COALESCE(previous_state.valid_until, next_state.valid_from, previous_state.updated_at)::text AS occurred_at,
          CONCAT(previous_state.state_type, ': ', previous_state.state_key) AS label,
          jsonb_build_object(
            'state_type', previous_state.state_type,
            'state_key', previous_state.state_key,
            'previous', previous_state.state_value,
            'next', next_state.state_value
          ) AS metadata
        FROM procedural_memory previous_state
        LEFT JOIN procedural_memory next_state
          ON next_state.supersedes_id = previous_state.id
        WHERE previous_state.namespace_id = $1
          AND previous_state.valid_until IS NOT NULL
          AND COALESCE(previous_state.valid_until, previous_state.updated_at) >= $2::timestamptz
          AND COALESCE(previous_state.valid_until, previous_state.updated_at) <= $3::timestamptz

        UNION ALL

        SELECT
          'semantic_supersession'::text AS overlay_kind,
          previous_memory.id::text AS source_id,
          previous_memory.superseded_by_id::text AS target_id,
          COALESCE(previous_memory.valid_until, previous_memory.valid_from)::text AS occurred_at,
          CONCAT(previous_memory.memory_kind, ': ', COALESCE(previous_memory.canonical_key, previous_memory.content_abstract)) AS label,
          jsonb_build_object(
            'memory_kind', previous_memory.memory_kind,
            'canonical_key', previous_memory.canonical_key,
            'normalized_value', previous_memory.normalized_value
          ) AS metadata
        FROM semantic_memory previous_memory
        WHERE previous_memory.namespace_id = $1
          AND previous_memory.valid_until IS NOT NULL
          AND previous_memory.status = 'superseded'
          AND COALESCE(previous_memory.valid_until, previous_memory.valid_from) >= $2::timestamptz
          AND COALESCE(previous_memory.valid_until, previous_memory.valid_from) <= $3::timestamptz

        UNION ALL

        SELECT
          'relationship_supersession'::text AS overlay_kind,
          previous_rel.id::text AS source_id,
          previous_rel.superseded_by_id::text AS target_id,
          COALESCE(previous_rel.valid_until, previous_rel.valid_from)::text AS occurred_at,
          CONCAT(subject_entity.canonical_name, ' ', previous_rel.predicate, ' ', object_entity.canonical_name) AS label,
          jsonb_build_object(
            'predicate', previous_rel.predicate,
            'subject', subject_entity.canonical_name,
            'object', object_entity.canonical_name,
            'metadata', previous_rel.metadata
          ) AS metadata
        FROM relationship_memory previous_rel
        JOIN entities subject_entity ON subject_entity.id = previous_rel.subject_entity_id
        JOIN entities object_entity ON object_entity.id = previous_rel.object_entity_id
        WHERE previous_rel.namespace_id = $1
          AND previous_rel.valid_until IS NOT NULL
          AND COALESCE(previous_rel.valid_until, previous_rel.valid_from) >= $2::timestamptz
          AND COALESCE(previous_rel.valid_until, previous_rel.valid_from) <= $3::timestamptz
      ) overlays
      ORDER BY occurred_at DESC, overlay_kind ASC
      LIMIT 24
      `,
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
      generatedBy: row.generated_by,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      sourceCount: row.source_count,
      depth: row.depth,
      parentId: row.parent_id,
      metadata: row.metadata
    })),
    containmentAudit: {
      violationCount: containmentRows.length,
      violations: containmentRows.map((row) => ({
        parentId: row.parent_id,
        parentLayer: row.parent_layer,
        parentStart: row.parent_start,
        parentEnd: row.parent_end,
        childId: row.child_id,
        childLayer: row.child_layer,
        childStart: row.child_start,
        childEnd: row.child_end
      }))
    },
    causalOverlays: causalRows.map((row) => ({
      kind: row.overlay_kind,
      sourceId: row.source_id,
      targetId: row.target_id,
      occurredAt: row.occurred_at,
      label: row.label,
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
  const resolvedEntity = entityName
    ? await resolveCanonicalEntityReference(namespaceId, entityName, {
        entityTypes: ["self", "person", "place", "project", "concept", "unknown"]
      })
    : null;
  const graphAmbiguity =
    entityName && !resolvedEntity
      ? (
          await queryRows<GraphAmbiguityRow>(
            `
              SELECT
                candidate_id,
                ambiguity_type,
                ambiguity_reason,
                total_count,
                metadata
              FROM (
                SELECT
                  cc.id::text AS candidate_id,
                  cc.ambiguity_type,
                  cc.ambiguity_reason,
                  cc.metadata,
                  row_number() OVER (
                    ORDER BY cc.prior_score DESC, cc.occurred_at DESC, cc.created_at DESC
                  ) AS rank_order,
                  count(*) OVER ()::text AS total_count
                FROM claim_candidates cc
                WHERE cc.namespace_id = $1
                  AND cc.ambiguity_state = 'requires_clarification'
                  AND (
                    lower(coalesce(cc.subject_text, '')) = lower($2)
                    OR lower(coalesce(cc.object_text, '')) = lower($2)
                    OR lower(coalesce(cc.metadata->>'raw_ambiguous_text', '')) = lower($2)
                  )
              ) ranked
              WHERE rank_order = 1
            `,
            [namespaceId, entityName]
          )
        )[0] ?? null
      : null;
  const limit = options?.limit ?? 36;
  const selectedEntityId = resolvedEntity?.entityId ?? null;
  const graphLimit = selectedEntityId ? Math.max(limit * 4, 96) : limit;
  const rows = await queryRows<RelationshipGraphRow>(
    `
    SELECT
      rel.relationship_id,
      rel.subject_entity_id::text,
      subject.canonical_name AS subject_name,
      subject.entity_type AS subject_type,
      rel.object_entity_id::text,
      object_entity.canonical_name AS object_name,
      object_entity.entity_type AS object_type,
      rel.predicate,
      rel.confidence,
      rel.valid_from::text,
      rel.valid_until::text,
      rel.source_candidate_id::text,
      rel.source_memory_id::text,
      rel.source_uri,
      rel.metadata
    FROM (
      SELECT
        rm.id AS relationship_id,
        rm.subject_entity_id,
        rm.predicate,
        rm.object_entity_id,
        rm.status,
        rm.confidence,
        rm.valid_from,
        rm.valid_until,
        rm.source_candidate_id,
        rc.source_memory_id,
        a.uri AS source_uri,
        rm.metadata || jsonb_build_object('tier', 'relationship_memory') AS metadata
      FROM relationship_memory rm
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory em ON em.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE rm.namespace_id = $1
        AND (
          ($7::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          OR ($7::boolean = true AND rm.status <> 'invalid')
        )

      UNION ALL

      SELECT
        rc.id AS relationship_id,
        rc.subject_entity_id,
        rc.predicate,
        rc.object_entity_id,
        rc.status,
        rc.confidence,
        COALESCE(rc.valid_from, em.occurred_at, rc.created_at) AS valid_from,
        rc.valid_until,
        rc.id AS source_candidate_id,
        rc.source_memory_id,
        a.uri AS source_uri,
        rc.metadata || jsonb_build_object('tier', 'relationship_candidate') AS metadata
      FROM relationship_candidates rc
      LEFT JOIN episodic_memory em ON em.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE rc.namespace_id = $1
        AND rc.status = 'accepted'
    ) rel
    JOIN entities subject ON subject.id = rel.subject_entity_id
    JOIN entities object_entity ON object_entity.id = rel.object_entity_id
    WHERE subject.merged_into_entity_id IS NULL
      AND object_entity.merged_into_entity_id IS NULL
      AND ($2::timestamptz IS NULL OR coalesce(rel.valid_until, rel.valid_from) >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR rel.valid_from <= $3::timestamptz)
      AND (
        $5::text IS NULL
        OR lower(subject.canonical_name) = lower($5::text)
        OR lower(object_entity.canonical_name) = lower($5::text)
        OR rel.subject_entity_id = $4::uuid
        OR rel.object_entity_id = $4::uuid
      )
    ORDER BY
      CASE
        WHEN $4::uuid IS NOT NULL AND (rel.subject_entity_id = $4::uuid OR rel.object_entity_id = $4::uuid) THEN 0
        ELSE 1
      END,
      CASE WHEN rel.valid_until IS NULL THEN 0 ELSE 1 END,
      coalesce(rel.valid_until, rel.valid_from) DESC,
      rel.confidence DESC
      LIMIT $6
    `,
    [
      namespaceId,
      options?.timeStart ?? null,
      options?.timeEnd ?? null,
      selectedEntityId,
      entityName ?? null,
      graphLimit,
      Boolean(selectedEntityId || options?.timeStart || options?.timeEnd)
    ]
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
  const edges: OpsRelationshipGraphEdge[] = [];
  const edgeKeys = new Set<string>();

  const filteredRows = rows.filter((row) => {
    const noisySubject = isLowSignalAtlasEntity(row.subject_name, row.subject_type) && row.subject_entity_id !== selectedEntityId;
    const noisyObject = isLowSignalAtlasEntity(row.object_name, row.object_type) && row.object_entity_id !== selectedEntityId;
    return !noisySubject && !noisyObject;
  });

  for (const row of filteredRows) {
    degreeByEntity.set(row.subject_entity_id, (degreeByEntity.get(row.subject_entity_id) ?? 0) + 1);
    degreeByEntity.set(row.object_entity_id, (degreeByEntity.get(row.object_entity_id) ?? 0) + 1);
  }

  for (const row of filteredRows) {
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

  for (const row of filteredRows) {
    const edgeId = row.relationship_id;
    if (edgeKeys.has(edgeId)) {
      continue;
    }
    edgeKeys.add(edgeId);
    edges.push({
      id: edgeId,
      subjectId: row.subject_entity_id,
      objectId: row.object_entity_id,
      subjectName: row.subject_name,
      objectName: row.object_name,
      predicate: row.predicate,
      status: row.status,
      confidence: Number(row.confidence ?? 0),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      sourceCandidateId: row.source_candidate_id,
      sourceMemoryId: row.source_memory_id,
      sourceUri: row.source_uri,
      metadata: row.metadata
    });
  }

  if (entityName && selectedEntityId) {
    const entityLabelToken = entityName.trim().split(/\s+/u)[0] ?? entityName.trim();
    if (!nodes.has(selectedEntityId)) {
      const selectedRows = await queryRows<{ readonly entity_id: string; readonly name: string; readonly entity_type: string }>(
        `
          SELECT
            id::text AS entity_id,
            canonical_name AS name,
            entity_type
          FROM entities
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [selectedEntityId]
      );
      const selected = selectedRows[0];
      if (selected) {
        nodes.set(selectedEntityId, {
          id: selected.entity_id,
          name: selected.name,
          entityType: selected.entity_type,
          degree: degreeByEntity.get(selected.entity_id) ?? 0,
          mentionCount: mentionCountByEntity.get(selected.entity_id) ?? 0,
          isSelected: true
        });
      }
    } else {
      const selectedNode = nodes.get(selectedEntityId);
      if (selectedNode && !selectedNode.isSelected) {
        nodes.set(selectedEntityId, {
          ...selectedNode,
          isSelected: true
        });
      }
    }

    const focusEventRows = await queryRows<FocusEventGraphRow>(
      `
        WITH chosen_events AS (
          SELECT
            ne.id::text AS event_id,
            ne.event_label,
            ne.event_kind,
            COALESCE(ne.time_start, ns.occurred_at, ne.created_at)::text AS occurred_at
          FROM narrative_events ne
          LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
          WHERE ne.namespace_id = $1
            AND (
              ne.primary_subject_entity_id = $2::uuid
              OR EXISTS (
                SELECT 1
                FROM narrative_event_members selected_member
                WHERE selected_member.event_id = ne.id
                  AND selected_member.entity_id = $2::uuid
              )
              OR (
                lower(coalesce(ns.scene_text, '')) LIKE '%' || lower($5) || '%'
                OR lower(coalesce(ne.event_label, '')) LIKE '%' || lower($5) || '%'
                OR lower(coalesce(ns.scene_text, '')) LIKE '%' || lower($6) || '%'
                OR lower(coalesce(ne.event_label, '')) LIKE '%' || lower($6) || '%'
              )
            )
            AND ($3::timestamptz IS NULL OR COALESCE(ne.time_start, ns.occurred_at, ne.created_at) >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR COALESCE(ne.time_start, ns.occurred_at, ne.created_at) <= $4::timestamptz)
          ORDER BY COALESCE(ne.time_start, ns.occurred_at, ne.created_at) DESC
          LIMIT 12
        )
        SELECT *
        FROM (
          SELECT
            ce.event_id,
            ce.event_label,
            ce.event_kind,
            ce.occurred_at,
            ent.id::text AS entity_id,
            ent.canonical_name AS entity_name,
            ent.entity_type AS entity_type,
            member.member_role
          FROM chosen_events ce
          JOIN narrative_event_members member ON member.event_id::text = ce.event_id
          JOIN entities ent ON ent.id = member.entity_id
          UNION ALL
          SELECT
            ce.event_id,
            ce.event_label,
            ce.event_kind,
            ce.occurred_at,
            concat('eventmeta:participant:', ce.event_id, ':', participant_name) AS entity_id,
            participant_name AS entity_name,
            'person' AS entity_type,
            'participant' AS member_role
          FROM chosen_events ce
          JOIN narrative_events ne ON ne.id::text = ce.event_id
          JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(ne.metadata->'participant_names') = 'array' THEN ne.metadata->'participant_names'
              ELSE '[]'::jsonb
            END
          ) AS participant_name ON TRUE
          WHERE lower(participant_name) <> lower($5)
            AND lower(participant_name) <> lower($6)
          UNION ALL
          SELECT
            ce.event_id,
            ce.event_label,
            ce.event_kind,
            ce.occurred_at,
            concat('eventmeta:location:', ce.event_id) AS entity_id,
            ne.metadata->>'location_text' AS entity_name,
            'place' AS entity_type,
            'location' AS member_role
          FROM chosen_events ce
          JOIN narrative_events ne ON ne.id::text = ce.event_id
          WHERE coalesce(ne.metadata->>'location_text', '') <> ''
        ) AS focus_rows
        ORDER BY occurred_at DESC, member_role, entity_name
      `,
      [namespaceId, selectedEntityId, options?.timeStart ?? null, options?.timeEnd ?? null, entityName, entityLabelToken]
    );

    const eventDegree = new Map<string, number>();
    for (const row of focusEventRows) {
      eventDegree.set(row.event_id, (eventDegree.get(row.event_id) ?? 1) + 1);
    }

    for (const row of focusEventRows) {
      if (isLowSignalAtlasEntity(row.entity_name, row.entity_type) && row.entity_id !== selectedEntityId) {
        continue;
      }

      const eventNodeId = `event:${row.event_id}`;
      if (!nodes.has(eventNodeId)) {
        nodes.set(eventNodeId, {
          id: eventNodeId,
          name: row.event_label,
          entityType: "event",
          degree: eventDegree.get(row.event_id) ?? 1,
          mentionCount: 1,
          isSelected: false
        });
      }

      const anchorEdgeId = `focus-event:${selectedEntityId}:${row.event_id}`;
      if (!edgeKeys.has(anchorEdgeId)) {
        edgeKeys.add(anchorEdgeId);
        edges.push({
          id: anchorEdgeId,
          subjectId: selectedEntityId,
          objectId: eventNodeId,
          subjectName: nodes.get(selectedEntityId)?.name ?? entityName,
          objectName: row.event_label,
          predicate: "participated_in",
          confidence: 0.76,
          validFrom: row.occurred_at,
          sourceCandidateId: null,
          metadata: {
            event_kind: row.event_kind,
            source_event_id: row.event_id
          }
        });
      }

      if (row.entity_id === selectedEntityId) {
        continue;
      }

      if (!nodes.has(row.entity_id)) {
        nodes.set(row.entity_id, {
          id: row.entity_id,
          name: row.entity_name,
          entityType: row.entity_type,
          degree: degreeByEntity.get(row.entity_id) ?? 0,
          mentionCount: mentionCountByEntity.get(row.entity_id) ?? 0,
          isSelected: false
        });
      }

      const predicate =
        row.member_role === "location"
          ? "occurred_at"
          : row.member_role === "organization" || row.member_role === "project"
            ? "related_to"
            : "includes";
      const memberEdgeId = `focus-event-member:${row.event_id}:${row.entity_id}:${row.member_role}`;
      if (edgeKeys.has(memberEdgeId)) {
        continue;
      }
      edgeKeys.add(memberEdgeId);
      edges.push({
        id: memberEdgeId,
        subjectId: eventNodeId,
        objectId: row.entity_id,
        subjectName: row.event_label,
        objectName: row.entity_name,
        predicate,
        confidence: 0.72,
        validFrom: row.occurred_at,
        sourceCandidateId: null,
        metadata: {
          member_role: row.member_role,
          event_kind: row.event_kind,
          source_event_id: row.event_id
        }
      });
    }

    const hierarchySeedIds = [...new Set(
      [...nodes.values()]
        .filter((node) => node.entityType === "place" || node.entityType === "org" || node.entityType === "project")
        .map((node) => node.id)
        .filter((nodeId) => !nodeId.startsWith("event:") && !nodeId.startsWith("eventmeta:"))
    )];
    if (hierarchySeedIds.length > 0) {
      const hierarchyRows = await queryRows<EntityHierarchyGraphRow>(
        `
          WITH RECURSIVE climb AS (
            SELECT
              child.id::text AS child_entity_id,
              child.canonical_name AS child_name,
              child.entity_type AS child_type,
              parent.id::text AS parent_entity_id,
              parent.canonical_name AS parent_name,
              parent.entity_type AS parent_type
            FROM entities child
            JOIN entities parent ON parent.id = child.parent_entity_id
            WHERE child.namespace_id = $1
              AND child.id = ANY($2::uuid[])
            UNION ALL
            SELECT
              parent.id::text AS child_entity_id,
              parent.canonical_name AS child_name,
              parent.entity_type AS child_type,
              grand.id::text AS parent_entity_id,
              grand.canonical_name AS parent_name,
              grand.entity_type AS parent_type
            FROM climb
            JOIN entities parent ON parent.id::text = climb.parent_entity_id
            JOIN entities grand ON grand.id = parent.parent_entity_id
            WHERE parent.namespace_id = $1
          )
          SELECT DISTINCT
            child_entity_id,
            child_name,
            child_type,
            parent_entity_id,
            parent_name,
            parent_type
          FROM climb
        `,
        [namespaceId, hierarchySeedIds]
      );

      for (const row of hierarchyRows) {
        if (
          (isLowSignalAtlasEntity(row.child_name, row.child_type) && row.child_entity_id !== selectedEntityId) ||
          (isLowSignalAtlasEntity(row.parent_name, row.parent_type) && row.parent_entity_id !== selectedEntityId)
        ) {
          continue;
        }

        if (!nodes.has(row.child_entity_id)) {
          nodes.set(row.child_entity_id, {
            id: row.child_entity_id,
            name: row.child_name,
            entityType: row.child_type,
            degree: degreeByEntity.get(row.child_entity_id) ?? 0,
            mentionCount: mentionCountByEntity.get(row.child_entity_id) ?? 0,
            isSelected: false
          });
        }

        if (!nodes.has(row.parent_entity_id)) {
          nodes.set(row.parent_entity_id, {
            id: row.parent_entity_id,
            name: row.parent_name,
            entityType: row.parent_type,
            degree: degreeByEntity.get(row.parent_entity_id) ?? 0,
            mentionCount: mentionCountByEntity.get(row.parent_entity_id) ?? 0,
            isSelected: false
          });
        }

        const hierarchyEdgeId = `hierarchy:${row.child_entity_id}:${row.parent_entity_id}`;
        if (edgeKeys.has(hierarchyEdgeId)) {
          continue;
        }
        edgeKeys.add(hierarchyEdgeId);
        edges.push({
          id: hierarchyEdgeId,
          subjectId: row.child_entity_id,
          objectId: row.parent_entity_id,
          subjectName: row.child_name,
          objectName: row.parent_name,
          predicate: "contained_in",
          confidence: 0.99,
          validFrom: options?.timeStart ?? new Date().toISOString(),
          metadata: {
            source: "entity_parent_chain",
            structural: true
          }
        });
      }
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
    selectedEntity: (resolvedEntity?.canonicalName ?? entityName) || undefined,
    requestedEntity: entityName || undefined,
    ambiguityState: graphAmbiguity ? "ambiguous" : entityName && resolvedEntity ? "clear" : undefined,
    ambiguityType: graphAmbiguity?.ambiguity_type ?? null,
    ambiguityReason: graphAmbiguity?.ambiguity_reason ?? null,
    clarificationCount: graphAmbiguity ? Number(graphAmbiguity.total_count ?? "1") : 0,
    suggestedMatches: graphAmbiguity ? parseSuggestedMatches(graphAmbiguity.metadata) : [],
    nodes: graphNodes,
    edges
  };
}

function graphNodeIdByName(nodes: ReadonlyMap<string, OpsRelationshipGraphNode>, entityName: string): string | null {
  const normalized = entityName.trim().toLowerCase();
  for (const [nodeId, node] of nodes.entries()) {
    if (node.name.toLowerCase() === normalized) {
      return nodeId;
    }
  }
  return null;
}
