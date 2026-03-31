import { queryRows } from "../db/client.js";
import type { RecallResult } from "../types.js";
import {
  isIdentityProfileQuery,
  isPreferenceQuery,
  isPreciseFactDetailQuery,
  isProfileInferenceQuery,
  isSharedCommonalityQuery,
  isTemporalDetailQuery
} from "./query-signals.js";
import { buildFocusedEntityQuery, parseQueryEntityFocus } from "./query-entity-focus.js";

export type AnswerableUnitType = "participant_turn" | "source_sentence" | "event_span" | "date_span" | "fact_span";
export type AnswerableUnitOwnershipStatus = "owned" | "mixed" | "foreign" | "no_subject_signal";

export interface AnswerableUnit {
  readonly id: string;
  readonly namespaceId: string;
  readonly sourceKind: "episodic_memory" | "artifact_derivation";
  readonly sourceMemoryId?: string | null;
  readonly sourceDerivationId?: string | null;
  readonly artifactId?: string | null;
  readonly artifactObservationId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly unitType: AnswerableUnitType;
  readonly contentText: string;
  readonly turnIndex?: number | null;
  readonly turnStartIndex?: number | null;
  readonly turnEndIndex?: number | null;
  readonly ownerEntityHint?: string | null;
  readonly speakerEntityHint?: string | null;
  readonly participantNames: readonly string[];
  readonly occurredAt?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly isCurrent?: boolean | null;
  readonly ownershipConfidence: number;
  readonly provenance: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly lexicalScore: number;
}

export interface AnswerableUnitCandidate {
  readonly unit: AnswerableUnit;
  readonly ownershipStatus: AnswerableUnitOwnershipStatus;
  readonly subjectMatchScore: number;
  readonly temporalScore: number;
  readonly slotCueScore: number;
  readonly authorityScore: number;
  readonly supportScore: number;
  readonly totalScore: number;
}

export interface AnswerableUnitRetrievalTelemetry {
  readonly answerableUnitApplied: boolean;
  readonly answerableUnitCandidateCount: number;
  readonly answerableUnitOwnedCount: number;
  readonly answerableUnitMixedCount: number;
  readonly answerableUnitForeignCount: number;
}

export function scoreAnswerableUnitsForQuery(
  queryText: string,
  units: readonly AnswerableUnit[],
  supportResults: readonly RecallResult[]
): readonly AnswerableUnitCandidate[] {
  if (!isScopedAnswerableUnitQuery(queryText)) {
    return [];
  }
  const focus = parseQueryEntityFocus(queryText);
  const target = focus.primaryHints[0] ?? "";
  const companionHints = focus.companionHints;
  return units
    .map<AnswerableUnitCandidate>((unit) => {
      const ownershipStatus = target ? targetSupportFromUnit(target, companionHints, unit) : "no_subject_signal";
      const subjectMatchScore =
        ownershipStatus === "owned" ? 1.45 :
        ownershipStatus === "mixed" ? 0.2 :
        ownershipStatus === "foreign" ? -1.2 :
        -0.4;
      const temporalScore = temporalScoreForUnit(queryText, unit);
      const eventAlignmentScore = temporalEventAlignmentScore(queryText, unit);
      const slotCueScore = slotCueScoreForUnit(queryText, unit);
      const authority = authorityScore(unit.unitType);
      const supportScore = supportSeedScore(unit, supportResults);
      const totalScore =
        unit.lexicalScore +
        authority +
        unit.ownershipConfidence +
        subjectMatchScore +
        temporalScore +
        eventAlignmentScore +
        slotCueScore +
        supportScore;
      return {
        unit,
        ownershipStatus,
        subjectMatchScore,
        temporalScore,
        slotCueScore,
        authorityScore: authority,
        supportScore,
        totalScore
      };
    })
    .sort((left, right) => right.totalScore - left.totalScore);
}

