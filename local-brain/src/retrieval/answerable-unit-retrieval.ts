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
  const targetHints = extractEntityNameHints(queryText);
  const target = targetHints[0] ?? "";
  return units
    .map<AnswerableUnitCandidate>((unit) => {
      const ownershipStatus = target ? targetSupportFromUnit(target, unit) : "no_subject_signal";
      const subjectMatchScore =
        ownershipStatus === "owned" ? 1.45 :
        ownershipStatus === "mixed" ? 0.2 :
        ownershipStatus === "foreign" ? -1.2 :
        -0.4;
      const temporalScore = temporalScoreForUnit(queryText, unit);
      const authority = authorityScore(unit.unitType);
      const supportScore = supportSeedScore(unit, supportResults);
      const totalScore = unit.lexicalScore + authority + unit.ownershipConfidence + subjectMatchScore + temporalScore + supportScore;
      return {
        unit,
        ownershipStatus,
        subjectMatchScore,
        temporalScore,
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

function extractEntityNameHints(queryText: string): readonly string[] {
  const stopTerms = new Set([
    "what",
    "where",
    "who",
    "when",
    "why",
    "which",
    "how",
    "is",
    "are",
    "was",
    "were",
    "did",
    "does",
    "do",
    "can",
    "could",
    "would",
    "should",
    "will",
    "tell",
    "me",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ]);
  const matches = queryText.match(/\b[A-Z][a-z]+\b/gu) ?? [];
  return [...new Set(matches.map((value) => normalizeWhitespace(value).toLowerCase()))].filter(
    (value) => !stopTerms.has(value)
  );
}

export function isScopedAnswerableUnitQuery(queryText: string): boolean {
  const targets = extractEntityNameHints(queryText);
  if (targets.length !== 1) {
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

function targetSupportFromUnit(target: string, unit: AnswerableUnit): AnswerableUnitOwnershipStatus {
  const owner = unit.ownerEntityHint ?? "";
  const speaker = unit.speakerEntityHint ?? "";
  const participants = unit.participantNames;
  const targetInParticipants = participants.some((value) => value.includes(target));
  const foreignParticipants = participants.filter((value) => !value.includes(target));
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
  const targetHints = extractEntityNameHints(options.queryText);
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
      options.queryText,
      options.timeStart ?? null,
      options.timeEnd ?? null,
      targetHints.length > 0 ? targetHints : null,
      Math.max(options.limit * 4, 24)
    ]
  );

  const candidates = scoreAnswerableUnitsForQuery(
    options.queryText,
    queryRowsResult.map(toUnit),
    options.supportResults
  ).slice(0, Math.max(options.limit, 8));

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
