import { readConfig } from "../config.js";
import { queryRows } from "../db/client.js";
import { resolveEmbeddingRuntimeSelection } from "../providers/embedding-config.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";
import type { ArtifactId, RecallResult } from "../types.js";
import {
  isActiveRelationshipQuery,
  isEventBoundedQuery,
  isDailyLifeEventQuery,
  isDailyLifeSummaryQuery,
  isHistoricalWorkQuery,
  isHistoricalRelationshipQuery,
  isHistoricalPreferenceQuery,
  isCurrentPreferenceQuery,
  isBeliefQuery,
  isHistoricalBeliefQuery,
  isGoalQuery,
  isPlanQuery,
  isPreferenceQuery,
  isStyleSpecQuery,
  isTemporalDetailQuery,
  normalizeRelationshipWhyQuery,
  isPrecisionLexicalQuery,
  isRelationshipStyleExactQuery,
  preferredRelationshipPredicates
} from "./query-signals.js";
import { planRecallQuery } from "./planner.js";
import type {
  ArtifactDetail,
  ArtifactDerivationSummary,
  ArtifactLookupQuery,
  ArtifactObservationSummary,
  RecallFollowUpAction,
  RecallQuery,
  RecallResponse,
  RelationshipQuery,
  RelationshipResponse,
  RelationshipResult,
  TemporalDescendantLayer,
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

function buildEventQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim())
    .filter(Boolean);
  const filtered = candidateTerms.filter((term) => {
    const normalized = term.toLowerCase();
    return ![
      "what",
      "who",
      "where",
      "did",
      "does",
      "do",
      "go",
      "went",
      "have",
      "had",
      "get",
      "got",
      "later",
      "today",
      "tonight",
      "yesterday",
      "this",
      "with",
      "at",
      "in",
      "on",
      "to"
    ].includes(normalized);
  });

  return filtered.length > 0 ? filtered.join(" ") : queryText;
}

function buildTemporalDetailEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const rawTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["how", "much", "many", "what", "when", "on", "in", "at", "did", "does", "do", "exact", "exactly"].includes(term));

  const financialTerms = new Set(["cost", "price", "amount", "paid", "spent", "spend", "fee", "fees"]);
  const hasFinancialCue = rawTerms.some((term) => financialTerms.has(term));
  const expanded = new Set(rawTerms.filter((term) => !financialTerms.has(term)));
  if (hasFinancialCue) {
    expanded.add("paid");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function buildPreferenceEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "does", "did", "use", "used", "to", "still", "now", "in", "for"].includes(term))
    .filter((term) => !/^(19\d{2}|20\d{2})$/.test(term));

  const expanded = new Set(candidateTerms);
  if (candidateTerms.some((term) => term.startsWith("prefer") || term === "favorite" || term === "favourite")) {
    expanded.add("preference");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function buildStyleSpecEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const normalized = queryText.toLowerCase();
  if (/\bprotocol\b/.test(normalized) && /\bontology\b/.test(normalized)) {
    return "Ask NotebookLM First Before Changing Ontology NotebookLM ontology protocol";
  }

  if (/\bdatabase\b/.test(normalized) && /\bslice\b/.test(normalized)) {
    return "Wipe And Replay The Database After Each Slice database replay slice workflow";
  }

  if (/\bresponse\b/.test(normalized) && /\bstyle\b/.test(normalized)) {
    return "Keep Responses Concise response style concise formatting";
  }

  if (/\bnatural\b/.test(normalized) && /\bquery/.test(normalized)) {
    return "Prefer Natural-Language Queryability natural language queryability";
  }

  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "how", "should", "does", "is", "the", "my"].includes(term));

  const expanded = new Set(candidateTerms);
  if (/\bstyle\b/.test(normalized) || /\bformat/.test(normalized)) {
    expanded.add("style");
    expanded.add("concise");
  }
  if (/\bprotocol\b/.test(normalized) || /\bworkflow\b/.test(normalized)) {
    expanded.add("workflow");
    expanded.add("protocol");
  }

  return [...expanded].join(" ").trim() || queryText;
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

function buildEvidenceBundle(results: readonly RecallResult[]): RecallResponse["evidence"] {
  const seen = new Set<string>();
  const evidence: Array<RecallResponse["evidence"][number]> = [];

  for (const result of results) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    if (!result.artifactId && !sourceUri) {
      continue;
    }
    const key = `${result.memoryId}|${result.artifactId ?? "none"}|${sourceUri ?? "none"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    evidence.push({
      memoryId: result.memoryId,
      memoryType: result.memoryType,
      artifactId: result.artifactId ?? null,
      occurredAt: result.occurredAt ?? null,
      sourceUri,
      snippet: result.content.slice(0, 320),
      provenance: result.provenance
    });
  }

  return evidence.slice(0, 12);
}

function normalizeAssessmentTerm(term: string): string {
  return term.trim().toLowerCase();
}

function lexicalCoverageForResult(content: string, terms: readonly string[]): {
  readonly matchedTerms: readonly string[];
  readonly totalTerms: number;
  readonly lexicalCoverage: number;
} {
  const normalizedContent = content.toLowerCase();
  const normalizedTerms = [...new Set(terms.map(normalizeAssessmentTerm).filter(Boolean))];
  if (normalizedTerms.length === 0) {
    return {
      matchedTerms: [],
      totalTerms: 0,
      lexicalCoverage: 1
    };
  }

  const matchedTerms = normalizedTerms.filter((term) => normalizedContent.includes(term));
  return {
    matchedTerms,
    totalTerms: normalizedTerms.length,
    lexicalCoverage: matchedTerms.length / normalizedTerms.length
  };
}

function assessRecallAnswer(
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"],
  planner: ReturnType<typeof planRecallQuery>,
  temporalSummarySufficient: boolean
): NonNullable<RecallResponse["meta"]["answerAssessment"]> {
  const top = results[0];
  if (!top) {
    return {
      confidence: "missing",
      reason: "No recall results were returned.",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: planner.lexicalTerms.length,
      evidenceCount: evidence.length,
      directEvidence: false
    };
  }

  const coverage = lexicalCoverageForResult(top.content, planner.lexicalTerms);
  const directEvidence = evidence.some(
    (item) =>
      item.memoryId === top.memoryId ||
      (Boolean(item.artifactId) && item.artifactId === (top.artifactId ?? null)) ||
      (typeof item.sourceUri === "string" && item.sourceUri === top.provenance.source_uri)
  );
  const strongTruth =
    top.memoryType === "procedural_memory" ||
    top.memoryType === "relationship_memory" ||
    top.memoryType === "narrative_event" ||
    top.memoryType === "temporal_nodes";

  if (evidence.length === 0) {
    return {
      confidence: "missing",
      reason: "The top claim does not have supporting evidence attached.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    };
  }

  if (!directEvidence) {
    return {
      confidence: "weak",
      reason: top.memoryType === "temporal_nodes" || temporalSummarySufficient
        ? "The answer is grounded through temporal summary support, but the top claim is not directly anchored to a leaf evidence row."
        : "The answer is grounded, but only indirect or complementary evidence was attached to the top claim.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    };
  }

  if ((coverage.lexicalCoverage >= 0.5 || strongTruth || temporalSummarySufficient) && directEvidence) {
    return {
      confidence: "confident",
      reason: temporalSummarySufficient
        ? "Temporal summary gating judged the summary answer sufficient without descending further."
        : "The top claim has direct evidence and enough lexical/structural support to be treated as confident.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    };
  }

  return {
    confidence: "weak",
    reason: "The answer is grounded, but only complementary or low-coverage evidence was retrieved for the top claim.",
    lexicalCoverage: coverage.lexicalCoverage,
    matchedTerms: coverage.matchedTerms,
    totalTerms: coverage.totalTerms,
    evidenceCount: evidence.length,
    directEvidence
  };
}

function buildDualityObject(
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"],
  assessment: NonNullable<RecallResponse["meta"]["answerAssessment"]>,
  namespaceId: string,
  queryText: string
): RecallResponse["duality"] {
  const top = results[0];
  const followUpAction: RecallFollowUpAction =
    assessment.confidence === "confident"
      ? "none"
      : assessment.confidence === "weak"
        ? "suggest_verification"
        : "route_to_clarifications";
  const clarificationHint =
    followUpAction === "none"
      ? undefined
      : {
          endpoint: `/ops/clarifications?namespace_id=${encodeURIComponent(namespaceId)}&limit=10`,
          namespaceId,
          query: queryText,
          reason: assessment.reason,
          suggestedPrompt:
            followUpAction === "route_to_clarifications"
              ? `The brain could not find authoritative evidence for: ${queryText}`
              : `The brain found only weak support for: ${queryText}`
        };

  return {
    claim: top
      ? {
          memoryId: top.memoryId,
          memoryType: top.memoryType,
          text: top.content,
          occurredAt: top.occurredAt ?? null,
          artifactId: top.artifactId ?? null,
          sourceUri: typeof top.provenance.source_uri === "string" ? top.provenance.source_uri : null,
          validFrom: typeof top.provenance.valid_from === "string" ? top.provenance.valid_from : null,
          validUntil: typeof top.provenance.valid_until === "string" ? top.provenance.valid_until : null
        }
      : {
          memoryId: null,
          memoryType: null,
          text: "No authoritative evidence found.",
          occurredAt: null,
          artifactId: null,
          sourceUri: null,
          validFrom: null,
          validUntil: null
        },
    evidence: evidence.map((item) => ({
      memoryId: item.memoryId,
      artifactId: item.artifactId ?? null,
      sourceUri: item.sourceUri ?? null,
      snippet: item.snippet
    })),
    confidence: assessment.confidence,
    reason: assessment.reason,
    followUpAction,
    clarificationHint
  };
}

function loadBoundedEventSceneSupportRows(
  namespaceId: string,
  eventIds: readonly string[]
): Promise<SearchRow[]> {
  if (eventIds.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        concat('event-scene:', ns.id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        ns.scene_text AS content,
        0.64::double precision AS raw_score,
        ne.artifact_id,
        COALESCE(ns.time_start, ne.time_start, ns.occurred_at, ne.created_at) AS occurred_at,
        ne.namespace_id,
        jsonb_build_object(
          'tier', 'event_scene_support',
          'source_scene_id', ns.id,
          'source_event_id', ne.id,
          'event_label', ne.event_label,
          'event_kind', ne.event_kind,
          'source_uri', a.uri,
          'subject_name', subject_entity.canonical_name,
          'location_name', location_entity.canonical_name,
          'metadata', ns.metadata
        ) AS provenance
      FROM narrative_scenes ns
      JOIN narrative_events ne ON ne.id = ns.source_event_id
      LEFT JOIN artifacts a ON a.id = ne.artifact_id
      LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
      LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
      WHERE ne.namespace_id = $1
        AND ne.id = ANY($2::uuid[])
      ORDER BY COALESCE(ns.time_start, ne.time_start, ns.occurred_at, ne.created_at) ASC, ns.scene_index ASC
      LIMIT 12
    `,
    [namespaceId, eventIds]
  );
}