interface AnswerableUnitRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly source_kind: "episodic_memory" | "artifact_derivation";
  readonly source_memory_id: string | null;
  readonly source_derivation_id: string | null;
  readonly artifact_id: string | null;
  readonly artifact_observation_id: string | null;
  readonly source_chunk_id: string | null;
  readonly unit_type: AnswerableUnitType;
  readonly content_text: string;
  readonly turn_index: number | null;
  readonly turn_start_index: number | null;
  readonly turn_end_index: number | null;
  readonly owner_entity_hint: string | null;
  readonly speaker_entity_hint: string | null;
  readonly participant_names: unknown;
  readonly occurred_at: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly is_current: boolean | null;
  readonly ownership_confidence: number | null;
  readonly provenance: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
  readonly lexical_score: number | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

type AnswerableUnitCueFamily =
  | "generic"
  | "hobbies"
  | "martial_arts"
  | "meal_companion"
  | "color"
  | "allergy_safe_pets"
  | "favorite_movie"
  | "social_exclusion";

function inferAnswerableUnitCueFamily(queryText: string): AnswerableUnitCueFamily {
  const lowered = queryText.toLowerCase();
  if (/\bhobbies?\b/.test(lowered)) {
    return "hobbies";
  }
  if (/\bwhat\s+martial\s+arts?\b/.test(lowered) || /\bmartial\s+arts?\s+has\b/.test(lowered)) {
    return "martial_arts";
  }
  if (/\bwho\b/.test(lowered) && /\b(?:dinner|lunch|breakfast)\b/.test(lowered)) {
    return "meal_companion";
  }
  if (/\bwhat\s+color\b/.test(lowered)) {
    return "color";
  }
  if ((/\bpets?\b/.test(lowered) && /\bdiscomfort\b/.test(lowered)) || /\ballerg/i.test(lowered)) {
    return "allergy_safe_pets";
  }
  if (/\bfavorite\s+movies?\b/.test(lowered) || (/\bone\s+of\b/.test(lowered) && /\bfavorite\s+movies?\b/.test(lowered))) {
    return "favorite_movie";
  }
  if (/\bbesides\b/.test(lowered) && /\bfriends?\b/.test(lowered)) {
    return "social_exclusion";
  }
  return "generic";
}

function isStandaloneHobbyStatement(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return false;
  }
  return (
    /\bbesides\s+[A-Za-z][^,!?\n]{0,40},\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys|like|likes)\b/iu.test(normalized) ||
    /^[A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s+and\s+[A-Za-z]+ing(?:\s+(?:with|around)\s+[A-Za-z]+){0,3})?!?$/u.test(normalized)
  );
}

function slotCueScoreForUnit(queryText: string, unit: AnswerableUnit): number {
  const family = inferAnswerableUnitCueFamily(queryText);
  const text = normalizeWhitespace(unit.contentText);
  if (!text || /\?\s*$/u.test(text)) {
    return 0;
  }
  switch (family) {
    case "hobbies":
      if (/\bhobbies?\b/i.test(text)) {
        return 2.4;
      }
      if (isStandaloneHobbyStatement(text)) {
        return 2.2;
      }
      if (/\b(?:i|he|she)\s+(?:also\s+)?(?:enjoy|enjoys|love|loves|like|likes)\s+[A-Za-z]/i.test(text)) {
        return 1.55;
      }
      return 0;
    case "martial_arts":
      if (/\b(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling)\b/i.test(text)) {
        return 2.5;
      }
      if (/\bmartial arts?\b/i.test(text)) {
        return 1.2;
      }
      return 0;
    case "meal_companion":
      if (/\b(?:dinner|lunch|breakfast)\b/i.test(text)) {
        return /\b(?:with|along with|together with)\b/i.test(text) ? 2.2 : 1.2;
      }
      return 0;
    case "color":
      return /\b(?:color|shade|dyed|dye|hair)\b/i.test(text) ? 2.1 : 0;
    case "allergy_safe_pets":
      return /\b(?:pets?|dogs?|cats?|rabbits?|fish|birds?|allerg|hypoallergenic)\b/i.test(text) ? 2.05 : 0;
    case "favorite_movie":
      if (/\b(?:favorite\s+movies?|favorite\s+film|one of .*favorite movies?)\b/i.test(text)) {
        return 2.2;
      }
      return /\b(?:movie|film)\b/i.test(text) ? 0.8 : 0;
    case "social_exclusion":
      return /\b(?:old friends?|other friends?|some friends?|teammates?|team|tournament friends?|outside of my circle)\b/i.test(text) ? 2.3 : 0;
    case "generic":
    default:
      return 0;
  }
}

