import { readConfig } from "../config.js";
import { queryRows } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";
import type { ArtifactId, RecallResult } from "../types.js";
import { isPrecisionLexicalQuery, isRelationshipStyleExactQuery } from "./query-signals.js";
import { planRecallQuery } from "./planner.js";
import type {
  ArtifactDetail,
  ArtifactDerivationSummary,
  ArtifactLookupQuery,
  ArtifactObservationSummary,
  RecallQuery,
  RecallResponse,
  RelationshipQuery,
  RelationshipResponse,
  RelationshipResult,
  TimelineQuery,
  TimelineResponse
} from "./types.js";

interface SearchRow {
  readonly memory_id: string;
  readonly memory_type: RecallResult["memoryType"];
  readonly content: string;
  readonly raw_score: number | string | null;
  readonly artifact_id: string | null;
  readonly occurred_at: string | Date | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
}

interface RankedSearchRow extends SearchRow {
  readonly scoreValue: number;
}

type LexicalProvider = "fts" | "bm25";

interface LexicalSourceRows {
  readonly branch: string;
  readonly rows: RankedSearchRow[];
}

const BM25_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "doing",
  "do",
  "does",
  "find",
  "for",
  "from",
  "happen",
  "happened",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "show",
  "she",
  "that",
  "the",
  "tell",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "who",
  "with",
  "you",
  "your"
]);