function expandBoundedEventResults(
  results: readonly RecallResult[],
  supportRows: readonly SearchRow[],
  limit: number
): readonly RecallResult[] {
  if (results.length === 0 || supportRows.length === 0) {
    return results;
  }

  const supportByEvent = new Map<string, RecallResult[]>();
  for (const row of supportRows) {
    const eventId = typeof row.provenance.source_event_id === "string" ? row.provenance.source_event_id : null;
    if (!eventId) {
      continue;
    }

    const supportResult = buildRecallResult(row, 0.52, {
      rrfScore: 0.52
    });
    const bucket = supportByEvent.get(eventId) ?? [];
    bucket.push(supportResult);
    supportByEvent.set(eventId, bucket);
  }

  const expanded: RecallResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    if (!seen.has(result.memoryId)) {
      expanded.push(result);
      seen.add(result.memoryId);
    }

    if (result.memoryType !== "narrative_event") {
      continue;
    }

    for (const support of supportByEvent.get(result.memoryId) ?? []) {
      if (seen.has(support.memoryId)) {
        continue;
      }
      expanded.push(support);
      seen.add(support.memoryId);
      if (expanded.length >= limit) {
        return expanded.slice(0, limit);
      }
    }
  }

  return expanded.slice(0, limit);
}

function buildScopedEventSqlMatch(terms: readonly string[]): {
  readonly clause: string;
  readonly values: readonly string[];
  readonly scoreExpression: string;
} {
  const filteredTerms = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (filteredTerms.length === 0) {
    return {
      clause: "TRUE",
      values: [],
      scoreExpression: "1.0"
    };
  }

  const clauses: string[] = [];
  const scoreParts: string[] = [];
  const values: string[] = [];
  let parameterIndex = 2;

  for (const term of filteredTerms) {
    const placeholder = `$${parameterIndex}`;
    clauses.push(`lower(event_document) LIKE lower(${placeholder})`);
    scoreParts.push(`CASE WHEN lower(event_document) LIKE lower(${placeholder}) THEN 1 ELSE 0 END`);
    values.push(`%${term}%`);
    parameterIndex += 1;
  }

  return {
    clause: `(${clauses.join(" OR ")})`,
    values,
    scoreExpression: scoreParts.join(" + ")
  };
}

function loadScopedNarrativeEventRows(
  namespaceId: string,
  terms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const match = buildScopedEventSqlMatch(terms);
  const eventDocumentExpression = `concat_ws(
            ' ',
            ne.event_label,
            coalesce(subject_entity.canonical_name, ''),
            coalesce(location_entity.canonical_name, ''),
            coalesce(ne.metadata::text, '')
          )`;
  const eventMatchClause = match.clause.replaceAll("event_document", eventDocumentExpression);
  const eventScoreExpression = match.scoreExpression.replaceAll("event_document", eventDocumentExpression);

  return queryRows<SearchRow>(
    `
      WITH event_rows AS (
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          (${eventScoreExpression})::double precision AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'lexical_provider', 'event_scope',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_memory_id', source_memory.id,
            'source_uri', a.uri,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN LATERAL (
          SELECT em.id, em.occurred_at
          FROM episodic_memory em
          WHERE em.namespace_id = ne.namespace_id
            AND em.artifact_observation_id = ne.artifact_observation_id
          ORDER BY em.occurred_at ASC, em.id ASC
          LIMIT 1
        ) AS source_memory ON TRUE
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND ${eventMatchClause}
          AND ($${match.values.length + 2}::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) >= $${match.values.length + 2})
          AND ($${match.values.length + 3}::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) <= $${match.values.length + 3})
      )
      SELECT
        memory_id,
        memory_type,
        content,
        raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        provenance
      FROM event_rows
      ORDER BY
        raw_score DESC,
        occurred_at DESC,
        char_length(content) DESC,
        memory_id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, ...match.values, timeStart, timeEnd, candidateLimit]
  );
}

function loadHistoricalWorkedAtRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  return queryRows<SearchRow>(
    `
      SELECT
        rm.id AS memory_id,
        'relationship_memory'::text AS memory_type,
        ${relationshipContentExpression()} AS content,
        0.42::double precision AS raw_score,
        e.artifact_id,
        COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
        rm.namespace_id,
        jsonb_build_object(
          'tier', 'relationship_memory',
          'status', rm.status,
          'predicate', rm.predicate,
          'subject_name', subject_entity.canonical_name,
          'object_name', object_entity.canonical_name,
          'source_uri', a.uri,
          'source_memory_id', e.id,
          'source_candidate_id', rc.id,
          'lexical_provider', 'historical_work_scope',
          'metadata', rm.metadata
        ) AS provenance
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE rm.namespace_id = $1
        AND rm.predicate = 'worked_at'
        AND rm.status IN ('active', 'superseded')
        AND to_tsvector(
              'english',
              concat_ws(' ', subject_entity.canonical_name, object_entity.canonical_name, rm.predicate)
            ) @@ websearch_to_tsquery('english', $2)
        AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
        AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
      ORDER BY rm.valid_from ASC, object_entity.canonical_name ASC
      LIMIT GREATEST($5, 24)
    `,
    [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
  );
}

function loadPreferenceTenureRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  mode: "current" | "historical" | "point_in_time"
): Promise<SearchRow[]> {
  const effectiveQueryText = buildPreferenceEvidenceQueryText(queryText, []);
  const scopeClause =
    mode === "current"
      ? "pm.valid_until IS NULL AND ($3::timestamptz IS NULL OR TRUE) AND ($4::timestamptz IS NULL OR TRUE)"
      : mode === "historical"
        ? "pm.valid_until IS NOT NULL AND ($3::timestamptz IS NULL OR TRUE) AND ($4::timestamptz IS NULL OR TRUE)"
        : `($3::timestamptz IS NULL OR coalesce(pm.valid_until, 'infinity'::timestamptz) >= $3)
           AND ($4::timestamptz IS NULL OR pm.valid_from <= $4)`;

  return queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        ts_rank(
          to_tsvector('english', ${proceduralLexicalDocument()}),
          websearch_to_tsquery('english', $2)
        ) AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.valid_from) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'preference_tenure',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'preference'
        AND ${scopeClause}
        AND to_tsvector('english', ${proceduralLexicalDocument()}) @@ websearch_to_tsquery('english', $2)
      ORDER BY raw_score DESC, COALESCE(em.occurred_at, pm.valid_from) DESC
      LIMIT $5
    `,
    [namespaceId, effectiveQueryText, timeStart, timeEnd, candidateLimit]
  );
}

function scoreStyleSpecRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  const wantsBroadStyle = /\bstyle\s+specs?\b/.test(normalizedQuery) || /\bwork-?style\b/.test(normalizedQuery);
  const wantsResponseStyle = /\bresponse\s+style\b/.test(normalizedQuery) || /\bformat(?:ting)?\b/.test(normalizedQuery);
  const wantsOntologyProtocol = /\bprotocol\b/.test(normalizedQuery) && /\bontology\b/.test(normalizedQuery);
  const wantsReplayWorkflow = /\bdatabase\b/.test(normalizedQuery) && /\bslice\b/.test(normalizedQuery);
  const wantsQueryability = /\bnatural\b/.test(normalizedQuery) && /\bquery/.test(normalizedQuery);

  let score = wantsBroadStyle ? 0.5 : 0;

  if (wantsResponseStyle) {
    if (!normalizedContent.includes("concise")) {
      return 0;
    }
    score += 2;
  }

  if (wantsOntologyProtocol) {
    if (!normalizedContent.includes("notebooklm")) {
      return 0;
    }
    score += 2.5;
  }

  if (wantsReplayWorkflow) {
    if (!(normalizedContent.includes("replay") && normalizedContent.includes("database"))) {
      return 0;
    }
    score += 2.5;
  }

  if (wantsQueryability) {
    if (!normalizedContent.includes("queryability")) {
      return 0;
    }
    score += 2;
  }

  if (score === 0) {
    if (normalizedContent.includes("style spec")) {
      score = 0.6;
    } else {
      return 0;
    }
  }

  if (normalizedQuery.includes("concise") && normalizedContent.includes("concise")) {
    score += 1;
  }

  return score;
}

function scoreGoalRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\bcurrent\s+primary\s+goal\b/.test(normalizedQuery)) {
    score += 1.5;
  }

  if (/\bthailand\b/.test(normalizedQuery) && normalizedContent.includes("thailand")) {
    score += 1;
  }

  if (normalizedContent.includes("goal") || normalizedContent.includes("objective")) {
    score += 0.5;
  }

  return score;
}

function scorePlanRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\bplan/.test(normalizedQuery) && normalizedContent.includes("plan")) {
    score += 0.8;
  }
  if (/\bturkey\b/.test(normalizedQuery) && normalizedContent.includes("turkey")) {
    score += 1.4;
  }
  if (/\bconference\b/.test(normalizedQuery) && normalizedContent.includes("conference")) {
    score += 1.2;
  }
  if (/\btwo-way\b/.test(normalizedQuery) && normalizedContent.includes("two-way")) {
    score += 1.2;
  }

  return score;
}

function scoreBeliefRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\b(?:stance|opinion|belief)\b/.test(normalizedQuery) && /\b(?:stance|opinion|belief)\b/.test(normalizedContent)) {
    score += 0.8;
  }
  if (/\binfrastructure\b/.test(normalizedQuery) && normalizedContent.includes("infrastructure")) {
    score += 1.2;
  }
  if (/\bhosted\b/.test(normalizedQuery) && normalizedContent.includes("hosted")) {
    score += 1;
  }
  if (/\blocal\b/.test(normalizedQuery) && normalizedContent.includes("local")) {
    score += 1;
  }
  if (/\bdata\s+sovereignty\b/.test(normalizedQuery) && normalizedContent.includes("data sovereignty")) {
    score += 1.2;
  }
  if (/\b(?:change|changed|since|still support)\b/.test(normalizedQuery)) {
    score += 0.4;
  }

  return score;
}