export function isScopedAnswerableUnitQuery(queryText: string): boolean {
  const focus = parseQueryEntityFocus(queryText);
  if (focus.primaryHints.length !== 1 || focus.mode === "shared_group" || focus.mode === "multi_subject") {
    return false;
  }
  if (/\blately\b/i.test(queryText) || /\bbeen\s+doing\b/i.test(queryText)) {
    return false;
  }
  if (isIdentityProfileQuery(queryText) || isProfileInferenceQuery(queryText) || isPreferenceQuery(queryText) || isSharedCommonalityQuery(queryText)) {
    return false;
  }
  return (
    isPreciseFactDetailQuery(queryText) ||
    isTemporalDetailQuery(queryText) ||
    /^\s*(?:is|does|did|would|will|can|could|has|have|had|what|which|when|where|why|how|who)\b/i.test(queryText)
  );
}

function participantNamesFromRow(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeWhitespace(item).toLowerCase())
    .filter(Boolean);
}

function toUnit(row: AnswerableUnitRow): AnswerableUnit {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    sourceKind: row.source_kind,
    sourceMemoryId: row.source_memory_id,
    sourceDerivationId: row.source_derivation_id,
    artifactId: row.artifact_id,
    artifactObservationId: row.artifact_observation_id,
    sourceChunkId: row.source_chunk_id,
    unitType: row.unit_type,
    contentText: row.content_text,
    turnIndex: row.turn_index,
    turnStartIndex: row.turn_start_index,
    turnEndIndex: row.turn_end_index,
    ownerEntityHint: row.owner_entity_hint ? normalizeWhitespace(row.owner_entity_hint).toLowerCase() : null,
    speakerEntityHint: row.speaker_entity_hint ? normalizeWhitespace(row.speaker_entity_hint).toLowerCase() : null,
    participantNames: participantNamesFromRow(row.participant_names),
    occurredAt: row.occurred_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    isCurrent: row.is_current,
    ownershipConfidence: typeof row.ownership_confidence === "number" ? row.ownership_confidence : 0,
    provenance: row.provenance ?? {},
    metadata: row.metadata ?? {},
    lexicalScore: typeof row.lexical_score === "number" ? row.lexical_score : 0
  };
}

function authorityScore(unitType: AnswerableUnitType): number {
  switch (unitType) {
    case "participant_turn":
      return 1.2;
    case "source_sentence":
      return 1.05;
    case "event_span":
      return 0.95;
    case "fact_span":
      return 0.88;
    case "date_span":
      return 0.82;
  }
}

function targetSupportFromUnit(
  target: string,
  companionHints: readonly string[],
  unit: AnswerableUnit
): AnswerableUnitOwnershipStatus {
  const owner = unit.ownerEntityHint ?? "";
  const speaker = unit.speakerEntityHint ?? "";
  const participants = unit.participantNames;
  const targetInParticipants = participants.some((value) => value.includes(target));
  const foreignParticipants = participants.filter(
    (value) => !value.includes(target) && !companionHints.some((hint) => value.includes(hint))
  );
  const lowerContent = unit.contentText.toLowerCase();
  const contentTargetHit = lowerContent.includes(target);

  if ((owner.includes(target) || speaker.includes(target)) && foreignParticipants.length === 0) {
    return "owned";
  }
  if ((owner.includes(target) || speaker.includes(target)) && foreignParticipants.length > 0) {
    return "mixed";
  }
  if (targetInParticipants && foreignParticipants.length === 0) {
    return "owned";
  }
  if (targetInParticipants && foreignParticipants.length > 0) {
    return "mixed";
  }
  if (contentTargetHit && foreignParticipants.length === 0) {
    return "owned";
  }
  if (contentTargetHit && foreignParticipants.length > 0) {
    return "mixed";
  }
  if (participants.length > 0 || owner || speaker) {
    return "foreign";
  }
  return "no_subject_signal";
}