interface ArtifactRow {
  readonly artifact_id: string;
  readonly namespace_id: string;
  readonly artifact_type: string;
  readonly uri: string;
  readonly latest_checksum_sha256: string;
  readonly mime_type: string | null;
  readonly source_channel: string | null;
  readonly created_at: string | Date;
  readonly last_seen_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactObservationRow {
  readonly observation_id: string;
  readonly version: number;
  readonly checksum_sha256: string;
  readonly byte_size: number | null;
  readonly observed_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactDerivationRow {
  readonly derivation_id: string;
  readonly derivation_type: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly content_text: string | null;
  readonly output_dimensionality: number | null;
  readonly created_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface RelationshipRow {
  readonly relationship_id: string;
  readonly subject_name: string;
  readonly predicate: string;
  readonly object_name: string;
  readonly confidence: number | string | null;
  readonly source_memory_id: string | null;
  readonly occurred_at: string | Date | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
}

function normalizeLimit(limit: number | undefined, fallback = 10, ceiling = 50): number {
  if (!limit || Number.isNaN(limit)) {
    return fallback;
  }

  return Math.max(1, Math.min(limit, ceiling));
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function temporalLayerSpecificityBonus(layer: unknown): number {
  switch (layer) {
    case "day":
      return 0.18;
    case "week":
      return 0.14;
    case "month":
      return 0.1;
    case "year":
      return 0.06;
    case "session":
      return 0.04;
    case "profile":
      return 0.02;
    default:
      return 0;
  }
}

function temporalWindowAlignmentMultiplier(
  row: Pick<SearchRow, "memory_type" | "occurred_at" | "provenance">,
  timeStart: string | null,
  timeEnd: string | null
): number {
  if (!timeStart || !timeEnd) {
    return 1;
  }

  const queryStart = parseIsoTimestamp(timeStart);
  const queryEnd = parseIsoTimestamp(timeEnd);
  if (queryStart === null || queryEnd === null || queryEnd <= queryStart) {
    return 1;
  }

  if (row.memory_type === "episodic_memory") {
    const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
    if (occurredAt === null) {
      return 1;
    }
    return occurredAt >= queryStart && occurredAt <= queryEnd ? 1.12 : 0.45;
  }

  if (row.memory_type !== "temporal_nodes") {
    return 1;
  }

  const periodStart = parseIsoTimestamp(typeof row.provenance.period_start === "string" ? row.provenance.period_start : null);
  const periodEnd = parseIsoTimestamp(typeof row.provenance.period_end === "string" ? row.provenance.period_end : null);
  if (periodStart === null || periodEnd === null || periodEnd <= periodStart) {
    return 1;
  }

  const overlapStart = Math.max(periodStart, queryStart);
  const overlapEnd = Math.min(periodEnd, queryEnd);
  if (overlapEnd <= overlapStart) {
    return 0.35;
  }

  const overlapRatio = (overlapEnd - overlapStart) / (queryEnd - queryStart);
  const specificityBonus = temporalLayerSpecificityBonus(row.provenance.layer);
  return 0.7 + Math.min(overlapRatio, 1) * 0.5 + specificityBonus;
}

function hasNarrowTimeWindow(timeStart: string | null, timeEnd: string | null): boolean {
  const start = parseIsoTimestamp(timeStart);
  const end = parseIsoTimestamp(timeEnd);
  if (start === null || end === null || end <= start) {
    return false;
  }

  return (end - start) / (1000 * 60 * 60 * 24) <= 45;
}

function buildRecallResult(
  row: SearchRow,
  score: number,
  retrieval: {
    readonly rrfScore: number;
    readonly lexicalRank?: number;
    readonly vectorRank?: number;
    readonly lexicalRawScore?: number;
    readonly vectorDistance?: number;
  }
): RecallResult {
  return {
    memoryId: row.memory_id,
    memoryType: row.memory_type,
    content: row.content,
    score,
    artifactId: row.artifact_id as ArtifactId | null,
    occurredAt: toIsoString(row.occurred_at),
    namespaceId: row.namespace_id,
    provenance: {
      ...row.provenance,
      retrieval
    }
  };
}

function mapRecallRows(rows: SearchRow[]): RecallResult[] {
  return rows.map((row) =>
    buildRecallResult(row, toNumber(row.raw_score), {
      rrfScore: toNumber(row.raw_score)
    })
  );
}

function memoryTypePriority(memoryType: RecallResult["memoryType"], hasTimeWindow: boolean, temporalFocus: boolean): number {
  if (temporalFocus) {
    switch (memoryType) {
      case "episodic_memory":
        return 0;
      case "temporal_nodes":
        return 1;
      case "artifact_derivation":
        return 2;
      case "semantic_memory":
        return 3;
      case "memory_candidate":
        return 4;
      case "procedural_memory":
        return 5;
      default:
        return 6;
    }
  }

  if (hasTimeWindow) {
    switch (memoryType) {
      case "episodic_memory":
        return 0;
      case "temporal_nodes":
        return 1;
      case "artifact_derivation":
        return 2;
      case "semantic_memory":
        return 3;
      case "memory_candidate":
        return 4;
      case "procedural_memory":
        return 5;
      default:
        return 6;
    }
  }

  switch (memoryType) {
    case "procedural_memory":
      return 0;
    case "semantic_memory":
      return 1;
    case "episodic_memory":
      return 2;
    case "artifact_derivation":
      return 3;
    case "memory_candidate":
      return 4;
    case "temporal_nodes":
      return 5;
    default:
      return 6;
  }
}

function compareLexical(left: RankedSearchRow, right: RankedSearchRow, hasTimeWindow: boolean, temporalFocus: boolean): number {
  const scoreDelta = right.scoreValue - left.scoreValue;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const priorityDelta =
    memoryTypePriority(left.memory_type, hasTimeWindow, temporalFocus) -
    memoryTypePriority(right.memory_type, hasTimeWindow, temporalFocus);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const rightIso = toIsoString(right.occurred_at);
  const leftIso = toIsoString(left.occurred_at);
  if (leftIso && rightIso && leftIso !== rightIso) {
    return rightIso.localeCompare(leftIso);
  }

  return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
}

function compareVector(left: RankedSearchRow, right: RankedSearchRow): number {
  const scoreDelta = left.scoreValue - right.scoreValue;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const rightIso = toIsoString(right.occurred_at);
  const leftIso = toIsoString(left.occurred_at);
  if (leftIso && rightIso && leftIso !== rightIso) {
    return rightIso.localeCompare(leftIso);
  }

  return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
}

function toRankedRows(rows: SearchRow[]): RankedSearchRow[] {
  return rows.map((row) => ({
    ...row,
    scoreValue: toNumber(row.raw_score)
  }));
}

function resultKey(row: SearchRow): string {
  return `${row.memory_type}:${row.memory_id}`;
}

function mergeUniqueRows(
  existingRows: readonly RankedSearchRow[],
  additionalRows: readonly RankedSearchRow[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean
): RankedSearchRow[] {
  const merged = new Map(existingRows.map((row) => [resultKey(row), row] as const));

  for (const row of additionalRows) {
    const key = resultKey(row);
    const existing = merged.get(key);
    if (existing) {
      if (row.provenance.tier === "temporal_descendant_support" && existing.provenance.tier !== "temporal_descendant_support") {
        merged.set(key, {
          ...existing,
          provenance: {
            ...existing.provenance,
            temporal_support: row.provenance
          }
        });
      }
      continue;
    }

    merged.set(key, row);
  }

  return [...merged.values()]
    .sort((left, right) => compareLexical(left, right, hasTimeWindow, temporalFocus))
    .slice(0, candidateLimit);
}

function buildBm25DisjunctionClause(
  fields: readonly string[],
  queryText: string,
  parameterIndex: number
): {
  readonly clause: string;
  readonly values: readonly string[];
} {
  const normalized = queryText.trim();
  if (!normalized) {
    return {
      clause: "TRUE",
      values: []
    };
  }

  const groups = fields.map((field) => `${field} ||| $${parameterIndex}`);
  return {
    clause: `(${groups.join(" OR ")})`,
    values: [normalized]
  };
}

function proceduralLexicalDocument(): string {
  return `
    coalesce(state_type, '') || ' ' ||
    coalesce(state_key, '') || ' ' ||
    coalesce(state_value::text, '') || ' ' ||
    CASE
      WHEN valid_until IS NULL THEN 'current active latest authoritative'
      ELSE 'historical inactive superseded'
    END
  `;
}

function lexicalBranchWeight(
  branch: string,
  planner: ReturnType<typeof planRecallQuery>,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean
): number {
  if (relationshipExactFocus) {
    switch (branch) {
      case "episodic_memory":
        return planner.episodicWeight * 1.35;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.95;
      case "semantic_memory":
        return 0.72;
      case "memory_candidate":
        return 0.7;
      default:
        return 1;
    }
  }

  if (precisionLexicalFocus) {
    switch (branch) {
      case "episodic_memory":
      case "artifact_derivation":
      case "semantic_memory":
        return 1.1;
      case "memory_candidate":
        return 0.55;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.92;
      default:
        return 1;
    }
  }

  switch (branch) {
    case "episodic_memory":
      return planner.episodicWeight;
    case "temporal_nodes":
      return planner.temporalSummaryWeight;
    default:
      return 1;
  }
}

function pruneRankedResults(
  rows: readonly {
    row: SearchRow;
    lexicalRank?: number;
    vectorRank?: number;
    lexicalRawScore?: number;
    vectorDistance?: number;
    rrfScore: number;
  }[],
  planner: ReturnType<typeof planRecallQuery>,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  narrowTemporalWindow: boolean
): readonly {
  row: SearchRow;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalRawScore?: number;
  vectorDistance?: number;
  rrfScore: number;
}[] {
  if (rows.length <= 1) {
    return rows;
  }

  const topType = rows[0]?.row.memory_type;
  const hasTemporal = rows.some((item) => item.row.memory_type === "temporal_nodes");
  const hasEpisodic = rows.some((item) => item.row.memory_type === "episodic_memory");
  const proceduralRows = rows.filter((item) => item.row.memory_type === "procedural_memory");

  if (!planner.temporalFocus && proceduralRows.length > 0 && (topType === "procedural_memory" || topType === "semantic_memory")) {
    return proceduralRows.slice(0, 1);
  }

  if (relationshipExactFocus && topType === "episodic_memory") {
    return rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 1);
  }

  if (topType === "procedural_memory") {
    return rows.filter((item) => item.row.memory_type === "procedural_memory").slice(0, 1);
  }

  if (topType === "artifact_derivation") {
    return rows.filter((item) => item.row.memory_type === "artifact_derivation").slice(0, 1);
  }

  if (precisionLexicalFocus && !planner.temporalFocus) {
    if (topType === "episodic_memory" || topType === "semantic_memory") {
      return rows.filter((item) => item.row.memory_type === topType).slice(0, 1);
    }
  }

  if (planner.temporalFocus && hasTemporal && hasEpisodic) {
    if (narrowTemporalWindow) {
      const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
      const temporalRows = rows.filter((item) => item.row.memory_type === "temporal_nodes").slice(0, 1);
      return [...episodicRows, ...temporalRows];
    }

    const temporalRows = rows.filter((item) => item.row.memory_type === "temporal_nodes").slice(0, 1);
    const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
    const artifactRows = rows.filter((item) => item.row.memory_type === "artifact_derivation").slice(0, 1);
    return [...temporalRows, ...episodicRows, ...artifactRows];
  }

  return rows.filter((item) => item.row.memory_type !== "memory_candidate");
}

function rankLexicalSources(
  sources: readonly LexicalSourceRows[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  planner: ReturnType<typeof planRecallQuery>,
  timeStart: string | null,
  timeEnd: string | null
): RankedSearchRow[] {
  const accumulator = new Map<string, { row: RankedSearchRow; score: number }>();

  for (const source of sources) {
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index];
      const key = resultKey(row);
      const current = accumulator.get(key) ?? { row, score: 0 };
      current.row = row;
      const branchWeight = lexicalBranchWeight(source.branch, planner, relationshipExactFocus, precisionLexicalFocus);
      const temporalAlignment = temporalWindowAlignmentMultiplier(row, timeStart, timeEnd);
      current.score += (branchWeight * temporalAlignment) / (20 + index + 1);
      accumulator.set(key, current);
    }
  }

  return [...accumulator.values()]
    .map(({ row, score }) => ({
      ...row,
      raw_score: score,
      scoreValue: score
    }))
    .sort((left, right) => compareLexical(left, right, hasTimeWindow, temporalFocus))
    .slice(0, candidateLimit);
}

function buildLayerBudgetCase(
  budgets: ReturnType<typeof planRecallQuery>["descendantLayerBudgets"] | ReturnType<typeof planRecallQuery>["ancestorLayerBudgets"]
): string {
  return `CASE layer
    WHEN 'session' THEN ${Math.max(0, budgets.session)}
    WHEN 'day' THEN ${Math.max(0, budgets.day)}
    WHEN 'week' THEN ${Math.max(0, budgets.week)}
    WHEN 'month' THEN ${Math.max(0, budgets.month)}
    WHEN 'year' THEN ${Math.max(0, budgets.year)}
    WHEN 'profile' THEN ${Math.max(0, budgets.profile)}
    ELSE 0
  END`;
}

function approxResultTokenCount(rows: readonly RankedSearchRow[]): number {
  return rows.reduce((sum, row) => sum + row.content.split(/\s+/u).filter(Boolean).length, 0);
}

function hasSufficientTemporalEvidence(
  rows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>
): boolean {
  const episodicCount = rows.filter((row) => row.memory_type === "episodic_memory").length;
  const temporalCount = rows.filter((row) => row.memory_type === "temporal_nodes").length;
  const tokenCount = approxResultTokenCount(rows);

  if (episodicCount >= planner.temporalSufficiencyEpisodicThreshold) {
    return true;
  }

  if (temporalCount >= planner.temporalSufficiencyTemporalThreshold && tokenCount >= planner.temporalSupportMaxTokens) {
    return true;
  }

  return false;
}

async function loadTemporalHierarchyRows(
  namespaceId: string,
  seedRows: readonly RankedSearchRow[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>
): Promise<RankedSearchRow[]> {
  const episodicIds = seedRows
    .filter((row) => row.memory_type === "episodic_memory")
    .map((row) => row.memory_id)
    .slice(0, Math.min(candidateLimit, 12));
  const temporalIds = seedRows
    .filter((row) => row.memory_type === "temporal_nodes")
    .map((row) => row.memory_id)
    .slice(0, Math.min(candidateLimit, 12));

  if (episodicIds.length === 0 && temporalIds.length === 0) {
    return [];
  }

  const ancestorBudgetCase = buildLayerBudgetCase(planner.ancestorLayerBudgets);
  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE seed_nodes AS (
        SELECT DISTINCT tnm.temporal_node_id AS id
        FROM temporal_node_members tnm
        WHERE tnm.namespace_id = $1
          AND coalesce(array_length($2::uuid[], 1), 0) > 0
          AND tnm.source_memory_id = ANY($2::uuid[])

        UNION

        SELECT DISTINCT seed_id AS id
        FROM unnest(coalesce($3::uuid[], ARRAY[]::uuid[])) AS seed_id
      ),
      ancestry AS (
        SELECT
          tn.id,
          tn.parent_id,
          tn.depth,
          tn.layer,
          tn.period_start,
          tn.period_end,
          tn.summary_text,
          tn.namespace_id,
          tn.source_count,
          tn.generated_by,
          tn.metadata,
          0 AS hops
        FROM temporal_nodes tn
        JOIN seed_nodes sn ON sn.id = tn.id
        WHERE tn.namespace_id = $1
          AND tn.summary_text <> ''
          AND ($4::timestamptz IS NULL OR tn.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR tn.period_start <= $5::timestamptz)

        UNION ALL

        SELECT
          parent.id,
          parent.parent_id,
          parent.depth,
          parent.layer,
          parent.period_start,
          parent.period_end,
          parent.summary_text,
          parent.namespace_id,
          parent.source_count,
          parent.generated_by,
          parent.metadata,
          ancestry.hops + 1
        FROM temporal_nodes parent
        JOIN ancestry ON ancestry.parent_id = parent.id
        WHERE parent.namespace_id = $1
          AND ancestry.hops < $6
      ),
      ranked_ancestry AS (
        SELECT
          ancestry.*,
          ROW_NUMBER() OVER (
            PARTITION BY ancestry.layer
            ORDER BY ancestry.hops ASC, ancestry.depth DESC, ancestry.period_end DESC, ancestry.id
          ) AS layer_rank
        FROM ancestry
      ),
      selected_ancestry AS (
        SELECT *
        FROM ranked_ancestry
        WHERE layer_rank <= ${ancestorBudgetCase}
      )
      SELECT DISTINCT ON (id)
        id AS memory_id,
        'temporal_nodes'::text AS memory_type,
        summary_text AS content,
        ((depth + 1)::double precision / (25 + hops + 1)) AS raw_score,
        NULL::uuid AS artifact_id,
        period_end AS occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'temporal_ancestor',
          'layer', layer,
          'period_start', period_start,
          'period_end', period_end,
          'depth', depth,
          'hops', hops,
          'parent_id', parent_id,
          'source_count', source_count,
          'generated_by', generated_by,
          'metadata', metadata
        ) AS provenance
      FROM selected_ancestry
      ORDER BY id, hops ASC, depth DESC, period_end DESC
      LIMIT $7
    `,
    [namespaceId, episodicIds, temporalIds, timeStart, timeEnd, Math.max(planner.maxTemporalDepth, 1), candidateLimit]
  );

  return toRankedRows(rows)
    .map((row) => ({
      ...row,
      raw_score: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd),
      scoreValue: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd)
    }))
    .sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), true));
}

function allowedDescendantLayers(
  planner: ReturnType<typeof planRecallQuery>
): readonly ("day" | "week" | "month")[] {
  return planner.targetLayers.filter(
    (layer): layer is "day" | "week" | "month" =>
      (layer === "day" || layer === "week" || layer === "month") && planner.descendantLayerBudgets[layer] > 0
  );
}

async function loadTemporalDescendantSupportRows(
  namespaceId: string,
  seedRows: readonly RankedSearchRow[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>
): Promise<RankedSearchRow[]> {
  const temporalIds = [...new Set(
    seedRows.filter((row) => row.memory_type === "temporal_nodes").map((row) => row.memory_id)
  )].slice(0, Math.min(candidateLimit, 6));
  const layers = allowedDescendantLayers(planner);

  if (temporalIds.length === 0 || layers.length === 0 || planner.supportMemberBudget <= 0) {
    return [];
  }

  const layerBudgetCase = `CASE d.layer
    WHEN 'day' THEN ${Math.max(0, planner.descendantLayerBudgets.day)}
    WHEN 'week' THEN ${Math.max(0, planner.descendantLayerBudgets.week)}
    WHEN 'month' THEN ${Math.max(0, planner.descendantLayerBudgets.month)}
    ELSE 0
  END`;
  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE descendants AS (
        SELECT
          child.id,
          child.parent_id,
          child.layer,
          child.period_start,
          child.period_end,
          child.depth,
          child.namespace_id,
          child.summary_text,
          child.source_count,
          child.generated_by,
          child.metadata,
          child.parent_id AS seed_temporal_node_id,
          1 AS hops
        FROM temporal_nodes child
        WHERE child.namespace_id = $1
          AND child.parent_id = ANY($2::uuid[])
          AND child.layer = ANY($3::text[])
          AND ($4::timestamptz IS NULL OR child.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR child.period_start <= $5::timestamptz)

        UNION ALL

        SELECT
          child.id,
          child.parent_id,
          child.layer,
          child.period_start,
          child.period_end,
          child.depth,
          child.namespace_id,
          child.summary_text,
          child.source_count,
          child.generated_by,
          child.metadata,
          descendants.seed_temporal_node_id,
          descendants.hops + 1 AS hops
        FROM temporal_nodes child
        JOIN descendants ON child.parent_id = descendants.id
        WHERE child.namespace_id = $1
          AND child.layer = ANY($3::text[])
          AND descendants.hops < $6
          AND ($4::timestamptz IS NULL OR child.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR child.period_start <= $5::timestamptz)
      ),
      ranked_descendants AS (
        SELECT
          d.*,
          ROW_NUMBER() OVER (
            PARTITION BY d.seed_temporal_node_id, d.layer
            ORDER BY d.period_end DESC, d.depth DESC, d.id
          ) AS layer_rank
        FROM descendants d
      ),
      selected_descendants AS (
        SELECT *
        FROM ranked_descendants d
        WHERE d.layer_rank <= ${layerBudgetCase}
      ),
      descendant_members AS (
        SELECT
          sd.seed_temporal_node_id,
          sd.id AS supporting_temporal_node_id,
          sd.layer AS supporting_layer,
          sd.period_start,
          sd.period_end,
          sd.hops AS support_hops,
          e.id AS memory_id,
          e.content,
          e.artifact_id,
          e.occurred_at,
          e.namespace_id,
          e.artifact_observation_id,
          e.source_chunk_id,
          e.source_offset,
          e.metadata,
          a.uri AS source_uri,
          ROW_NUMBER() OVER (
            PARTITION BY sd.id
            ORDER BY e.occurred_at DESC, e.id
          ) AS member_rank
        FROM selected_descendants sd
        JOIN temporal_node_members tnm
          ON tnm.temporal_node_id = sd.id
         AND tnm.member_role = 'summary_input'
         AND tnm.source_memory_id IS NOT NULL
        JOIN episodic_memory e
          ON e.id = tnm.source_memory_id
         AND e.namespace_id = $1
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE ($4::timestamptz IS NULL OR e.occurred_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR e.occurred_at <= $5::timestamptz)
      )
      SELECT DISTINCT ON (memory_id)
        memory_id,
        'episodic_memory'::text AS memory_type,
        content,
        (1.0 / (35 + support_hops + member_rank))::double precision AS raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'temporal_descendant_support',
          'seed_temporal_node_id', seed_temporal_node_id,
          'supporting_temporal_node_id', supporting_temporal_node_id,
          'supporting_layer', supporting_layer,
          'support_hops', support_hops,
          'period_start', period_start,
          'period_end', period_end,
          'artifact_observation_id', artifact_observation_id,
          'source_chunk_id', source_chunk_id,
          'source_offset', source_offset,
          'source_uri', source_uri,
          'metadata', metadata
        ) AS provenance
      FROM descendant_members
      WHERE member_rank <= $7
      ORDER BY memory_id, support_hops ASC, member_rank ASC, occurred_at DESC
      LIMIT $8
    `,
    [
      namespaceId,
      temporalIds,
      layers,
      timeStart,
      timeEnd,
      Math.max(planner.maxTemporalDepth, 1),
      planner.supportMemberBudget,
      candidateLimit
    ]
  );

  return toRankedRows(rows)
    .map((row) => ({
      ...row,
      raw_score: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd),
      scoreValue: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd)
    }))
    .sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), true));
}