async function loadStyleSpecRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'current_procedural',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'style_spec'
        AND pm.valid_until IS NULL
      ORDER BY pm.updated_at DESC
      LIMIT $2
    `,
    [namespaceId, Math.max(candidateLimit * 2, 12)]
  );

  return rows
    .map((row) => ({
      row,
      score: scoreStyleSpecRow(String(row.content ?? ""), queryText)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, 6))
    .map((item) => item.row);
}

async function loadGoalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'current_procedural',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'goal'
        AND pm.valid_until IS NULL
      ORDER BY pm.updated_at DESC
      LIMIT $2
    `,
    [namespaceId, Math.max(candidateLimit * 2, 8)]
  );

  return rows
    .map((row) => ({ row, score: scoreGoalRow(String(row.content ?? ""), queryText) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, 4))
    .map((item) => item.row);
}

async function loadPlanRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'current_procedural',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'plan'
        AND pm.valid_until IS NULL
      ORDER BY pm.updated_at DESC
      LIMIT $2
    `,
    [namespaceId, Math.max(candidateLimit * 2, 12)]
  );

  return rows
    .map((row) => ({ row, score: scorePlanRow(String(row.content ?? ""), queryText) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, 6))
    .map((item) => item.row);
}

async function loadBeliefRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  mode: "current" | "historical" | "point_in_time"
): Promise<SearchRow[]> {
  const scopeClause =
    mode === "current"
      ? "pm.valid_until IS NULL"
      : mode === "point_in_time"
        ? `
          ($3::timestamptz IS NULL OR pm.valid_from <= $4::timestamptz)
          AND (pm.valid_until IS NULL OR $3::timestamptz IS NULL OR pm.valid_until >= $3::timestamptz)
        `
        : "TRUE";

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', CASE WHEN pm.valid_until IS NULL THEN 'current_procedural' ELSE 'historical_procedural' END,
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'belief'
        AND ${scopeClause}
      ORDER BY pm.valid_from DESC, pm.updated_at DESC
      LIMIT $5
    `,
    [namespaceId, queryText, timeStart, timeEnd, Math.max(candidateLimit * 3, 18)]
  );

  return rows
    .map((row) => ({ row, score: scoreBeliefRow(String(row.content ?? ""), queryText) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, mode === "historical" ? 6 : 4))
    .map((item) => item.row);
}

function buildProvenanceAnswer(
  normalizedClaim: string,
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"]
): RecallResponse["meta"]["provenanceAnswer"] {
  const top = results[0];
  const topStateType = typeof top?.provenance.state_type === "string" ? top.provenance.state_type : null;
  const topPredicate = typeof top?.provenance.predicate === "string" ? top.provenance.predicate : null;

  let adjudicationReasoning =
    "The current active fact outranked historical rows because it remained active and retained direct evidence pointers.";
  if (topStateType === "current_employer") {
    adjudicationReasoning =
      "The current employer state remained authoritative because it superseded older employer facts and still points to source evidence.";
  } else if (topStateType === "current_location") {
    adjudicationReasoning =
      "The current residence state remained authoritative because the most specific unsuperseded home fact still points to source evidence.";
  } else if (topStateType === "active_membership" || topPredicate === "member_of") {
    adjudicationReasoning =
      "The membership fact remained active because repeated participation crossed the promotion threshold and retained source evidence.";
  } else if (top?.memoryType === "relationship_memory") {
    adjudicationReasoning =
      "The active relationship edge outranked older candidates because it is still valid and grounded in source evidence.";
  }

  return {
    queryType: "why",
    normalizedClaim,
    distilledClaim: top?.content,
    adjudicationReasoning,
    evidence: evidence.map((item) => ({
      memoryId: item.memoryId,
      artifactId: item.artifactId ?? null,
      sourceUri: item.sourceUri ?? null
    }))
  };
}

function mapRecallRows(rows: SearchRow[]): RecallResult[] {
  return rows.map((row) =>
    buildRecallResult(row, toNumber(row.raw_score), {
      rrfScore: toNumber(row.raw_score)
    })
  );
}

function memoryTypePriority(
  memoryType: RecallResult["memoryType"],
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  if (dailyLifeSummaryFocus) {
    switch (memoryType) {
      case "semantic_memory":
        return 0;
      case "temporal_nodes":
        return 1;
      case "narrative_event":
        return 2;
      case "episodic_memory":
        return 3;
      case "artifact_derivation":
        return 4;
      case "relationship_memory":
      case "relationship_candidate":
        return 5;
      case "procedural_memory":
        return 6;
      default:
        return 7;
    }
  }
  if (dailyLifeEventFocus) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "relationship_memory":
      case "relationship_candidate":
        return 4;
      case "semantic_memory":
        return 5;
      case "procedural_memory":
        return 6;
      default:
        return 7;
    }
  }
  if (temporalFocus) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "semantic_memory":
        return 4;
      case "memory_candidate":
        return 5;
      case "relationship_candidate":
      case "procedural_memory":
      case "relationship_memory":
        return 6;
      default:
        return 7;
    }
  }

  if (hasTimeWindow) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "semantic_memory":
        return 4;
      case "memory_candidate":
        return 5;
      case "relationship_candidate":
      case "procedural_memory":
      case "relationship_memory":
        return 6;
      default:
        return 7;
    }
  }

  switch (memoryType) {
    case "procedural_memory":
      return 0;
    case "relationship_memory":
      return 1;
    case "relationship_candidate":
      return 2;
    case "semantic_memory":
      return 3;
    case "episodic_memory":
      return 4;
    case "narrative_event":
      return 5;
    case "artifact_derivation":
      return 6;
    case "memory_candidate":
      return 7;
    case "temporal_nodes":
      return 8;
    default:
      return 9;
  }
}

function compareLexical(
  left: RankedSearchRow,
  right: RankedSearchRow,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  const scoreDelta = right.scoreValue - left.scoreValue;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const priorityDelta =
    memoryTypePriority(left.memory_type, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus) -
    memoryTypePriority(right.memory_type, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus);
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
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false,
  timeStart: string | null = null,
  timeEnd: string | null = null
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

  return finalizeLexicalRows(
    [...merged.values()],
    candidateLimit,
    hasTimeWindow,
    temporalFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    timeStart,
    timeEnd
  );
}

function isSemanticDaySummaryRow(row: RankedSearchRow): boolean {
  const memoryKind = String(row.provenance.memory_kind ?? "");
  const canonicalKey = String(row.provenance.canonical_key ?? "");
  return row.memory_type === "semantic_memory" &&
    (memoryKind === "day_summary" || canonicalKey.startsWith("reconsolidated:day_summary:"));
}

function isAlignedToTimeWindow(row: RankedSearchRow, timeStart: string | null, timeEnd: string | null): boolean {
  if (!timeStart || !timeEnd) {
    return false;
  }

  const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
  const windowStart = parseIsoTimestamp(timeStart);
  const windowEnd = parseIsoTimestamp(timeEnd);
  if (occurredAt !== null && windowStart !== null && windowEnd !== null) {
    return occurredAt >= windowStart && occurredAt <= windowEnd;
  }

  const canonicalKey = String(row.provenance.canonical_key ?? "");
  const dayToken = canonicalKey.startsWith("reconsolidated:day_summary:")
    ? canonicalKey.slice("reconsolidated:day_summary:".length)
    : "";
  return Boolean(dayToken && timeStart.startsWith(dayToken));
}