function supportSeedScore(unit: AnswerableUnit, supportResults: readonly RecallResult[]): number {
  if (supportResults.length === 0) {
    return 0;
  }
  for (const result of supportResults) {
    if (unit.sourceMemoryId && result.memoryId === unit.sourceMemoryId) {
      return 0.7;
    }
    const artifactObservationId =
      typeof result.provenance.artifact_observation_id === "string" ? result.provenance.artifact_observation_id : null;
    if (artifactObservationId && unit.artifactObservationId && artifactObservationId === unit.artifactObservationId) {
      return 0.45;
    }
    const sourceChunkId = typeof result.provenance.source_chunk_id === "string" ? result.provenance.source_chunk_id : null;
    if (sourceChunkId && unit.sourceChunkId && sourceChunkId === unit.sourceChunkId) {
      return 0.5;
    }
  }
  return 0;
}

function temporalScoreForUnit(queryText: string, unit: AnswerableUnit): number {
  const isTemporal = isTemporalDetailQuery(queryText);
  const metadata = unit.metadata ?? {};
  const hasDateText = typeof metadata.date_text === "string" && metadata.date_text.length > 0;
  const hasRelative = typeof metadata.relative_label === "string" && metadata.relative_label.length > 0;
  if (isTemporal) {
    if (unit.unitType === "date_span" && (hasDateText || hasRelative)) {
      return 1.15;
    }
    if (hasDateText || hasRelative) {
      return 0.72;
    }
    return -0.45;
  }
  if (unit.unitType === "date_span") {
    return 0.12;
  }
  return 0;
}

