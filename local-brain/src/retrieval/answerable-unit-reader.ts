import type { RecallResult } from "../types.js";
import { isTemporalDetailQuery } from "./query-signals.js";
import type { AnswerableUnitCandidate } from "./answerable-unit-retrieval.js";

export type ReaderDecision =
  | "resolved"
  | "ambiguous"
  | "abstained_no_owned_unit"
  | "abstained_temporal_gap"
  | "abstained_alias_ambiguity";

export interface ReaderResult {
  readonly applied: boolean;
  readonly decision: ReaderDecision;
  readonly selectedUnitIds: readonly string[];
  readonly recallResults: readonly RecallResult[];
  readonly claimText: string | null;
  readonly topUnitType?: string;
  readonly dominantMargin?: number;
  readonly usedFallback: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function canonicalizeClaimText(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^[A-Z][a-z]+:\s*/u, "")
    .toLowerCase();
}

function normalizeToken(value: string): string {
  const lowered = value.toLowerCase();
  const synonym =
    lowered === "mom" ? "mother" :
    lowered === "mother's" ? "mother" :
    lowered === "dad" ? "father" :
    lowered === "father's" ? "father" :
    lowered === "passed" ? "pass" :
    lowered === "mesmerizes" ? "mesmerize" :
    lowered === "adopted" ? "adopt" :
    lowered === "lost" ? "lose" :
    lowered;
  return synonym
    .replace(/'s$/u, "")
    .replace(/ing$/u, "")
    .replace(/ed$/u, "")
    .replace(/es$/u, "")
    .replace(/s$/u, "");
}

function queryCueTerms(queryText: string): readonly string[] {
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
    "has",
    "have",
    "had",
    "the",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "for",
    "and",
    "or",
    "tell",
    "me"
  ]);
  const entityTokens = new Set((queryText.match(/\b[A-Z][a-z]+\b/gu) ?? []).map((token) => normalizeToken(token)));
  const tokens = queryText.match(/[A-Za-z']+/gu) ?? [];
  return [...new Set(tokens.map((token) => normalizeToken(token)).filter((token) => token.length > 1 && !stopTerms.has(token) && !entityTokens.has(token)))];
}

function unitTokens(candidate: AnswerableUnitCandidate): Set<string> {
  const tokens = [
    candidate.unit.contentText,
    typeof candidate.unit.metadata?.date_text === "string" ? candidate.unit.metadata.date_text : ""
  ]
    .join(" ")
    .match(/[A-Za-z']+/gu) ?? [];
  return new Set(tokens.map((token) => normalizeToken(token)).filter((token) => token.length > 1));
}

function recallResultFromCandidate(candidate: AnswerableUnitCandidate): RecallResult {
  const unit = candidate.unit;
  return {
    memoryId: unit.sourceMemoryId ?? unit.sourceDerivationId ?? unit.id,
    memoryType: unit.sourceKind === "episodic_memory" ? "episodic_memory" : "artifact_derivation",
    content: unit.contentText,
    score: candidate.totalScore,
    artifactId: unit.artifactId ?? null,
    occurredAt: unit.occurredAt ?? null,
    namespaceId: unit.namespaceId,
    provenance: {
      tier: "answerable_unit",
      answerable_unit_id: unit.id,
      answerable_unit_type: unit.unitType,
      owner_entity_hint: unit.ownerEntityHint ?? null,
      speaker_entity_hint: unit.speakerEntityHint ?? null,
      participant_names: unit.participantNames,
      source_kind: unit.sourceKind,
      source_memory_id: unit.sourceMemoryId ?? null,
      source_derivation_id: unit.sourceDerivationId ?? null,
      source_chunk_id: unit.sourceChunkId ?? null,
      artifact_observation_id: unit.artifactObservationId ?? null,
      metadata: unit.metadata,
      provenance: unit.provenance
    }
  };
}

function normalizedClaimText(candidate: AnswerableUnitCandidate, queryText: string): string {
  const unit = candidate.unit;
  const metadata = unit.metadata ?? {};
  if (isTemporalDetailQuery(queryText) && typeof metadata.date_text === "string" && metadata.date_text.length > 0) {
    return metadata.date_text;
  }
  return normalizeWhitespace(unit.contentText);
}

function inSameClaimCluster(left: AnswerableUnitCandidate, right: AnswerableUnitCandidate, queryText: string): boolean {
  if (left.unit.id === right.unit.id) {
    return true;
  }
  if (left.unit.sourceMemoryId && right.unit.sourceMemoryId && left.unit.sourceMemoryId === right.unit.sourceMemoryId) {
    return true;
  }
  if (left.unit.sourceChunkId && right.unit.sourceChunkId && left.unit.sourceChunkId === right.unit.sourceChunkId) {
    return true;
  }
  const leftClaim = canonicalizeClaimText(normalizedClaimText(left, queryText));
  const rightClaim = canonicalizeClaimText(normalizedClaimText(right, queryText));
  return leftClaim.length > 0 && leftClaim === rightClaim;
}

function slotFitScore(queryText: string, candidates: readonly AnswerableUnitCandidate[]): number {
  const cues = queryCueTerms(queryText);
  if (cues.length === 0) {
    return 0;
  }
  const tokenBag = new Set<string>();
  for (const candidate of candidates) {
    for (const token of unitTokens(candidate)) {
      tokenBag.add(token);
    }
  }
  let matches = 0;
  for (const cue of cues) {
    if (tokenBag.has(cue)) {
      matches += 1;
    }
  }
  return matches / cues.length;
}

export function selectReaderResult(queryText: string, candidates: readonly AnswerableUnitCandidate[]): ReaderResult {
  if (candidates.length === 0) {
    return {
      applied: false,
      decision: "abstained_no_owned_unit",
      selectedUnitIds: [],
      recallResults: [],
      claimText: null,
      usedFallback: false
    };
  }

  const owned = candidates.filter((candidate) => candidate.ownershipStatus === "owned");
  if (owned.length === 0) {
    const temporalCandidate = isTemporalDetailQuery(queryText)
      ? candidates.find((candidate) => candidate.unit.unitType === "date_span")
      : null;
    return {
      applied: true,
      decision: temporalCandidate ? "abstained_temporal_gap" : "abstained_no_owned_unit",
      selectedUnitIds: temporalCandidate ? [temporalCandidate.unit.id] : [],
      recallResults: [],
      claimText: null,
      topUnitType: temporalCandidate?.unit.unitType,
      usedFallback: false
    };
  }

  const top = owned[0]!;
  const runnerUp = owned[1];
  const dominantMargin = runnerUp ? Number((top.totalScore - runnerUp.totalScore).toFixed(3)) : Number(top.totalScore.toFixed(3));
  const topClaim = normalizedClaimText(top, queryText);
  const runnerClaim = runnerUp ? normalizedClaimText(runnerUp, queryText) : null;

  if (
    runnerUp &&
    dominantMargin < 0.25 &&
    runnerClaim &&
    !inSameClaimCluster(top, runnerUp, queryText)
  ) {
    return {
      applied: true,
      decision: "ambiguous",
      selectedUnitIds: [top.unit.id, runnerUp.unit.id],
      recallResults: [],
      claimText: null,
      topUnitType: top.unit.unitType,
      dominantMargin,
      usedFallback: false
    };
  }

  const selected = owned
    .filter((candidate) => inSameClaimCluster(top, candidate, queryText))
    .slice(0, 3);

  const selectedSlotFit = slotFitScore(queryText, selected);
  const selectedHasTemporalAnchor = selected.some((candidate) => typeof candidate.unit.metadata?.date_text === "string");
  if (isTemporalDetailQuery(queryText) && (!selectedHasTemporalAnchor || selectedSlotFit < 0.34)) {
    return {
      applied: true,
      decision: "abstained_no_owned_unit",
      selectedUnitIds: selected.map((candidate) => candidate.unit.id),
      recallResults: [],
      claimText: null,
      topUnitType: top.unit.unitType,
      dominantMargin,
      usedFallback: false
    };
  }
  if (!isTemporalDetailQuery(queryText) && selectedSlotFit < 0.2) {
    return {
      applied: true,
      decision: "abstained_alias_ambiguity",
      selectedUnitIds: selected.map((candidate) => candidate.unit.id),
      recallResults: [],
      claimText: null,
      topUnitType: top.unit.unitType,
      dominantMargin,
      usedFallback: false
    };
  }

  return {
    applied: true,
    decision: "resolved",
    selectedUnitIds: selected.map((candidate) => candidate.unit.id),
    recallResults: selected.map(recallResultFromCandidate),
    claimText: topClaim,
    topUnitType: top.unit.unitType,
    dominantMargin,
    usedFallback: false
  };
}