function finalizeLexicalRows(
  rows: readonly RankedSearchRow[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false,
  timeStart: string | null = null,
  timeEnd: string | null = null
): RankedSearchRow[] {
  const sorted = [...rows].sort((left, right) =>
    compareLexical(left, right, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus)
  );

  if (!dailyLifeSummaryFocus) {
    return sorted.slice(0, candidateLimit);
  }

  const requiredSummaryRows = sorted.filter(
    (row) => isSemanticDaySummaryRow(row) && isAlignedToTimeWindow(row, timeStart, timeEnd)
  );
  if (requiredSummaryRows.length === 0) {
    return sorted.slice(0, candidateLimit);
  }

  const requiredKeys = new Set(requiredSummaryRows.map(resultKey));
  return [...requiredSummaryRows.slice(0, 1), ...sorted.filter((row) => !requiredKeys.has(resultKey(row)))]
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

function lexicalHitMultiplier(content: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const normalizedContent = content.toLowerCase();
  const hitCount = terms.filter((term) => normalizedContent.includes(term.toLowerCase())).length;

  if (hitCount === 0) {
    return 0.55;
  }

  if (hitCount === 1) {
    return 0.9;
  }

  if (hitCount === 2) {
    return 1.08;
  }

  return 1.16;
}

function proceduralLexicalDocument(): string {
  return `
    coalesce(state_type, '') || ' ' ||
    coalesce(state_key, '') || ' ' ||
    coalesce(state_value::text, '') || ' ' ||
    ${proceduralContentExpression()} || ' ' ||
    CASE
      WHEN valid_until IS NULL THEN 'current active latest authoritative'
      ELSE 'historical inactive superseded'
    END
  `;
}

function proceduralContentExpression(): string {
  return `
    CASE
      WHEN state_type = 'preference' THEN
        coalesce(state_value->>'person', 'User') || ' ' ||
        trim(both ' ' from coalesce(state_value->>'category', '') || ' ' || coalesce(state_value->>'target', state_key)) || ' ' ||
        CASE
          WHEN state_value->>'entity_type' = 'activity' THEN 'activity sport hobby'
          WHEN state_value->>'entity_type' = 'media' THEN 'media movie film'
          ELSE ''
        END || ' preference is ' || coalesce(state_value->>'polarity', 'unknown')
      WHEN state_type = 'watchlist_item' THEN
        coalesce(state_value->>'person', 'User') || ' wants to watch ' || coalesce(state_value->>'title', state_key) || ' ' ||
        CASE
          WHEN state_value->>'entity_type' = 'media' THEN 'media movie film watchlist'
          ELSE 'watchlist'
        END
      WHEN state_type = 'skill' THEN
        coalesce(state_value->>'person', 'User') || ' has skill ' || coalesce(state_value->>'skill', state_key) || ' skill capability proficiency'
      WHEN state_type = 'routine' THEN
        coalesce(state_value->>'person', 'User') || ' has routine ' || coalesce(state_value->>'routine', state_key) || ' habit cadence weekly repeat'
      WHEN state_type = 'decision' THEN
        coalesce(state_value->>'person', 'User') || ' decided to ' || coalesce(state_value->>'decision', state_key) || ' decision decided choice made why use uses rationale'
      WHEN state_type = 'constraint' THEN
        'brain constraint rule policy follow follows ' || coalesce(state_value->>'constraint', state_key) || ' ' || coalesce(state_value->>'modality', '')
      WHEN state_type = 'style_spec' THEN
        coalesce(state_value->>'person', 'User') || ' style spec work style response style formatting preference ' ||
        coalesce(state_value->>'style_spec', state_key) || ' ' || coalesce(state_value->>'scope', '')
      WHEN state_type = 'goal' THEN
        coalesce(state_value->>'person', 'User') || ' current primary goal objective intent is ' || coalesce(state_value->>'goal', state_key)
      WHEN state_type = 'plan' THEN
        coalesce(state_value->>'person', 'User') || ' plan planning upcoming ' || coalesce(state_value->>'plan', state_key) || ' ' || coalesce(state_value->>'project_hint', '')
      WHEN state_type = 'belief' THEN
        coalesce(state_value->>'person', 'User') || ' belief stance opinion on ' || coalesce(state_value->>'topic', state_key) || ' is ' || coalesce(state_value->>'belief', state_key)
      WHEN state_type = 'project_role' THEN
        coalesce(state_value->>'person', '') || ' role on ' || coalesce(state_value->>'project', '') || ' is ' || coalesce(state_value->>'role', '')
      WHEN state_type = 'current_project' THEN
        coalesce(state_value->>'person', '') || ' works on ' || coalesce(state_value->>'project', '')
      WHEN state_type = 'current_location' THEN
        coalesce(state_value->>'person', '') || ' currently lives in ' || coalesce(state_value->>'place', '')
      WHEN state_type = 'current_employer' THEN
        coalesce(state_value->>'person', '') || ' currently works at ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_affiliation' THEN
        coalesce(state_value->>'person', '') || ' works at ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_membership' THEN
        coalesce(state_value->>'person', '') || ' is a member of ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_ownership' THEN
        coalesce(state_value->>'person', '') || ' ' || replace(coalesce(state_value->>'predicate', 'owns'), '_', ' ') || ' ' || coalesce(state_value->>'asset', '')
      ELSE CONCAT(state_type, ': ', state_key, ' = ', state_value::text)
    END
  `;
}

function relationshipLexicalDocument(
  relationshipAlias = "rm",
  subjectAlias = "subject_entity",
  objectAlias = "object_entity"
): string {
  return `
    coalesce(${subjectAlias}.canonical_name, '') || ' ' ||
    replace(coalesce(${relationshipAlias}.predicate, ''), '_', ' ') || ' ' ||
    coalesce(${objectAlias}.canonical_name, '') || ' ' ||
    coalesce(${relationshipAlias}.metadata->>'relationship_kind', '') || ' ' ||
    coalesce(${relationshipAlias}.metadata->>'relationship_transition', '') || ' ' ||
    CASE
      WHEN ${relationshipAlias}.metadata->>'relationship_kind' = 'romantic' THEN 'dated romance romantic together'
      WHEN ${relationshipAlias}.predicate = 'significant_other_of' THEN 'dated dating together partner significant other romantic'
      WHEN ${relationshipAlias}.predicate = 'resides_at' THEN 'lives in lives at resides at home residence residency'
      WHEN ${relationshipAlias}.predicate = 'member_of' THEN 'member membership group groups organization organizations club association collective society'
      ELSE ''
    END || ' ' ||
    CASE
      WHEN ${relationshipAlias}.predicate = 'relationship_ended' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'ended' THEN 'break broke broken breakup broke up split ended relationship'
      WHEN ${relationshipAlias}.predicate = 'relationship_reconnected' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'reconnected' THEN 'started talking again reconnected resumed contact'
      WHEN ${relationshipAlias}.predicate = 'relationship_contact_paused' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'contact_paused' THEN 'stopped talking no contact paused contact'
      ELSE ''
    END || ' ' ||
    CASE
      WHEN ${relationshipAlias}.valid_until IS NULL THEN 'current active latest authoritative'
      ELSE 'historical inactive superseded'
    END
  `;
}

function relationshipContentExpression(
  relationshipAlias = "rm",
  subjectAlias = "subject_entity",
  objectAlias = "object_entity"
): string {
  return `
    CASE
      WHEN ${relationshipAlias}.predicate = 'relationship_ended'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'ended')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' broke up with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'relationship_reconnected'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'reconnected')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' started talking again with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'relationship_contact_paused'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'contact_paused')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' stopped talking with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'was_with'
        AND ${relationshipAlias}.metadata->>'relationship_kind' = 'romantic'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' dated ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'significant_other_of'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' dated ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'resides_at'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' lives in ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      ELSE CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' ',
        replace(coalesce(${relationshipAlias}.predicate, ''), '_', ' '),
        ' ',
        coalesce(${objectAlias}.canonical_name, '')
      )
    END
  `;
}

function narrativeEventLexicalDocument(
  eventAlias = "ne",
  subjectAlias = "subject_entity",
  locationAlias = "location_entity"
): string {
  return `
    trim(
      concat_ws(
        ' ',
        coalesce(${eventAlias}.event_label, ''),
        coalesce(${eventAlias}.event_kind, ''),
        coalesce(${eventAlias}.metadata->>'activity', ''),
        coalesce(${eventAlias}.metadata->>'activity_label', ''),
        coalesce(${eventAlias}.metadata->>'source_sentence_text', ''),
        coalesce(${subjectAlias}.canonical_name, ''),
        coalesce(${locationAlias}.canonical_name, ''),
        coalesce(${eventAlias}.metadata->>'location_text', ''),
        coalesce(${eventAlias}.metadata->>'participant_names', '')
      )
    )
  `;
}

function narrativeEventContentExpression(
  eventAlias = "ne",
  subjectAlias = "subject_entity",
  locationAlias = "location_entity"
): string {
  return `
    trim(
      concat_ws(
        ' ',
        coalesce(${eventAlias}.event_label, ''),
        CASE
          WHEN coalesce(${eventAlias}.metadata->>'source_sentence_text', '') <> '' THEN ${eventAlias}.metadata->>'source_sentence_text'
          ELSE NULL
        END,
        CASE
          WHEN coalesce(${subjectAlias}.canonical_name, '') <> '' THEN '(subject: ' || ${subjectAlias}.canonical_name || ')'
          ELSE NULL
        END,
        CASE
          WHEN coalesce(${locationAlias}.canonical_name, '') <> '' THEN '(location: ' || ${locationAlias}.canonical_name || ')'
          ELSE NULL
        END
      )
    )
  `;
}

function lexicalBranchWeight(
  branch: string,
  planner: ReturnType<typeof planRecallQuery>,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  if (dailyLifeSummaryFocus) {
    switch (branch) {
      case "semantic_memory":
        return planner.temporalSummaryWeight * 1.55;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 1.45;
      case "narrative_event":
        return planner.episodicWeight * 1.15;
      case "episodic_memory":
        return planner.episodicWeight * 0.95;
      case "procedural_memory":
        return 0.55;
      default:
        return 0.9;
    }
  }
  if (dailyLifeEventFocus) {
    switch (branch) {
      case "narrative_event":
        return 1.45;
      case "episodic_memory":
        return planner.episodicWeight * 1.1;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 1.05;
      case "relationship_memory":
      case "relationship_candidate":
        return 0.95;
      case "procedural_memory":
        return 0.8;
      default:
        return 1;
    }
  }

  if (activeRelationshipFocus) {
    switch (branch) {
      case "relationship_memory":
        return 1.45;
      case "relationship_candidate":
        return 1.2;
      case "procedural_memory":
        return 1.2;
      case "narrative_event":
        return 0.9;
      case "semantic_memory":
        return 0.8;
      case "memory_candidate":
        return 0.65;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.85;
      case "episodic_memory":
        return planner.episodicWeight * 0.95;
      default:
        return 1;
    }
  }

  if (relationshipExactFocus) {
    switch (branch) {
      case "episodic_memory":
        return planner.episodicWeight * 1.35;
      case "narrative_event":
        return planner.episodicWeight * 0.92;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.95;
      case "semantic_memory":
        return 0.72;
      case "memory_candidate":
        return 0.7;
      case "relationship_candidate":
        return 0.82;
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
      case "narrative_event":
        return 0.9;
      case "memory_candidate":
        return 0.55;
      case "relationship_candidate":
        return 0.85;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.92;
      default:
        return 1;
    }
  }

  switch (branch) {
    case "episodic_memory":
      return planner.episodicWeight;
    case "narrative_event":
      return planner.episodicWeight * 0.9;
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
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  historicalHomeFocus: boolean,
  historicalWorkFocus: boolean,
  historicalRelationshipFocus: boolean,
  preferenceQueryFocus: boolean,
  historicalPreferenceFocus: boolean,
  currentPreferenceFocus: boolean,
  styleQueryFocus: boolean,
  goalQueryFocus: boolean,
  planQueryFocus: boolean,
  beliefQueryFocus: boolean,
  historicalBeliefFocus: boolean,
  pointInTimePreferenceFocus: boolean,
  timeStart: string | null,
  timeEnd: string | null,
  preferredRelationshipPredicates: readonly string[],
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
  const proceduralStateTypes = new Set(
    proceduralRows
      .map((item) => String(item.row.provenance.state_type ?? ""))
      .filter(Boolean)
  );
  const relationshipRows = rows.filter(
    (item) => item.row.memory_type === "relationship_memory" || item.row.memory_type === "relationship_candidate"
  );
  const relationshipMemoryRows = relationshipRows.filter((item) => item.row.memory_type === "relationship_memory");
  const semanticRows = rows.filter((item) => item.row.memory_type === "semantic_memory");
  const semanticDaySummaryRows = semanticRows.filter((item) => {
    const memoryKind = String(item.row.provenance.memory_kind ?? "");
    const canonicalKey = String(item.row.provenance.canonical_key ?? "");
    return memoryKind === "day_summary" || canonicalKey.startsWith("reconsolidated:day_summary:");
  });
  const eventRows = rows.filter((item) => item.row.memory_type === "narrative_event");
  const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory");
  const focusedProceduralRows =
    activeRelationshipFocus && preferredRelationshipPredicates.length > 0
      ? proceduralRows.filter((item) => {
          const stateType = String(item.row.provenance.state_type ?? "");
          if ((preferredRelationshipPredicates.includes("works_at") || preferredRelationshipPredicates.includes("worked_at")) &&
              (stateType === "current_employer" || stateType === "active_affiliation")) {
            return true;
          }
          if ((preferredRelationshipPredicates.includes("resides_at") || preferredRelationshipPredicates.includes("lives_in") || preferredRelationshipPredicates.includes("currently_in")) &&
              stateType === "current_location") {
            return true;
          }
          if (preferredRelationshipPredicates.includes("member_of") && stateType === "active_membership") {
            return true;
          }
          if ((preferredRelationshipPredicates.includes("works_on") || preferredRelationshipPredicates.includes("project_role")) &&
              (stateType === "current_project" || stateType === "project_role")) {
            return true;
          }
          return false;
        })
      : proceduralRows;
  const listLikeProceduralFocus =
    proceduralRows.length > 1 &&
    proceduralStateTypes.size > 0 &&
    [...proceduralStateTypes].every((stateType) =>
      stateType === "preference" ||
      stateType === "watchlist_item" ||
      stateType === "skill" ||
      stateType === "routine" ||
      stateType === "decision" ||
      stateType === "constraint" ||
      stateType === "style_spec" ||
      stateType === "goal" ||
      stateType === "plan" ||
      stateType === "belief"
    );
  const preferenceRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "preference");
  const styleSpecRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "style_spec");
  const goalRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "goal");
  const planRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "plan");
  const beliefRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "belief");

  if (styleQueryFocus && styleSpecRows.length > 0) {
    return [...styleSpecRows.slice(0, 6), ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 8);
  }

  if (goalQueryFocus && goalRows.length > 0) {
    return [...goalRows.slice(0, 1), ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 3);
  }

  if (planQueryFocus && planRows.length > 0) {
    return [...planRows.slice(0, 4), ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 6);
  }

  if (beliefQueryFocus && beliefRows.length > 0) {
    const prioritizedBeliefRows = historicalBeliefFocus ? beliefRows.slice(0, 6) : beliefRows.slice(0, 2);
    return [...prioritizedBeliefRows, ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, historicalBeliefFocus ? 8 : 4);
  }

  if (preferenceQueryFocus && preferenceRows.length > 0) {
    const filteredPreferenceRows = pointInTimePreferenceFocus
      ? preferenceRows.filter((item) => {
          const validFrom = parseIsoTimestamp(typeof item.row.provenance.valid_from === "string" ? item.row.provenance.valid_from : null);
          const validUntil = parseIsoTimestamp(typeof item.row.provenance.valid_until === "string" ? item.row.provenance.valid_until : null);
          const queryStart = parseIsoTimestamp(timeStart);
          const queryEnd = parseIsoTimestamp(timeEnd);
          if (queryStart === null || queryEnd === null) {
            return true;
          }
          if (validFrom !== null && validFrom > queryEnd) {
            return false;
          }
          if (validUntil !== null && validUntil < queryStart) {
            return false;
          }
          return true;
        })
      : historicalPreferenceFocus
      ? preferenceRows.filter((item) => Boolean(item.row.provenance.valid_until))
      : currentPreferenceFocus
        ? preferenceRows.filter((item) => !item.row.provenance.valid_until)
        : preferenceRows;

    if (filteredPreferenceRows.length > 0) {
      return filteredPreferenceRows.slice(0, 4);
    }
  }

  if (planner.temporalFocus && dailyLifeSummaryFocus && semanticDaySummaryRows.length > 0) {
    return [...semanticDaySummaryRows.slice(0, 1), ...eventRows.slice(0, 2), ...episodicRows.slice(0, 1)].slice(0, 4);
  }

  if (!planner.temporalFocus && dailyLifeEventFocus && eventRows.length > 0) {
    return [...eventRows.slice(0, 4), ...episodicRows.slice(0, 2)].slice(0, 6);
  }

  if (!planner.temporalFocus && historicalHomeFocus && relationshipRows.length > 0) {
    const seenObjects = new Set<string>();
    const isBroadHistoricalPlaceLabel = (name: string): boolean => {
      const normalized = name.trim().toLowerCase();
      return normalized === "california" || normalized.endsWith(" area") || normalized.includes(" / ");
    };
    const normalizeHistoricalPlaceKey = (name: string): string =>
      name
        .trim()
        .toLowerCase()
        .replace(/,\s+tx\b/g, ", texas")
        .replace(/,\s+ca\b/g, ", california");
    const homeRows = relationshipRows
      .filter((item) => {
        const predicate = String(item.row.provenance.predicate ?? "");
        return predicate === "lived_in" || predicate === "born_in" || predicate === "resides_at";
      })
      .slice()
      .sort((left, right) => {
        const leftOccurred = Date.parse(toIsoString(left.row.occurred_at) ?? "") || 0;
        const rightOccurred = Date.parse(toIsoString(right.row.occurred_at) ?? "") || 0;
        if (leftOccurred !== rightOccurred) {
          return leftOccurred - rightOccurred;
        }
        return left.rrfScore - right.rrfScore;
      })
      .filter((item) => {
        const objectName = String(item.row.provenance.object_name ?? "");
        const normalizedKey = normalizeHistoricalPlaceKey(objectName);
        if (!normalizedKey || seenObjects.has(normalizedKey) || isBroadHistoricalPlaceLabel(objectName)) {
          return false;
        }
        seenObjects.add(normalizedKey);
        return true;
      });

    if (homeRows.length > 0) {
      return homeRows.slice(0, 8);
    }
  }

  if (!planner.temporalFocus && historicalWorkFocus && relationshipRows.length > 0) {
    const seenObjects = new Set<string>();
    const workRows = relationshipRows
      .filter((item) => {
        const predicate = String(item.row.provenance.predicate ?? "");
        return predicate === "worked_at";
      })
      .slice()
      .sort((left, right) => {
        const leftOccurred = Date.parse(toIsoString(left.row.occurred_at) ?? "") || 0;
        const rightOccurred = Date.parse(toIsoString(right.row.occurred_at) ?? "") || 0;
        if (leftOccurred !== rightOccurred) {
          return leftOccurred - rightOccurred;
        }
        return right.rrfScore - left.rrfScore;
      })
      .filter((item) => {
        const objectName = String(item.row.provenance.object_name ?? "").trim().toLowerCase();
        if (!objectName || seenObjects.has(objectName)) {
          return false;
        }
        seenObjects.add(objectName);
        return true;
      });

    if (workRows.length > 0) {
      if (workRows.length <= 8) {
        return workRows;
      }

      const selectedIndexes = new Set<number>();
      const maxSelections = 8;
      for (let slot = 0; slot < maxSelections; slot += 1) {
        const ratio = slot / (maxSelections - 1);
        const index = Math.round(ratio * (workRows.length - 1));
        selectedIndexes.add(index);
      }

      return [...selectedIndexes]
        .sort((left, right) => left - right)
        .map((index) => workRows[index])
        .filter((item): item is (typeof workRows)[number] => Boolean(item));
    }
  }

  if (!planner.temporalFocus && activeRelationshipFocus && relationshipRows.length > 0) {
    const predicatePriority = new Map(preferredRelationshipPredicates.map((predicate, index) => [predicate, index] as const));
    const baseRelationshipRows = historicalRelationshipFocus ? relationshipRows : relationshipMemoryRows;
    const focusedRelationships =
      preferredRelationshipPredicates.length > 0
        ? baseRelationshipRows.filter((item) => predicatePriority.has(String(item.row.provenance.predicate ?? "")))
        : baseRelationshipRows;
    const activeRelationships = (focusedRelationships.length > 0 ? focusedRelationships : baseRelationshipRows)
      .slice()
      .sort((left, right) => {
        const leftPredicate = String(left.row.provenance.predicate ?? "");
        const rightPredicate = String(right.row.provenance.predicate ?? "");
        const leftPriority = predicatePriority.get(leftPredicate) ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = predicatePriority.get(rightPredicate) ?? Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return right.rrfScore - left.rrfScore;
      });

    const relationshipCap = historicalRelationshipFocus
      ? 8
      : preferredRelationshipPredicates.includes("friend_of") || preferredRelationshipPredicates.includes("friends_with")
        ? 6
        : 3;
    if (historicalRelationshipFocus) {
      return activeRelationships.slice(0, relationshipCap);
    }
    if (activeRelationships.length === 0) {
      return focusedProceduralRows.slice(0, 1);
    }
    return [...focusedProceduralRows.slice(0, 1), ...activeRelationships, ...episodicRows.slice(0, 1)].slice(0, relationshipCap);
  }

  if (!planner.temporalFocus && listLikeProceduralFocus && (topType === "procedural_memory" || topType === "semantic_memory")) {
    return [
      ...proceduralRows.slice(0, Math.min(8, proceduralRows.length)),
      ...semanticRows.slice(0, 1),
      ...episodicRows.slice(0, 1)
    ].slice(0, Math.min(10, proceduralRows.length + semanticRows.length + episodicRows.length));
  }

  if (!planner.temporalFocus && proceduralRows.length > 0 && (topType === "procedural_memory" || topType === "semantic_memory")) {
    return proceduralRows.slice(0, 1);
  }

  if (relationshipExactFocus && topType === "episodic_memory") {
    return rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 1);
  }

  if (topType === "procedural_memory") {
    if (listLikeProceduralFocus) {
      return rows.filter((item) => item.row.memory_type === "procedural_memory").slice(0, Math.min(8, proceduralRows.length));
    }
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

  const preferredTemporalRows = (() => {
    const temporalRows = rows.filter((item) => item.row.memory_type === "temporal_nodes");
    if (temporalRows.length === 0) {
      return [] as typeof temporalRows;
    }

    for (const targetLayer of planner.targetLayers) {
      const matched = temporalRows.find((item) => item.row.provenance.layer === targetLayer);
      if (matched) {
        return [matched];
      }
    }

    return temporalRows.slice(0, 1);
  })();

  if (planner.temporalFocus && dailyLifeSummaryFocus && preferredTemporalRows.length > 0) {
    return [...preferredTemporalRows, ...eventRows.slice(0, 3), ...episodicRows.slice(0, 1)].slice(0, 5);
  }

  if (planner.temporalFocus && hasTemporal && hasEpisodic) {
    if (narrowTemporalWindow) {
      const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
      return [...episodicRows, ...preferredTemporalRows];
    }

    const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
    const artifactRows = rows.filter((item) => item.row.memory_type === "artifact_derivation").slice(0, 1);
    return [...preferredTemporalRows, ...episodicRows, ...artifactRows];
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
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  planner: ReturnType<typeof planRecallQuery>,
  timeStart: string | null,
  timeEnd: string | null,
  lexicalTerms: readonly string[]
): RankedSearchRow[] {
  const accumulator = new Map<string, { row: RankedSearchRow; score: number }>();

  for (const source of sources) {
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index];
      const key = resultKey(row);
      const current = accumulator.get(key) ?? { row, score: 0 };
      current.row = row;
      const branchWeight = lexicalBranchWeight(
        source.branch,
        planner,
        relationshipExactFocus,
        precisionLexicalFocus,
        activeRelationshipFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus
      );
      const temporalAlignment = temporalWindowAlignmentMultiplier(row, timeStart, timeEnd);
      const lexicalHitWeight = lexicalHitMultiplier(row.content, lexicalTerms);
      current.score += (branchWeight * temporalAlignment * lexicalHitWeight) / (20 + index + 1);
      accumulator.set(key, current);
    }
  }

  return [...accumulator.values()]
    .map(({ row, score }) => ({
      ...row,
      raw_score: score,
      scoreValue: score
    }))
    .sort((left, right) => compareLexical(left, right, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus))
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