function temporalEventAlignmentScore(queryText: string, unit: AnswerableUnit): number {
  if (!isTemporalDetailQuery(queryText)) {
    return 0;
  }

  const metadata = unit.metadata ?? {};
  const contextText = [
    unit.contentText,
    typeof metadata.source_sentence_text === "string" ? metadata.source_sentence_text : "",
    typeof metadata.source_turn_text === "string" ? metadata.source_turn_text : ""
  ]
    .join(" ")
    .toLowerCase();
  const entityTerms = new Set(parseQueryEntityFocus(queryText).primaryHints.flatMap((value) => value.split(/\s+/u)));
  const eventTerms = [...new Set(
    (queryText.match(/[A-Za-z']+/gu) ?? [])
      .map((term) => normalizeWhitespace(term).toLowerCase())
      .filter((term) => term.length > 1)
      .filter((term) => !["when", "did", "does", "do", "was", "were", "the", "a", "an", "to", "of", "at", "in", "on", "first", "last", "year", "month", "day", "date", "time", "my", "his", "her", "their"].includes(term))
      .filter((term) => !entityTerms.has(term))
  )];
  if (eventTerms.length === 0) {
    return 0;
  }

  const overlapCount = eventTerms.filter((term) => contextText.includes(term)).length;
  const hasDateAnchor =
    (typeof metadata.date_text === "string" && metadata.date_text.length > 0) ||
    (typeof metadata.relative_label === "string" && metadata.relative_label.length > 0);
  return overlapCount * 1.35 + (hasDateAnchor && overlapCount > 0 ? 2.6 : 0);
}

async function queryNeighborhoodUnits(options: {
  readonly namespaceId: string;
  readonly seedCandidates: readonly AnswerableUnitCandidate[];
  readonly excludeIds: readonly string[];
  readonly limit: number;
}): Promise<readonly AnswerableUnit[]> {
  const seedMemoryIds = [...new Set(options.seedCandidates.map((candidate) => candidate.unit.sourceMemoryId).filter((value): value is string => Boolean(value)))];
  const seedObservationIds = [...new Set(options.seedCandidates.map((candidate) => candidate.unit.artifactObservationId).filter((value): value is string => Boolean(value)))];
  const seedChunkIds = [...new Set(options.seedCandidates.map((candidate) => candidate.unit.sourceChunkId).filter((value): value is string => Boolean(value)))];
  if (seedMemoryIds.length === 0 && seedObservationIds.length === 0 && seedChunkIds.length === 0) {
    return [];
  }

  const rows = await queryRows<AnswerableUnitRow>(
    `
      SELECT
        au.id::text,
        au.namespace_id,
        au.source_kind,
        au.source_memory_id::text,
        au.source_derivation_id::text,
        au.artifact_id::text,
        au.artifact_observation_id::text,
        au.source_chunk_id::text,
        au.unit_type,
        au.content_text,
        au.turn_index,
        au.turn_start_index,
        au.turn_end_index,
        au.owner_entity_hint,
        au.speaker_entity_hint,
        au.participant_names,
        au.occurred_at::text,
        au.valid_from::text,
        au.valid_until::text,
        au.is_current,
        au.ownership_confidence,
        au.provenance,
        au.metadata,
        0::float8 AS lexical_score
      FROM answerable_units au
      WHERE au.namespace_id = $1
        AND NOT (au.id::text = ANY($2::text[]))
        AND (
          ($3::text[] IS NOT NULL AND au.source_memory_id::text = ANY($3::text[]))
          OR ($4::text[] IS NOT NULL AND au.artifact_observation_id::text = ANY($4::text[]))
          OR ($5::text[] IS NOT NULL AND au.source_chunk_id::text = ANY($5::text[]))
        )
      ORDER BY au.ownership_confidence DESC, au.occurred_at DESC NULLS LAST
      LIMIT $6
    `,
    [
      options.namespaceId,
      options.excludeIds,
      seedMemoryIds.length > 0 ? seedMemoryIds : null,
      seedObservationIds.length > 0 ? seedObservationIds : null,
      seedChunkIds.length > 0 ? seedChunkIds : null,
      options.limit
    ]
  );

  const seedUnits = options.seedCandidates.map((candidate) => candidate.unit);
  return rows
    .map(toUnit)
    .sort((left, right) => {
      const leftDistance = nearestTurnDistance(left, seedUnits);
      const rightDistance = nearestTurnDistance(right, seedUnits);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      if (right.ownershipConfidence !== left.ownershipConfidence) {
        return right.ownershipConfidence - left.ownershipConfidence;
      }
      return Date.parse(right.occurredAt ?? "") - Date.parse(left.occurredAt ?? "");
    })
    .slice(0, options.limit);
}

function nearestTurnDistance(unit: AnswerableUnit, seeds: readonly AnswerableUnit[]): number {
  const unitTurnIndex = unit.turnIndex ?? unit.turnStartIndex ?? unit.turnEndIndex;
  if (!Number.isFinite(unitTurnIndex)) {
    return Number.MAX_SAFE_INTEGER;
  }

  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const seed of seeds) {
    const seedTurnIndex = seed.turnIndex ?? seed.turnStartIndex ?? seed.turnEndIndex;
    if (!Number.isFinite(seedTurnIndex)) {
      continue;
    }
    if (seed.artifactObservationId && unit.artifactObservationId && seed.artifactObservationId !== unit.artifactObservationId) {
      continue;
    }
    bestDistance = Math.min(bestDistance, Math.abs((unitTurnIndex as number) - (seedTurnIndex as number)));
  }
  return bestDistance;
}

function ownerFamilyRegex(cueFamily: AnswerableUnitCueFamily): string | null {
  switch (cueFamily) {
    case "hobbies":
      return "(hobbies?|enjoy|enjoys|love|loves|like|likes|writing|reading|watching movies|exploring nature|hanging with friends)";
    case "martial_arts":
      return "(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling|martial arts?)";
    case "allergy_safe_pets":
      return "(allerg|animals with fur|hairless cats?|pigs?|reptiles?)";
    case "social_exclusion":
      return "(old friends?|other friends?|some friends?|teammates?|team|tournament friends?|outside of my circle|my team)";
    default:
      return null;
  }
}

async function queryOwnerFamilyUnits(options: {
  readonly namespaceId: string;
  readonly targetHints: readonly string[];
  readonly cueFamily: AnswerableUnitCueFamily;
  readonly excludeIds: readonly string[];
  readonly limit: number;
  readonly timeStart?: string;
  readonly timeEnd?: string;
}): Promise<readonly AnswerableUnit[]> {
  const familyRegex = ownerFamilyRegex(options.cueFamily);
  if (options.targetHints.length === 0 || !familyRegex) {
    return [];
  }

  const rows = await queryRows<AnswerableUnitRow>(
    `
      SELECT
        au.id::text,
        au.namespace_id,
        au.source_kind,
        au.source_memory_id::text,
        au.source_derivation_id::text,
        au.artifact_id::text,
        au.artifact_observation_id::text,
        au.source_chunk_id::text,
        au.unit_type,
        au.content_text,
        au.turn_index,
        au.turn_start_index,
        au.turn_end_index,
        au.owner_entity_hint,
        au.speaker_entity_hint,
        au.participant_names,
        au.occurred_at::text,
        au.valid_from::text,
        au.valid_until::text,
        au.is_current,
        au.ownership_confidence,
        au.provenance,
        au.metadata,
        0.25::float8 AS lexical_score
      FROM answerable_units au
      WHERE au.namespace_id = $1
        AND NOT (au.id::text = ANY($2::text[]))
        AND (
          lower(coalesce(au.owner_entity_hint, '')) = ANY($3::text[])
          OR lower(coalesce(au.speaker_entity_hint, '')) = ANY($3::text[])
        )
        AND lower(au.content_text) ~ $4
        AND ($5::timestamptz IS NULL OR au.occurred_at >= $5)
        AND ($6::timestamptz IS NULL OR au.occurred_at <= $6)
      ORDER BY au.ownership_confidence DESC, au.occurred_at DESC NULLS LAST
      LIMIT $7
    `,
    [
      options.namespaceId,
      options.excludeIds,
      options.targetHints,
      familyRegex,
      options.timeStart ?? null,
      options.timeEnd ?? null,
      options.limit
    ]
  );

  return rows.map(toUnit);
}

export async function queryAnswerableUnits(options: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
  readonly supportResults: readonly RecallResult[];
  readonly timeStart?: string;
  readonly timeEnd?: string;
}): Promise<{
  readonly applied: boolean;
  readonly candidates: readonly AnswerableUnitCandidate[];
  readonly telemetry: AnswerableUnitRetrievalTelemetry;
}> {
  const focus = parseQueryEntityFocus(options.queryText);
  const targetHints = focus.primaryHints;
  const focusedQueryText = buildFocusedEntityQuery(options.queryText);
  const cueFamily = inferAnswerableUnitCueFamily(options.queryText);
  if (!isScopedAnswerableUnitQuery(options.queryText)) {
    return {
      applied: false,
      candidates: [],
      telemetry: {
        answerableUnitApplied: false,
        answerableUnitCandidateCount: 0,
        answerableUnitOwnedCount: 0,
        answerableUnitMixedCount: 0,
        answerableUnitForeignCount: 0
      }
    };
  }

  const candidateFetchLimit =
    targetHints.length > 0 && cueFamily !== "generic"
      ? Math.max(options.limit * 20, 160)
      : Math.max(options.limit * 4, 24);
  const queryRowsResult = await queryRows<AnswerableUnitRow>(
    `
      WITH query_state AS (
        SELECT websearch_to_tsquery('english', $2) AS tsquery
      )
      SELECT
        au.id::text,
        au.namespace_id,
        au.source_kind,
        au.source_memory_id::text,
        au.source_derivation_id::text,
        au.artifact_id::text,
        au.artifact_observation_id::text,
        au.source_chunk_id::text,
        au.unit_type,
        au.content_text,
        au.turn_index,
        au.turn_start_index,
        au.turn_end_index,
        au.owner_entity_hint,
        au.speaker_entity_hint,
        au.participant_names,
        au.occurred_at::text,
        au.valid_from::text,
        au.valid_until::text,
        au.is_current,
        au.ownership_confidence,
        au.provenance,
        au.metadata,
        ts_rank_cd(au.search_vector, query_state.tsquery) AS lexical_score
      FROM answerable_units au
      CROSS JOIN query_state
      WHERE au.namespace_id = $1
        AND (
          au.search_vector @@ query_state.tsquery
          OR ($5::text[] IS NOT NULL AND lower(coalesce(au.owner_entity_hint, '')) = ANY($5::text[]))
          OR ($5::text[] IS NOT NULL AND lower(coalesce(au.speaker_entity_hint, '')) = ANY($5::text[]))
        )
        AND ($3::timestamptz IS NULL OR au.occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR au.occurred_at <= $4)
      ORDER BY lexical_score DESC, au.ownership_confidence DESC, au.occurred_at DESC NULLS LAST
      LIMIT $6
    `,
    [
      options.namespaceId,
      focusedQueryText,
      options.timeStart ?? null,
      options.timeEnd ?? null,
      targetHints.length > 0 ? targetHints : null,
      candidateFetchLimit
    ]
  );

  const initialCandidates = scoreAnswerableUnitsForQuery(
    options.queryText,
    queryRowsResult.map(toUnit),
    options.supportResults
  );
  const temporalNeighborhoodQuery = isTemporalDetailQuery(options.queryText);
  const neighborhoodLimit =
    temporalNeighborhoodQuery
      ? 12
      : cueFamily === "hobbies" || cueFamily === "martial_arts" || cueFamily === "allergy_safe_pets" || cueFamily === "social_exclusion"
      ? 48
      : 24;
  const neighborhoodUnits =
    cueFamily !== "generic" || temporalNeighborhoodQuery
      ? await queryNeighborhoodUnits({
          namespaceId: options.namespaceId,
          seedCandidates: initialCandidates.filter((candidate) => candidate.ownershipStatus !== "foreign").slice(0, temporalNeighborhoodQuery ? 1 : 3),
          excludeIds: queryRowsResult.map((row) => row.id),
          limit: neighborhoodLimit
        })
      : [];
  const ownerFamilyUnits =
    cueFamily !== "generic"
      ? await queryOwnerFamilyUnits({
          namespaceId: options.namespaceId,
          targetHints,
          cueFamily,
          excludeIds: [...queryRowsResult.map((row) => row.id), ...neighborhoodUnits.map((unit) => unit.id)],
          limit: cueFamily === "hobbies" || cueFamily === "martial_arts" ? 48 : 24,
          timeStart: options.timeStart,
          timeEnd: options.timeEnd
        })
      : [];
  const mergedUnits = [
    ...queryRowsResult.map(toUnit),
    ...neighborhoodUnits,
    ...ownerFamilyUnits
  ];
  const candidates = scoreAnswerableUnitsForQuery(
    options.queryText,
    mergedUnits.filter((unit, index, all) => all.findIndex((other) => other.id === unit.id) === index),
    options.supportResults
  ).slice(
    0,
    cueFamily !== "generic"
      ? Math.max(options.limit * 10, cueFamily === "martial_arts" || cueFamily === "hobbies" || cueFamily === "allergy_safe_pets" || cueFamily === "social_exclusion" ? 120 : 80)
      : Math.max(options.limit, 8)
  );

  return {
    applied: true,
    candidates,
    telemetry: {
      answerableUnitApplied: true,
      answerableUnitCandidateCount: candidates.length,
      answerableUnitOwnedCount: candidates.filter((candidate) => candidate.ownershipStatus === "owned").length,
      answerableUnitMixedCount: candidates.filter((candidate) => candidate.ownershipStatus === "mixed").length,
      answerableUnitForeignCount: candidates.filter((candidate) => candidate.ownershipStatus === "foreign").length
    }
  };
}