async function loadFtsLexicalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  hasTimeWindow: boolean,
  relationshipExactFocus: boolean
): Promise<RankedSearchRow[]> {
  const temporalRowsPromise = planner.temporalFocus || hasTimeWindow
    ? queryRows<SearchRow>(
        `
          SELECT
            id AS memory_id,
            'temporal_nodes'::text AS memory_type,
            summary_text AS content,
            ts_rank(to_tsvector('english', coalesce(summary_text, '')), websearch_to_tsquery('english', $2)) AS raw_score,
            NULL::uuid AS artifact_id,
            period_end AS occurred_at,
            namespace_id,
            jsonb_build_object(
              'tier', 'temporal_summary',
              'layer', layer,
              'period_start', period_start,
              'period_end', period_end,
              'summary_version', summary_version,
              'source_count', source_count,
              'generated_by', generated_by,
              'metadata', metadata
            ) AS provenance
          FROM temporal_nodes
          WHERE namespace_id = $1
            AND summary_text <> ''
            AND (
              ($3::timestamptz IS NULL OR period_end >= $3::timestamptz)
              AND ($4::timestamptz IS NULL OR period_start <= $4::timestamptz)
            )
            AND to_tsvector('english', coalesce(summary_text, '')) @@ websearch_to_tsquery('english', $2)
          ORDER BY raw_score DESC, period_end DESC
          LIMIT $5
        `,
        [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
      )
    : Promise.resolve<SearchRow[]>([]);

  const [proceduralRows, semanticRows, candidateRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'procedural_memory'::text AS memory_type,
          CONCAT(state_type, ': ', state_key, ' = ', state_value::text) AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          NULL::uuid AS artifact_id,
          updated_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', state_type,
            'state_key', state_key,
            'version', version,
            'valid_from', valid_from,
            'valid_until', valid_until,
            'metadata', metadata
          ) AS provenance
        FROM procedural_memory
        WHERE namespace_id = $1
          AND valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, updated_at DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'semantic_memory'::text AS memory_type,
          content_abstract AS content,
          ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          NULL::uuid AS artifact_id,
          valid_from AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'memory_kind', memory_kind,
            'canonical_key', canonical_key,
            'valid_from', valid_from,
            'valid_until', valid_until,
            'status', status,
            'source_episodic_id', source_episodic_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM semantic_memory
        WHERE namespace_id = $1
          AND status = 'active'
          AND valid_until IS NULL
          AND search_vector @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, valid_from DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'memory_candidate'::text AS memory_type,
          content,
          ts_rank(to_tsvector('english', coalesce(content, '')), websearch_to_tsquery('english', $2)) AS raw_score,
          NULL::uuid AS artifact_id,
          created_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'candidate_memory',
            'candidate_type', candidate_type,
            'canonical_key', canonical_key,
            'status', status,
            'source_memory_id', source_memory_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM memory_candidates
        WHERE namespace_id = $1
          AND status IN ('pending', 'accepted')
          AND to_tsvector('english', coalesce(content, '')) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, created_at DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    temporalRowsPromise,
    queryRows<SearchRow>(
      `
        SELECT
          et.memory_id AS memory_id,
          'episodic_memory'::text AS memory_type,
          et.content,
          ts_rank(et.search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          et.artifact_id,
          et.occurred_at,
          et.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'artifact_observation_id', et.artifact_observation_id,
            'source_chunk_id', et.source_chunk_id,
            'source_offset', et.source_offset,
            'source_uri', a.uri,
            'metadata', et.metadata
          ) AS provenance
        FROM episodic_timeline et
        LEFT JOIN artifacts a ON a.id = et.artifact_id
        WHERE et.namespace_id = $1
          AND et.search_vector @@ websearch_to_tsquery('english', $2)
          AND ($4::timestamptz IS NULL OR et.occurred_at >= $4)
          AND ($5::timestamptz IS NULL OR et.occurred_at <= $5)
        ORDER BY raw_score DESC, et.occurred_at DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit, timeStart, timeEnd]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ad.content_text AS content,
          ts_rank(to_tsvector('english', coalesce(ad.content_text, '')), websearch_to_tsquery('english', $2)) AS raw_score,
          ao.artifact_id,
          ad.created_at AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND to_tsvector('english', coalesce(ad.content_text, '')) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, ad.created_at DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    )
  ]);

  return toRankedRows([
    ...proceduralRows,
    ...semanticRows,
    ...candidateRows,
    ...temporalRows,
    ...episodicRows,
    ...derivationRows
  ])
    .sort((left, right) => compareLexical(left, right, hasTimeWindow, planner.temporalFocus))
    .slice(0, candidateLimit);
}

async function loadBm25LexicalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  hasTimeWindow: boolean,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean
): Promise<RankedSearchRow[]> {
  const plannerTerms = planner.lexicalTerms.filter((term) => {
    const normalized = term.toLowerCase();
    if (/^\d{4}$/.test(normalized) && planner.temporalFocus) {
      return false;
    }
    return !BM25_STOP_WORDS.has(normalized);
  });
  const effectiveQueryText = (plannerTerms.length > 0 ? plannerTerms : [queryText]).join(" ");
  const semanticMatch = buildBm25DisjunctionClause(["content_abstract", "canonical_key", "memory_kind"], effectiveQueryText, 2);
  const candidateMatch = buildBm25DisjunctionClause(["content", "candidate_type", "canonical_key"], effectiveQueryText, 2);
  const temporalMatch = buildBm25DisjunctionClause(["summary_text", "layer"], effectiveQueryText, 2);
  const episodicMatch = buildBm25DisjunctionClause(["e.content", "e.role"], effectiveQueryText, 2);
  const derivationMatch = buildBm25DisjunctionClause(["ad.content_text", "ad.derivation_type"], effectiveQueryText, 2);

  const [proceduralRows, semanticRows, candidateRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'procedural_memory'::text AS memory_type,
          CONCAT(state_type, ': ', state_key, ' = ', state_value::text) AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          NULL::uuid AS artifact_id,
          updated_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'lexical_provider', 'fts_bridge',
            'state_type', state_type,
            'state_key', state_key,
            'version', version,
            'valid_from', valid_from,
            'valid_until', valid_until,
            'metadata', metadata
          ) AS provenance
        FROM procedural_memory
        WHERE namespace_id = $1
          AND valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, updated_at DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'semantic_memory'::text AS memory_type,
          content_abstract AS content,
          pdb.score(id) AS raw_score,
          NULL::uuid AS artifact_id,
          valid_from AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'lexical_provider', 'bm25',
            'memory_kind', memory_kind,
            'canonical_key', canonical_key,
            'valid_from', valid_from,
            'valid_until', valid_until,
            'status', status,
            'source_episodic_id', source_episodic_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM semantic_memory
        WHERE namespace_id = $1
          AND status = 'active'
          AND valid_until IS NULL
          AND ${semanticMatch.clause}
        ORDER BY raw_score DESC, valid_from DESC
            LIMIT $3
      `,
      [namespaceId, ...semanticMatch.values, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'memory_candidate'::text AS memory_type,
          content,
          pdb.score(id) AS raw_score,
          NULL::uuid AS artifact_id,
          created_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'candidate_memory',
            'lexical_provider', 'bm25',
            'candidate_type', candidate_type,
            'canonical_key', canonical_key,
            'status', status,
            'source_memory_id', source_memory_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM memory_candidates
        WHERE namespace_id = $1
          AND status IN ('pending', 'accepted')
          AND ${candidateMatch.clause}
        ORDER BY raw_score DESC, created_at DESC
            LIMIT $3
      `,
      [namespaceId, ...candidateMatch.values, candidateLimit]
    ),
    planner.temporalFocus || hasTimeWindow
      ? queryRows<SearchRow>(
          `
            SELECT
              id AS memory_id,
              'temporal_nodes'::text AS memory_type,
              summary_text AS content,
              pdb.score(id) AS raw_score,
              NULL::uuid AS artifact_id,
              period_end AS occurred_at,
              namespace_id,
              jsonb_build_object(
                'tier', 'temporal_summary',
                'lexical_provider', 'bm25',
                'layer', layer,
                'period_start', period_start,
                'period_end', period_end,
                'summary_version', summary_version,
                'source_count', source_count,
                'generated_by', generated_by,
                'metadata', metadata
              ) AS provenance
            FROM temporal_nodes
            WHERE namespace_id = $1
              AND summary_text <> ''
              AND (
                ($3::timestamptz IS NULL OR period_end >= $3::timestamptz)
                AND ($4::timestamptz IS NULL OR period_start <= $4::timestamptz)
              )
              AND ${temporalMatch.clause}
            ORDER BY raw_score DESC, period_end DESC
            LIMIT $5
          `,
          [namespaceId, ...temporalMatch.values, timeStart, timeEnd, candidateLimit]
        )
      : Promise.resolve<SearchRow[]>([]),
    queryRows<SearchRow>(
      `
        SELECT
          e.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          e.content,
          pdb.score(e.id) AS raw_score,
          e.artifact_id,
          e.occurred_at,
          e.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'lexical_provider', 'bm25',
            'artifact_observation_id', e.artifact_observation_id,
            'source_chunk_id', e.source_chunk_id,
            'source_offset', e.source_offset,
            'source_uri', a.uri,
            'metadata', e.metadata
          ) AS provenance
        FROM episodic_memory e
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE e.namespace_id = $1
          AND ${episodicMatch.clause}
          AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
        ORDER BY raw_score DESC, e.occurred_at DESC
        LIMIT $5
      `,
      [namespaceId, ...episodicMatch.values, timeStart, timeEnd, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ad.content_text AS content,
          ts_rank(to_tsvector('english', coalesce(ad.content_text, '')), websearch_to_tsquery('english', $2)) AS raw_score,
          ao.artifact_id,
          ad.created_at AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'fts_bridge',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND to_tsvector('english', coalesce(ad.content_text, '')) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, ad.created_at DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
    )
  ]);

  return rankLexicalSources(
    [
      { branch: "procedural_memory", rows: toRankedRows(proceduralRows) },
      { branch: "semantic_memory", rows: toRankedRows(semanticRows) },
      { branch: "memory_candidate", rows: toRankedRows(candidateRows) },
      { branch: "temporal_nodes", rows: toRankedRows(temporalRows) },
      { branch: "episodic_memory", rows: toRankedRows(episodicRows) },
      { branch: "artifact_derivation", rows: toRankedRows(derivationRows) }
    ],
    candidateLimit,
    hasTimeWindow,
    planner.temporalFocus,
    relationshipExactFocus,
    precisionLexicalFocus,
    planner,
    timeStart,
    timeEnd
  );
}

async function resolveQueryEmbedding(
  query: RecallQuery
): Promise<{
  readonly embedding: number[] | null;
  readonly source: "provided" | "provider" | "none";
  readonly provider?: string;
  readonly model?: string;
  readonly fallbackReason?: string;
}> {
  if (query.queryEmbedding && query.queryEmbedding.length > 0) {
    return {
      embedding: [...query.queryEmbedding],
      source: "provided"
    };
  }

  const config = readConfig();
  const selectedProvider = query.provider ?? config.embeddingProvider;

  try {
    const adapter = getProviderAdapter(selectedProvider);
    const response = await adapter.embedText({
      text: query.query,
      model: query.model,
      outputDimensionality: query.outputDimensionality ?? config.embeddingDimensions
    });

    return {
      embedding: response.embedding,
      source: "provider",
      provider: response.provider,
      model: response.model
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        embedding: null,
        source: "none",
        fallbackReason: `${error.provider}:${error.code}`
      };
    }

    throw error;
  }
}

export async function searchMemory(query: RecallQuery): Promise<RecallResponse> {
  const config = readConfig();
  const limit = normalizeLimit(query.limit);
  const queryText = query.query.trim();
  const planner = planRecallQuery(query);
  const relationshipExactFocus = isRelationshipStyleExactQuery(queryText);
  const precisionLexicalFocus = (!query.queryEmbedding || query.queryEmbedding.length === 0) && (isPrecisionLexicalQuery(queryText) || relationshipExactFocus);
  const timeStart = query.timeStart ?? planner.inferredTimeStart ?? null;
  const timeEnd = query.timeEnd ?? planner.inferredTimeEnd ?? null;
  const hasTimeWindow = Boolean(timeStart || timeEnd);
  const narrowTemporalWindow = hasNarrowTimeWindow(timeStart, timeEnd);
  const candidateLimit = precisionLexicalFocus
    ? Math.max(Math.min(limit * 2, 12), 8)
    : planner.temporalFocus
      ? Math.max(limit * planner.candidateLimitMultiplier, 12)
      : Math.max(limit * planner.candidateLimitMultiplier, 20);
  const [queryEmbeddingResult, lexicalResult] = await Promise.all([
    resolveQueryEmbedding(query),
    (async () => {
      if (config.lexicalProvider !== "bm25") {
        return {
          rows: await loadFtsLexicalRows(
            query.namespaceId,
            queryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus
          ),
          provider: "fts" as LexicalProvider,
          fallbackUsed: false,
          fallbackReason: undefined as string | undefined
        };
      }

      try {
        return {
          rows: await loadBm25LexicalRows(
            query.namespaceId,
            queryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus,
            precisionLexicalFocus
          ),
          provider: "bm25" as LexicalProvider,
          fallbackUsed: false,
          fallbackReason: undefined as string | undefined
        };
      } catch (error) {
        if (!config.lexicalFallbackEnabled) {
          throw error;
        }

        return {
          rows: await loadFtsLexicalRows(
            query.namespaceId,
            queryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus
          ),
          provider: "fts" as LexicalProvider,
          fallbackUsed: true,
          fallbackReason: error instanceof Error ? error.message : "unknown_bm25_failure"
        };
      }
    })()
  ]);
  let lexicalRows = lexicalResult.rows;
  if (planner.temporalFocus || hasTimeWindow) {
    const ancestryRows = await loadTemporalHierarchyRows(
      query.namespaceId,
      lexicalRows,
      candidateLimit,
      timeStart,
      timeEnd,
      planner
    );
    if (ancestryRows.length > 0) {
      lexicalRows = mergeUniqueRows(lexicalRows, ancestryRows, candidateLimit, hasTimeWindow, planner.temporalFocus);
    }

    const temporalGateTriggered = !hasSufficientTemporalEvidence(lexicalRows, planner);
    if (temporalGateTriggered) {
      const descendantRows = await loadTemporalDescendantSupportRows(
        query.namespaceId,
        lexicalRows,
        candidateLimit,
        timeStart,
        timeEnd,
        planner
      );
      if (descendantRows.length > 0) {
        lexicalRows = mergeUniqueRows(lexicalRows, descendantRows, candidateLimit, hasTimeWindow, planner.temporalFocus);
      }
    }
  }

  let vectorRows: RankedSearchRow[] = [];
  if (queryEmbeddingResult.embedding) {
    const vectorLiteral = `[${queryEmbeddingResult.embedding.join(",")}]`;
    const [semanticVectorRows, derivationVectorRows] = await Promise.all([
      queryRows<SearchRow>(
        `
          SELECT
            id AS memory_id,
            'semantic_memory'::text AS memory_type,
            content_abstract AS content,
            (embedding <=> $2::vector) AS raw_score,
            NULL::uuid AS artifact_id,
            valid_from AS occurred_at,
            namespace_id,
            jsonb_build_object(
              'tier', 'current_semantic',
              'memory_kind', memory_kind,
              'canonical_key', canonical_key,
              'valid_from', valid_from,
              'valid_until', valid_until,
              'status', status,
              'source_episodic_id', source_episodic_id,
              'source_chunk_id', source_chunk_id,
              'source_artifact_observation_id', source_artifact_observation_id,
              'metadata', metadata
            ) AS provenance
          FROM semantic_memory
          WHERE namespace_id = $1
            AND status = 'active'
            AND valid_until IS NULL
            AND embedding IS NOT NULL
            AND ($3::timestamptz IS NULL OR valid_from >= $3)
            AND ($4::timestamptz IS NULL OR valid_from <= $4)
          ORDER BY embedding <=> $2::vector ASC, valid_from DESC
          LIMIT $5
        `,
        [query.namespaceId, vectorLiteral, timeStart, timeEnd, candidateLimit]
      ),
      queryRows<SearchRow>(
        `
          SELECT
            ad.id AS memory_id,
            'artifact_derivation'::text AS memory_type,
            ad.content_text AS content,
            (ad.embedding <=> $2::vector) AS raw_score,
            ao.artifact_id,
            ao.observed_at AS occurred_at,
            a.namespace_id,
            jsonb_build_object(
              'tier', 'artifact_derivation',
              'derivation_type', ad.derivation_type,
              'provider', ad.provider,
              'model', ad.model,
              'artifact_observation_id', ad.artifact_observation_id,
              'source_chunk_id', ad.source_chunk_id,
              'source_uri', a.uri,
              'metadata', ad.metadata
            ) AS provenance
          FROM artifact_derivations ad
          JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
          JOIN artifacts a ON a.id = ao.artifact_id
          WHERE a.namespace_id = $1
            AND coalesce(ad.content_text, '') <> ''
            AND ad.embedding IS NOT NULL
            AND ($3::timestamptz IS NULL OR ao.observed_at >= $3)
            AND ($4::timestamptz IS NULL OR ao.observed_at <= $4)
          ORDER BY ad.embedding <=> $2::vector ASC, ao.observed_at DESC
          LIMIT $5
        `,
        [query.namespaceId, vectorLiteral, timeStart, timeEnd, candidateLimit]
      )
    ]);

    vectorRows = toRankedRows([...semanticVectorRows, ...derivationVectorRows])
      .sort(compareVector)
      .slice(0, candidateLimit);
  }

  const rankAccumulator = new Map<
    string,
    {
      row: SearchRow;
      lexicalRank?: number;
      vectorRank?: number;
      lexicalRawScore?: number;
      vectorDistance?: number;
      rrfScore: number;
    }
  >();

  for (let index = 0; index < lexicalRows.length; index += 1) {
    const row = lexicalRows[index];
    const key = resultKey(row);
    const current = rankAccumulator.get(key) ?? { row, rrfScore: 0 };
    current.row = row;
    current.lexicalRank = index + 1;
    current.lexicalRawScore = row.scoreValue;
    const weight = row.memory_type === "episodic_memory" ? planner.episodicWeight : row.memory_type === "temporal_nodes" ? planner.temporalSummaryWeight : 1;
    current.rrfScore += weight / (60 + index + 1);
    rankAccumulator.set(key, current);
  }

  for (let index = 0; index < vectorRows.length; index += 1) {
    const row = vectorRows[index];
    const key = resultKey(row);
    const current = rankAccumulator.get(key) ?? { row, rrfScore: 0 };
    current.row = row;
    current.vectorRank = index + 1;
    current.vectorDistance = row.scoreValue;
    current.rrfScore += 1 / (60 + index + 1);
    rankAccumulator.set(key, current);
  }

  const rankedResults = [...rankAccumulator.values()]
    .sort((left, right) => {
      const scoreDelta = right.rrfScore - left.rrfScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const priorityDelta =
        memoryTypePriority(left.row.memory_type, hasTimeWindow, planner.temporalFocus) -
        memoryTypePriority(right.row.memory_type, hasTimeWindow, planner.temporalFocus);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }

      return resultKey(left.row).localeCompare(resultKey(right.row));
    });

  const results = pruneRankedResults(rankedResults, planner, relationshipExactFocus, precisionLexicalFocus, narrowTemporalWindow)
    .slice(0, limit)
    .map((row) =>
      buildRecallResult(row.row, row.rrfScore, {
        rrfScore: row.rrfScore,
        lexicalRank: row.lexicalRank,
        vectorRank: row.vectorRank,
        lexicalRawScore: row.lexicalRawScore,
        vectorDistance: row.vectorDistance
      })
    );

  return {
    results,
    meta: {
      retrievalMode: vectorRows.length > 0 ? "hybrid" : "lexical",
      lexicalProvider: lexicalResult.provider,
      lexicalFallbackUsed: lexicalResult.fallbackUsed,
      lexicalFallbackReason: lexicalResult.fallbackReason,
      queryEmbeddingSource: queryEmbeddingResult.source,
      queryEmbeddingProvider: queryEmbeddingResult.provider,
      queryEmbeddingModel: queryEmbeddingResult.model,
      vectorFallbackReason: queryEmbeddingResult.fallbackReason,
      lexicalCandidateCount: lexicalRows.length,
      vectorCandidateCount: vectorRows.length,
      fusedResultCount: results.length,
      temporalAncestorCount: lexicalRows.filter((row) => row.provenance.tier === "temporal_ancestor").length,
      temporalDescendantSupportCount: lexicalRows.filter((row) => row.provenance.tier === "temporal_descendant_support").length,
      temporalGateTriggered: (planner.temporalFocus || hasTimeWindow) ? !hasSufficientTemporalEvidence(lexicalRows, planner) : false,
      planner
    }
  };
}

export async function timelineMemory(query: TimelineQuery): Promise<TimelineResponse> {
  const limit = normalizeLimit(query.limit, 25, 200);
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        et.memory_id AS memory_id,
        'episodic_memory'::text AS memory_type,
        et.content,
        0::double precision AS raw_score,
        et.artifact_id,
        et.occurred_at,
        et.namespace_id,
        jsonb_build_object(
          'tier', 'timeline_episodic',
          'artifact_observation_id', et.artifact_observation_id,
          'source_chunk_id', et.source_chunk_id,
          'source_offset', et.source_offset,
          'source_uri', a.uri,
          'metadata', et.metadata
        ) AS provenance
      FROM episodic_timeline et
      LEFT JOIN artifacts a ON a.id = et.artifact_id
      WHERE et.namespace_id = $1
        AND et.occurred_at >= $2
        AND et.occurred_at <= $3
      ORDER BY et.occurred_at ASC
      LIMIT $4
    `,
    [query.namespaceId, query.timeStart, query.timeEnd, limit]
  );

  return {
    timeline: mapRecallRows(rows)
  };
}

export async function getArtifactDetail(query: ArtifactLookupQuery): Promise<ArtifactDetail | null> {
  const artifactRows = await queryRows<ArtifactRow>(
    `
      SELECT
        id AS artifact_id,
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        created_at,
        last_seen_at,
        metadata
      FROM artifacts
      WHERE id = $1
      LIMIT 1
    `,
    [query.artifactId]
  );

  const artifact = artifactRows[0];
  if (!artifact) {
    return null;
  }

  const observations = await queryRows<ArtifactObservationRow>(
    `
      SELECT
        id AS observation_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      FROM artifact_observations
      WHERE artifact_id = $1
      ORDER BY version DESC
    `,
    [query.artifactId]
  );

  const derivations = await queryRows<ArtifactDerivationRow>(
    `
      SELECT
        ad.id AS derivation_id,
        ad.derivation_type,
        ad.provider,
        ad.model,
        ad.content_text,
        ad.output_dimensionality,
        ad.created_at,
        ad.metadata
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      WHERE ao.artifact_id = $1
      ORDER BY ad.created_at DESC
    `,
    [query.artifactId]
  );

  return {
    artifactId: artifact.artifact_id,
    namespaceId: artifact.namespace_id,
    artifactType: artifact.artifact_type,
    uri: artifact.uri,
    latestChecksumSha256: artifact.latest_checksum_sha256,
    mimeType: artifact.mime_type,
    sourceChannel: artifact.source_channel,
    createdAt: toIsoString(artifact.created_at) ?? "",
    lastSeenAt: toIsoString(artifact.last_seen_at) ?? "",
    metadata: artifact.metadata,
    observations: observations.map<ArtifactObservationSummary>((row) => ({
      observationId: row.observation_id,
      version: row.version,
      checksumSha256: row.checksum_sha256,
      byteSize: row.byte_size,
      observedAt: toIsoString(row.observed_at) ?? "",
      metadata: row.metadata
    })),
    derivations: derivations.map<ArtifactDerivationSummary>((row) => ({
      derivationId: row.derivation_id,
      derivationType: row.derivation_type,
      provider: row.provider,
      model: row.model,
      contentText: row.content_text,
      outputDimensionality: row.output_dimensionality,
      createdAt: toIsoString(row.created_at) ?? "",
      metadata: row.metadata
    }))
  };
}

export async function getRelationships(query: RelationshipQuery): Promise<RelationshipResponse> {
  const limit = normalizeLimit(query.limit);
  const normalizedEntityName = query.entityName.trim().toLowerCase();
  const rows = await queryRows<RelationshipRow>(
    `
      WITH matched_entities AS (
        SELECT e.id
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.normalized_name = $2
        UNION
        SELECT ea.entity_id
        FROM entity_aliases ea
        INNER JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND ea.normalized_alias = $2
      )
      SELECT
        rc.id AS relationship_id,
        subject_entity.canonical_name AS subject_name,
        rc.predicate,
        object_entity.canonical_name AS object_name,
        rc.confidence,
        rc.source_memory_id,
        et.occurred_at,
        rc.namespace_id,
        jsonb_build_object(
          'tier', 'relationship_candidate',
          'status', rc.status,
          'source_chunk_id', rc.source_chunk_id,
          'source_uri', a.uri,
          'source_offset', et.source_offset,
          'metadata', rc.metadata
        ) AS provenance
      FROM relationship_candidates rc
      INNER JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
      INNER JOIN entities object_entity ON object_entity.id = rc.object_entity_id
      LEFT JOIN episodic_timeline et ON et.memory_id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = et.artifact_id
      WHERE rc.namespace_id = $1
        AND rc.status IN ('pending', 'accepted')
        AND ($3::text IS NULL OR rc.predicate = $3)
        AND ($4::timestamptz IS NULL OR et.occurred_at >= $4)
        AND ($5::timestamptz IS NULL OR et.occurred_at <= $5)
        AND (
          rc.subject_entity_id IN (SELECT id FROM matched_entities)
          OR rc.object_entity_id IN (SELECT id FROM matched_entities)
          OR EXISTS (
            SELECT 1
            FROM memory_entity_mentions mem
            WHERE mem.source_memory_id = rc.source_memory_id
              AND mem.entity_id IN (SELECT id FROM matched_entities)
          )
        )
      ORDER BY rc.confidence DESC, et.occurred_at DESC NULLS LAST
      LIMIT $6
    `,
    [query.namespaceId, normalizedEntityName, query.predicate ?? null, query.timeStart ?? null, query.timeEnd ?? null, limit]
  );

  return {
    relationships: rows.map<RelationshipResult>((row) => ({
      relationshipId: row.relationship_id,
      subjectName: row.subject_name,
      predicate: row.predicate,
      objectName: row.object_name,
      confidence: toNumber(row.confidence),
      sourceMemoryId: row.source_memory_id,
      occurredAt: toIsoString(row.occurred_at),
      namespaceId: row.namespace_id,
      provenance: row.provenance
    }))
  };
}