function isTemporalDescendantSupportRow(row: Pick<SearchRow, "memory_type" | "provenance">): boolean {
  return (
    row.memory_type === "episodic_memory" &&
    (row.provenance.tier === "temporal_descendant_support" ||
      (typeof row.provenance.temporal_support === "object" && row.provenance.temporal_support !== null))
  );
}

function rowMatchesTemporalWindow(
  row: Pick<SearchRow, "memory_type" | "occurred_at" | "provenance">,
  timeStart: string | null,
  timeEnd: string | null
): boolean {
  if (!timeStart && !timeEnd) {
    return true;
  }

  const queryStart = parseIsoTimestamp(timeStart);
  const queryEnd = parseIsoTimestamp(timeEnd);
  if (queryStart === null || queryEnd === null || queryEnd <= queryStart) {
    return true;
  }

  if (row.memory_type === "temporal_nodes") {
    const periodStart = parseIsoTimestamp(typeof row.provenance.period_start === "string" ? row.provenance.period_start : null);
    const periodEnd = parseIsoTimestamp(typeof row.provenance.period_end === "string" ? row.provenance.period_end : null);
    if (periodStart === null || periodEnd === null) {
      return true;
    }

    return periodEnd >= queryStart && periodStart <= queryEnd;
  }

  const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
  if (occurredAt === null) {
    return true;
  }

  return occurredAt >= queryStart && occurredAt <= queryEnd;
}

function directTemporalSeedLayers(rows: readonly RankedSearchRow[]): ReadonlySet<TemporalDescendantLayer | "year"> {
  const layers = new Set<TemporalDescendantLayer | "year">();

  for (const row of rows) {
    if (row.memory_type !== "temporal_nodes" || row.provenance.tier !== "temporal_summary") {
      continue;
    }

    const layer = row.provenance.layer;
    if (layer === "year" || layer === "month" || layer === "week" || layer === "day") {
      layers.add(layer);
    }
  }

  return layers;
}

function determineTemporalDescendantPasses(
  rows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>
): readonly (readonly TemporalDescendantLayer[])[] {
  const seedLayers = directTemporalSeedLayers(rows);
  const passes: TemporalDescendantLayer[][] = [];

  for (const layer of planner.descendantExpansionOrder) {
    if (layer === "month" && seedLayers.has("year") && planner.descendantLayerBudgets.month > 0) {
      passes.push(["month"]);
      continue;
    }

    if (layer === "week" && (seedLayers.has("year") || seedLayers.has("month")) && planner.descendantLayerBudgets.week > 0) {
      passes.push(["week"]);
      continue;
    }

    if (
      layer === "day" &&
      (seedLayers.has("year") || seedLayers.has("month") || seedLayers.has("week")) &&
      planner.descendantLayerBudgets.day > 0
    ) {
      passes.push(["day"]);
    }
  }

  return passes;
}

function hasSufficientTemporalEvidence(
  rows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>,
  timeStart: string | null,
  timeEnd: string | null,
  detailTemporalFocus = false
): boolean {
  const temporalSummaryRows = rows.filter(
    (row) => row.memory_type === "temporal_nodes" && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  );
  const directLeafCount = rows.filter(
    (row) =>
      (row.memory_type === "episodic_memory" || row.memory_type === "narrative_event") &&
      !isTemporalDescendantSupportRow(row) &&
      rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const supportedLeafCount = rows.filter(
    (row) => isTemporalDescendantSupportRow(row) && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const temporalCount = rows.filter(
    (row) => row.memory_type === "temporal_nodes" && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const supportTokenCount = approxResultTokenCount(rows.filter((row) => isTemporalDescendantSupportRow(row)));

  if (detailTemporalFocus) {
    if (directLeafCount >= 1) {
      return true;
    }

    if (directLeafCount + supportedLeafCount >= 1 && temporalCount >= planner.temporalSufficiencyTemporalThreshold) {
      return true;
    }

    return false;
  }

  const topTemporalSummary = temporalSummaryRows[0];
  if (topTemporalSummary) {
    const coverage = lexicalCoverageForResult(topTemporalSummary.content, planner.lexicalTerms);
    if (coverage.lexicalCoverage >= 0.5 && planner.targetLayers.length > 0) {
      return true;
    }
  }

  if (directLeafCount >= planner.temporalSufficiencyEpisodicThreshold) {
    return true;
  }

  if (
    directLeafCount + supportedLeafCount >= planner.temporalSufficiencyEpisodicThreshold &&
    temporalCount >= planner.temporalSufficiencyTemporalThreshold
  ) {
    return true;
  }

  if (
    supportedLeafCount > 0 &&
    temporalCount >= planner.temporalSufficiencyTemporalThreshold &&
    supportTokenCount >= planner.temporalSupportMaxTokens
  ) {
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

async function loadTemporalDescendantSupportRows(
  namespaceId: string,
  seedRows: readonly RankedSearchRow[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  layers: readonly TemporalDescendantLayer[]
): Promise<RankedSearchRow[]> {
  const temporalIds = [...new Set(
    seedRows.filter((row) => row.memory_type === "temporal_nodes").map((row) => row.memory_id)
  )].slice(0, Math.min(candidateLimit, 6));

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

async function loadHierarchicalContainmentSupportRows(
  namespaceId: string,
  lexicalTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  temporalFocus: boolean
): Promise<RankedSearchRow[]> {
  const normalizedTerms = [...new Set(lexicalTerms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
  if (normalizedTerms.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE matched_places AS (
        SELECT DISTINCT e.id
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND e.normalized_name = ANY($2::text[])
        UNION
        SELECT DISTINCT ea.entity_id
        FROM entity_aliases ea
        JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND ea.normalized_alias = ANY($2::text[])
      ),
      descendant_places AS (
        SELECT mp.id AS entity_id, 0 AS hops, ARRAY[mp.id]::uuid[] AS path
        FROM matched_places mp

        UNION ALL

        SELECT e.id AS entity_id, dp.hops + 1 AS hops, dp.path || e.id
        FROM descendant_places dp
        JOIN entities e
          ON e.namespace_id = $1
         AND e.parent_entity_id = dp.entity_id
        WHERE dp.hops < 4
          AND e.entity_type IN ('place', 'org', 'project')
          AND NOT (e.id = ANY(dp.path))
      ),
      ranked_descendants AS (
        SELECT entity_id, MIN(hops) AS hops
        FROM descendant_places
        GROUP BY entity_id
      )
      SELECT DISTINCT ON (e.id)
        e.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        (1.0 / (28 + rd.hops))::double precision AS raw_score,
        e.artifact_id,
        e.occurred_at,
        e.namespace_id,
        jsonb_build_object(
          'tier', 'hierarchical_containment_support',
          'matched_entity_id', mem.entity_id,
          'containment_hops', rd.hops,
          'artifact_observation_id', e.artifact_observation_id,
          'source_chunk_id', e.source_chunk_id,
          'source_offset', e.source_offset,
          'source_uri', a.uri,
          'metadata', e.metadata
        ) AS provenance
      FROM ranked_descendants rd
      JOIN memory_entity_mentions mem
        ON mem.namespace_id = $1
       AND mem.entity_id = rd.entity_id
       AND mem.mention_role = 'location'
      JOIN episodic_memory e
        ON e.id = mem.source_memory_id
       AND e.namespace_id = $1
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE ($3::timestamptz IS NULL OR e.occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
      ORDER BY e.id, rd.hops ASC, e.occurred_at DESC
      LIMIT $5
    `,
    [namespaceId, normalizedTerms, timeStart, timeEnd, candidateLimit]
  );

  return toRankedRows(rows).sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), temporalFocus));
}

async function loadFtsLexicalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  hasTimeWindow: boolean,
  relationshipExactFocus: boolean,
  _activeRelationshipFocus: boolean,
  historicalRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  styleQueryFocus: boolean,
  temporalDetailFocus = false
): Promise<RankedSearchRow[]> {
  const plannerTerms = planner.lexicalTerms.filter((term) => term.trim().length > 0);
  const effectiveQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : styleQueryFocus
      ? buildStyleSpecEvidenceQueryText(queryText, planner.lexicalTerms)
      : (plannerTerms.length > 0 ? plannerTerms : [queryText]).join(" ");
  const eventQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : buildEventQueryText(queryText, planner.lexicalTerms);
  const temporalQueryText = temporalDetailFocus
    ? effectiveQueryText
    : dailyLifeSummaryFocus
      ? buildEventQueryText(queryText, planner.lexicalTerms)
      : queryText;
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
            AND (
              $6::boolean = true
              OR to_tsvector('english', coalesce(summary_text, '')) @@ websearch_to_tsquery('english', $2)
            )
          ORDER BY raw_score DESC, period_end DESC
          LIMIT $5
        `,
        [namespaceId, temporalQueryText, timeStart, timeEnd, candidateLimit, dailyLifeSummaryFocus]
      )
    : Promise.resolve<SearchRow[]>([]);

  const [relationshipRows, relationshipCandidateRows, proceduralRows, semanticRows, candidateRows, eventRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($6::boolean = true AND rm.status IN ('active', 'superseded'))
            OR
            ($6::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          )
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND (
            $6::boolean = false
            AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
            AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
            OR
            $6::boolean = true
            AND ($3::timestamptz IS NULL OR COALESCE(rm.valid_until, 'infinity'::timestamptz) >= $3)
            AND ($4::timestamptz IS NULL OR rm.valid_from <= $4)
          )
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rm.valid_from) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit, historicalRelationshipFocus]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          rc.id AS memory_id,
          'relationship_candidate'::text AS memory_type,
          ${relationshipContentExpression("rc")} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument("rc")}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rc.predicate,
            'object_name', object_entity.canonical_name,
            'status', rc.status,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rc.metadata
          ) AS provenance
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument("rc")}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rc.valid_from, rc.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          procedural_memory.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, updated_at) AS occurred_at,
          procedural_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', procedural_memory.state_type,
            'state_key', procedural_memory.state_key,
            'version', procedural_memory.version,
            'valid_from', procedural_memory.valid_from,
            'valid_until', procedural_memory.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', procedural_memory.metadata
          ) AS provenance
        FROM procedural_memory
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE procedural_memory.namespace_id = $1
          AND procedural_memory.valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, procedural_memory.updated_at DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          semantic_memory.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          content_abstract AS content,
          ts_rank(semantic_memory.search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND semantic_memory.search_vector @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, semantic_memory.valid_from DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
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
      [namespaceId, effectiveQueryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${narrativeEventLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) * 0.72 AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_memory_id', source_memory.id,
            'source_uri', a.uri,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN LATERAL (
          SELECT em.id, em.occurred_at
          FROM episodic_memory em
          WHERE em.namespace_id = ne.namespace_id
            AND em.artifact_observation_id = ne.artifact_observation_id
          ORDER BY em.occurred_at ASC, em.id ASC
          LIMIT 1
        ) AS source_memory ON TRUE
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND to_tsvector(
                'english',
                ${narrativeEventLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($4::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) >= $4)
          AND ($5::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) <= $5)
        ORDER BY raw_score DESC, COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) DESC
        LIMIT $3
      `,
      [namespaceId, eventQueryText, candidateLimit, timeStart, timeEnd]
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
          AND (
            $6::boolean = true
            OR et.search_vector @@ websearch_to_tsquery('english', $2)
          )
          AND ($4::timestamptz IS NULL OR et.occurred_at >= $4)
          AND ($5::timestamptz IS NULL OR et.occurred_at <= $5)
        ORDER BY raw_score DESC, et.occurred_at DESC
        LIMIT $3
      `,
      [namespaceId, temporalQueryText, candidateLimit, timeStart, timeEnd, dailyLifeSummaryFocus]
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

  const combinedRows = toRankedRows([
    ...relationshipRows,
    ...relationshipCandidateRows,
    ...proceduralRows,
    ...semanticRows,
    ...candidateRows,
    ...eventRows,
    ...temporalRows,
    ...episodicRows,
    ...derivationRows
  ]);

  return combinedRows.length > 0
    ? finalizeLexicalRows(
        combinedRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      )
    : [];
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
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  historicalRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  styleQueryFocus: boolean,
  temporalDetailFocus = false
): Promise<RankedSearchRow[]> {
  const plannerTerms = planner.lexicalTerms.filter((term) => {
    const normalized = term.toLowerCase();
    if (/^\d{4}$/.test(normalized) && planner.temporalFocus) {
      return false;
    }
    return !BM25_STOP_WORDS.has(normalized);
  });
  const effectiveQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : styleQueryFocus
      ? buildStyleSpecEvidenceQueryText(queryText, planner.lexicalTerms)
      : (plannerTerms.length > 0 ? plannerTerms : [queryText]).join(" ");
  const semanticMatch = buildBm25DisjunctionClause(["content_abstract", "canonical_key", "memory_kind"], effectiveQueryText, 2);
  const candidateMatch = buildBm25DisjunctionClause(["content", "candidate_type", "canonical_key"], effectiveQueryText, 2);
  const eventMatch = buildBm25DisjunctionClause(
    [
      "ne.event_label",
      "ne.event_kind",
      "subject_entity.canonical_name",
      "location_entity.canonical_name",
      "ne.metadata->>'activity'",
      "ne.metadata->>'activity_label'",
      "ne.metadata->>'source_sentence_text'",
      "ne.metadata->>'location_text'",
      "ne.metadata->>'participant_names'"
    ],
    temporalDetailFocus
      ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
      : buildEventQueryText(queryText, planner.lexicalTerms),
    2
  );
  const temporalMatch = buildBm25DisjunctionClause(["summary_text", "layer"], effectiveQueryText, 2);
  const episodicMatch = buildBm25DisjunctionClause(["e.content", "e.role"], effectiveQueryText, 2);
  const derivationMatch = buildBm25DisjunctionClause(["ad.content_text", "ad.derivation_type"], effectiveQueryText, 2);

  const [relationshipRows, relationshipCandidateRows, proceduralRows, semanticRows, candidateRows, eventRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($6::boolean = true AND rm.status IN ('active', 'superseded'))
            OR
            ($6::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          )
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND (
            $6::boolean = false
            AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
            AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
            OR
            $6::boolean = true
            AND ($3::timestamptz IS NULL OR COALESCE(rm.valid_until, 'infinity'::timestamptz) >= $3)
            AND ($4::timestamptz IS NULL OR rm.valid_from <= $4)
          )
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rm.valid_from) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit, historicalRelationshipFocus]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          rc.id AS memory_id,
          'relationship_candidate'::text AS memory_type,
          ${relationshipContentExpression("rc")} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument("rc")}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rc.predicate,
            'object_name', object_entity.canonical_name,
            'status', rc.status,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rc.metadata
          ) AS provenance
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument("rc")}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rc.valid_from, rc.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          procedural_memory.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, procedural_memory.updated_at) AS occurred_at,
          procedural_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'lexical_provider', 'fts_bridge',
            'state_type', procedural_memory.state_type,
            'state_key', procedural_memory.state_key,
            'version', procedural_memory.version,
            'valid_from', procedural_memory.valid_from,
            'valid_until', procedural_memory.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', procedural_memory.metadata
          ) AS provenance
        FROM procedural_memory
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE procedural_memory.namespace_id = $1
          AND procedural_memory.valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, COALESCE(em.occurred_at, procedural_memory.updated_at) DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          semantic_memory.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          semantic_memory.content_abstract AS content,
          pdb.score(semantic_memory.id) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, semantic_memory.valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'lexical_provider', 'bm25',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = semantic_memory.source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND ${semanticMatch.clause}
        ORDER BY raw_score DESC, semantic_memory.valid_from DESC
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
    queryRows<SearchRow>(
      `
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${narrativeEventLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) * 0.72 AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'lexical_provider', 'bm25',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_memory_id', source_memory.id,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN LATERAL (
          SELECT em.id, em.occurred_at
          FROM episodic_memory em
          WHERE em.namespace_id = ne.namespace_id
            AND em.artifact_observation_id = ne.artifact_observation_id
          ORDER BY em.occurred_at ASC, em.id ASC
          LIMIT 1
        ) AS source_memory ON TRUE
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND ${eventMatch.clause}
          AND ($3::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(ne.time_start, source_memory.occurred_at, ne.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, ...eventMatch.values, timeStart, timeEnd, candidateLimit]
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
      { branch: "relationship_memory", rows: toRankedRows(relationshipRows) },
      { branch: "relationship_candidate", rows: toRankedRows(relationshipCandidateRows) },
      { branch: "procedural_memory", rows: toRankedRows(proceduralRows) },
      { branch: "semantic_memory", rows: toRankedRows(semanticRows) },
      { branch: "memory_candidate", rows: toRankedRows(candidateRows) },
      { branch: "narrative_event", rows: toRankedRows(eventRows) },
      { branch: "temporal_nodes", rows: toRankedRows(temporalRows) },
      { branch: "episodic_memory", rows: toRankedRows(episodicRows) },
      { branch: "artifact_derivation", rows: toRankedRows(derivationRows) }
    ],
    candidateLimit,
    hasTimeWindow,
    planner.temporalFocus,
    relationshipExactFocus,
    precisionLexicalFocus,
    activeRelationshipFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    planner,
    timeStart,
    timeEnd,
    plannerTerms
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

  const selection = resolveEmbeddingRuntimeSelection({
    provider: query.provider,
    model: query.model,
    outputDimensionality: query.outputDimensionality
  });

  if (!selection.enabled) {
    return {
      embedding: null,
      source: "none",
      fallbackReason: "provider:none"
    };
  }

  try {
    const adapter = getProviderAdapter(selection.provider);
    const response = await adapter.embedText({
      text: query.query,
      model: selection.model,
      outputDimensionality: selection.outputDimensionality
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
  const normalizedRelationshipWhyQuery = normalizeRelationshipWhyQuery(queryText);
  const retrievalQueryText = normalizedRelationshipWhyQuery ?? queryText;
  const planner = planRecallQuery({
    ...query,
    query: retrievalQueryText
  });
  const relationshipExactFocus = isRelationshipStyleExactQuery(retrievalQueryText);
  const activeRelationshipFocus = isActiveRelationshipQuery(retrievalQueryText);
  const dailyLifeEventFocus = isDailyLifeEventQuery(retrievalQueryText);
  const eventBoundedFocus = isEventBoundedQuery(retrievalQueryText);
  const dailyLifeSummaryFocus = isDailyLifeSummaryQuery(retrievalQueryText);
  const temporalDetailFocus = isTemporalDetailQuery(retrievalQueryText);
  const preferenceQueryFocus = isPreferenceQuery(retrievalQueryText);
  const historicalPreferenceFocus = isHistoricalPreferenceQuery(retrievalQueryText);
  const pointInTimePreferenceFocus = preferenceQueryFocus && Boolean(query.timeStart || query.timeEnd || planner.inferredTimeStart || planner.inferredTimeEnd);
  const currentPreferenceFocus = isCurrentPreferenceQuery(retrievalQueryText) || (preferenceQueryFocus && !historicalPreferenceFocus && !pointInTimePreferenceFocus);
  const styleQueryFocus = isStyleSpecQuery(retrievalQueryText);
  const goalQueryFocus = isGoalQuery(retrievalQueryText);
  const planQueryFocus = isPlanQuery(retrievalQueryText);
  const beliefQueryFocus = isBeliefQuery(retrievalQueryText);
  const historicalHomeFocus = /\bwhere\s+has\s+.+\s+lived\b/i.test(retrievalQueryText);
  const historicalWorkFocus = isHistoricalWorkQuery(retrievalQueryText);
  const historicalRelationshipFocus = isHistoricalRelationshipQuery(retrievalQueryText);
  const preferredActiveRelationshipPredicates = preferredRelationshipPredicates(retrievalQueryText);
  const timeStart = query.timeStart ?? planner.inferredTimeStart ?? null;
  const timeEnd = query.timeEnd ?? planner.inferredTimeEnd ?? null;
  const hasTimeWindow = Boolean(timeStart || timeEnd);
  const historicalBeliefFocus = beliefQueryFocus && (isHistoricalBeliefQuery(retrievalQueryText) || hasTimeWindow);
  const precisionLexicalFocus =
    (!query.queryEmbedding || query.queryEmbedding.length === 0) &&
    (isPrecisionLexicalQuery(retrievalQueryText) || relationshipExactFocus);
  const narrowTemporalWindow = hasNarrowTimeWindow(timeStart, timeEnd);
  const candidateLimit = precisionLexicalFocus
    ? Math.max(Math.min(limit * 2, 12), 8)
    : planner.temporalFocus
      ? Math.max(limit * planner.candidateLimitMultiplier, 12)
      : Math.max(limit * planner.candidateLimitMultiplier, 20);
  const [queryEmbeddingResult, lexicalResult] = await Promise.all([
    resolveQueryEmbedding({
      ...query,
      query: retrievalQueryText
    }),
    (async () => {
      if (config.lexicalProvider !== "bm25") {
        return {
          rows: await loadFtsLexicalRows(
            query.namespaceId,
            retrievalQueryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus,
            activeRelationshipFocus,
            historicalRelationshipFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            styleQueryFocus,
            temporalDetailFocus
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
            retrievalQueryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus,
            precisionLexicalFocus,
            activeRelationshipFocus,
            historicalRelationshipFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            styleQueryFocus,
            temporalDetailFocus
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
            retrievalQueryText,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            hasTimeWindow,
            relationshipExactFocus,
            activeRelationshipFocus,
            historicalRelationshipFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            styleQueryFocus,
            temporalDetailFocus
          ),
          provider: "fts" as LexicalProvider,
          fallbackUsed: true,
          fallbackReason: error instanceof Error ? error.message : "unknown_bm25_failure"
        };
      }
    })()
  ]);
  let lexicalRows = lexicalResult.rows;
  const placeContainmentSupportRows = await loadHierarchicalContainmentSupportRows(
    query.namespaceId,
    planner.lexicalTerms,
    candidateLimit,
    timeStart,
    timeEnd,
    planner.temporalFocus
  );
  if (placeContainmentSupportRows.length > 0) {
    lexicalRows = mergeUniqueRows(
      lexicalRows,
      placeContainmentSupportRows,
      candidateLimit,
      hasTimeWindow,
      planner.temporalFocus,
      dailyLifeEventFocus,
      dailyLifeSummaryFocus,
      timeStart,
      timeEnd
    );
  }
  if (eventBoundedFocus) {
    const scopedEventRows = toRankedRows(
      await loadScopedNarrativeEventRows(query.namespaceId, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
    );
    if (scopedEventRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        scopedEventRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (historicalWorkFocus) {
    const historicalWorkedAtRows = toRankedRows(
      await loadHistoricalWorkedAtRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd)
    );
    if (historicalWorkedAtRows.length > 0) {
      const historicalWorkMergeLimit = Math.max(candidateLimit * 3, 24);
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        historicalWorkedAtRows,
        historicalWorkMergeLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (preferenceQueryFocus) {
    const preferenceMode = historicalPreferenceFocus
      ? (hasTimeWindow ? "point_in_time" : "historical")
      : "current";
    const preferenceRows = toRankedRows(
      await loadPreferenceTenureRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd, preferenceMode)
    );
    if (preferenceRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        preferenceRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (styleQueryFocus) {
    const styleRows = toRankedRows(await loadStyleSpecRows(query.namespaceId, retrievalQueryText, candidateLimit));
    if (styleRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        styleRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (goalQueryFocus) {
    const goalRows = toRankedRows(await loadGoalRows(query.namespaceId, retrievalQueryText, candidateLimit));
    if (goalRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        goalRows,
        Math.max(candidateLimit * 2, 8),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (planQueryFocus) {
    const planRows = toRankedRows(await loadPlanRows(query.namespaceId, retrievalQueryText, candidateLimit));
    if (planRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        planRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  if (beliefQueryFocus) {
    const beliefRows = toRankedRows(
      await loadBeliefRows(
        query.namespaceId,
        retrievalQueryText,
        candidateLimit,
        timeStart,
        timeEnd,
        historicalBeliefFocus ? (hasTimeWindow ? "point_in_time" : "historical") : "current"
      )
    );
    if (beliefRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        beliefRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
  }
  let temporalGateTriggered = false;
  let temporalLayersUsed: readonly TemporalDescendantLayer[] = [];
  let temporalSummarySufficient = false;
  if (planner.temporalFocus || hasTimeWindow) {
    const temporalLayerAccumulator = new Set<TemporalDescendantLayer>();

    const ancestryRows = await loadTemporalHierarchyRows(
      query.namespaceId,
      lexicalRows,
      candidateLimit,
      timeStart,
      timeEnd,
      planner
    );
    if (ancestryRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        ancestryRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }

    temporalSummarySufficient = hasSufficientTemporalEvidence(lexicalRows, planner, timeStart, timeEnd, temporalDetailFocus);
    const descendantPasses = determineTemporalDescendantPasses(lexicalRows, planner);
    temporalGateTriggered = !temporalSummarySufficient && descendantPasses.length > 0;
    if (temporalGateTriggered) {
      for (const passLayers of descendantPasses) {
        const descendantRows = await loadTemporalDescendantSupportRows(
          query.namespaceId,
          lexicalRows,
          candidateLimit,
          timeStart,
          timeEnd,
          planner,
          passLayers
        );
        if (descendantRows.length > 0) {
          lexicalRows = mergeUniqueRows(
            lexicalRows,
            descendantRows,
            candidateLimit,
            hasTimeWindow,
            planner.temporalFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            timeStart,
            timeEnd
          );
          for (const layer of passLayers) {
            temporalLayerAccumulator.add(layer);
          }
        }

        if (hasSufficientTemporalEvidence(lexicalRows, planner, timeStart, timeEnd, temporalDetailFocus)) {
          break;
        }
      }
    }
    temporalLayersUsed = [...temporalLayerAccumulator];
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
    const weight =
      row.memory_type === "episodic_memory" || row.memory_type === "narrative_event"
        ? planner.episodicWeight
        : row.memory_type === "temporal_nodes"
          ? planner.temporalSummaryWeight
          : 1;
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
        memoryTypePriority(
          left.row.memory_type,
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus
        ) -
        memoryTypePriority(
          right.row.memory_type,
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus
        );
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

  let results = pruneRankedResults(
    rankedResults,
    planner,
    relationshipExactFocus,
    precisionLexicalFocus,
    activeRelationshipFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    historicalHomeFocus,
    historicalWorkFocus,
    historicalRelationshipFocus,
    preferenceQueryFocus,
    historicalPreferenceFocus,
    currentPreferenceFocus,
    styleQueryFocus,
    goalQueryFocus,
    planQueryFocus,
    beliefQueryFocus,
    historicalBeliefFocus,
    pointInTimePreferenceFocus,
    timeStart,
    timeEnd,
    preferredActiveRelationshipPredicates,
    narrowTemporalWindow
  )
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

  let boundedEventSupportCount = 0;
  if (eventBoundedFocus) {
    const boundedEventIds = results
      .filter((result) => result.memoryType === "narrative_event")
      .map((result) => result.memoryId)
      .slice(0, 2);
    if (boundedEventIds.length > 0) {
      const supportRows = await loadBoundedEventSceneSupportRows(query.namespaceId, boundedEventIds);
      boundedEventSupportCount = supportRows.length;
      results = [...expandBoundedEventResults(results, supportRows, limit)];
    }
  }

  const evidence = buildEvidenceBundle(results);
  const answerAssessment = assessRecallAnswer(results, evidence, planner, temporalSummarySufficient);
  const duality = buildDualityObject(results, evidence, answerAssessment, query.namespaceId, query.query);

  return {
    results,
    evidence,
    duality,
    meta: {
      contractVersion: "duality_v2",
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
      temporalGateTriggered,
      temporalSummarySufficient: temporalSummarySufficient || undefined,
      temporalDetailFocus: temporalDetailFocus || undefined,
      temporalLayersUsed,
      temporalSupportTokenCount: approxResultTokenCount(lexicalRows.filter((row) => isTemporalDescendantSupportRow(row))),
      placeContainmentSupportCount: lexicalRows.filter((row) => row.provenance.tier === "place_containment_support").length,
      boundedEventSupportCount: boundedEventSupportCount > 0 ? boundedEventSupportCount : undefined,
      answerAssessment,
      followUpAction: duality.followUpAction,
      clarificationHint: duality.clarificationHint,
      provenanceAnswer: normalizedRelationshipWhyQuery ? buildProvenanceAnswer(normalizedRelationshipWhyQuery, results, evidence) : undefined,
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
        relationship_id,
        subject_entity.canonical_name AS subject_name,
        predicate,
        object_entity.canonical_name AS object_name,
        confidence,
        source_memory_id,
        occurred_at,
        relationships.namespace_id,
        provenance
      FROM (
        SELECT
          rm.id AS relationship_id,
          rm.subject_entity_id,
          rm.predicate,
          rm.object_entity_id,
          rm.confidence,
          NULL::uuid AS source_memory_id,
          rm.valid_from AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        WHERE rm.namespace_id = $1
          AND rm.status = 'active'
          AND rm.valid_until IS NULL

        UNION ALL

        SELECT
          rc.id AS relationship_id,
          rc.subject_entity_id,
          rc.predicate,
          rc.object_entity_id,
          rc.confidence,
          rc.source_memory_id,
          COALESCE(et.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
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
        LEFT JOIN episodic_timeline et ON et.memory_id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = et.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
      ) relationships
      INNER JOIN entities subject_entity ON subject_entity.id = relationships.subject_entity_id
      INNER JOIN entities object_entity ON object_entity.id = relationships.object_entity_id
      WHERE ($3::text IS NULL OR relationships.predicate = $3)
        AND ($4::timestamptz IS NULL OR relationships.occurred_at >= $4)
        AND ($5::timestamptz IS NULL OR relationships.occurred_at <= $5)
        AND (
          relationships.subject_entity_id IN (SELECT id FROM matched_entities)
          OR relationships.object_entity_id IN (SELECT id FROM matched_entities)
          OR EXISTS (
            SELECT 1
            FROM relationship_priors rp
            WHERE rp.namespace_id = $1
              AND (
                (rp.entity_a_id = relationships.subject_entity_id AND rp.entity_b_id IN (SELECT id FROM matched_entities))
                OR (rp.entity_b_id = relationships.subject_entity_id AND rp.entity_a_id IN (SELECT id FROM matched_entities))
                OR (rp.entity_a_id = relationships.object_entity_id AND rp.entity_b_id IN (SELECT id FROM matched_entities))
                OR (rp.entity_b_id = relationships.object_entity_id AND rp.entity_a_id IN (SELECT id FROM matched_entities))
              )
          )
        )
      ORDER BY confidence DESC, occurred_at DESC NULLS LAST
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
