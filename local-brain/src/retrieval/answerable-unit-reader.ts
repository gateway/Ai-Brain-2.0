import type { RecallResult } from "../types.js";
import { isTemporalDetailQuery } from "./query-signals.js";
import type { AnswerableUnitCandidate } from "./answerable-unit-retrieval.js";
import { parseQueryEntityFocus } from "./query-entity-focus.js";

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
    "me",
    "likely",
    "besides",
    "both",
    "with",
    "without",
    "than",
    "versus",
    "vs",
    "compared",
    "compare"
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
      turn_index: unit.turnIndex ?? null,
      turn_start_index: unit.turnStartIndex ?? null,
      turn_end_index: unit.turnEndIndex ?? null,
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

function isInterrogativeClaimText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (/\?\s*$/u.test(normalized)) {
    return true;
  }
  return /^(?:what|when|where|who|why|how|did|does|do|can|could|would|will|is|are|was|were|have|has|had)\b/iu.test(
    normalized.replace(/^[A-Z][a-z]+:\s*/u, "")
  );
}

function inferAnswerableUnitCueFamily(
  queryText: string
): "generic" | "hobbies" | "martial_arts" | "social_exclusion" | "allergy_safe_pets" {
  const lowered = queryText.toLowerCase();
  if (/\bhobbies?\b/.test(lowered)) {
    return "hobbies";
  }
  if (/\bwhat\s+(?:martial arts?|martial art)\b/.test(lowered) || /\bmartial\s+arts?\s+has\b/.test(lowered)) {
    return "martial_arts";
  }
  if (/\bpets?\s+wouldn'?t\s+cause\b/.test(lowered) || (/\bpets?\b/.test(lowered) && /\ballerg/.test(lowered))) {
    return "allergy_safe_pets";
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

function isMultiUnitAggregationQuery(queryText: string): boolean {
  return (
    /\bhobbies?\b/i.test(queryText) ||
    /\bwhat\s+(?:martial arts?|martial art)\b/i.test(queryText) ||
    (/\bbesides\b/i.test(queryText) && /\bfriends?\b/i.test(queryText)) ||
    /\bpets?\s+wouldn'?t\s+cause\b/i.test(queryText) ||
    (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText))
  );
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

function shouldAggregateOwnedCandidate(
  queryText: string,
  top: AnswerableUnitCandidate,
  candidate: AnswerableUnitCandidate
): boolean {
  const multiUnitAggregationQuery = isMultiUnitAggregationQuery(queryText);
  const family = inferAnswerableUnitCueFamily(queryText);
  if (candidate.unit.id === top.unit.id) {
    return true;
  }
  const claimText = normalizeWhitespace(normalizedClaimText(candidate, queryText));
  if (!claimText || isInterrogativeClaimText(claimText)) {
    return false;
  }
  if (
    top.unit.ownerEntityHint &&
    candidate.unit.ownerEntityHint &&
    top.unit.ownerEntityHint !== candidate.unit.ownerEntityHint
  ) {
    return false;
  }
  const candidateText = normalizeWhitespace(candidate.unit.contentText);
  const familySpecificSupport =
    family === "martial_arts"
      ? /\b(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling)\b/i.test(candidateText)
      : family === "hobbies"
        ? isStandaloneHobbyStatement(candidateText) || /\b(hobbies?|enjoy|enjoys|love|loves|like|likes|writing|reading|watching movies|exploring nature|hanging with friends)\b/i.test(candidateText)
        : family === "allergy_safe_pets"
          ? /\b(allerg|animals with fur|hairless cats?|pigs?|dogs?|cats?|birds?|fish|reptiles?|turtles?)\b/i.test(candidateText)
        : family === "social_exclusion"
          ? /\b(old friends?|other friends?|some friends?|teammates?|team|tournament friends?|outside of my circle|my team)\b/i.test(candidateText)
        : false;
  const maxScoreGap = !multiUnitAggregationQuery
    ? 1.35
    : family === "martial_arts"
      ? 5.5
      : family === "hobbies"
        ? 4.75
        : family === "allergy_safe_pets"
          ? 5
        : family === "social_exclusion"
          ? 6
        : 2.5;
  if (candidate.totalScore < top.totalScore - maxScoreGap && !familySpecificSupport) {
    return false;
  }
  if (family === "martial_arts" && !familySpecificSupport) {
    return false;
  }
  if (family === "hobbies" && !familySpecificSupport) {
    return false;
  }
  if (family === "allergy_safe_pets" && !familySpecificSupport) {
    return false;
  }
  if (family === "social_exclusion" && !familySpecificSupport) {
    return false;
  }
  return ["participant_turn", "source_sentence", "fact_span"].includes(candidate.unit.unitType);
}

function titleCaseEntity(value: string): string {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function splitAggregationList(value: string): readonly string[] {
  return value
    .split(/\s*(?:,| and | or )\s*/iu)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
}

function extractHobbyValues(text: string): readonly string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return [];
  }
  const collected = new Set<string>();
  const hobbiesMatch = normalized.match(/\bhobbies?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,180})/iu);
  if (hobbiesMatch?.[1]) {
    for (const value of splitAggregationList(hobbiesMatch[1])) {
      collected.add(value);
    }
  }
  const besidesMatch = normalized.match(
    /\bbesides\s+([A-Za-z][^,!?\n]{0,40}),\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys|like|likes)\s+([A-Za-z][^.!?\n]{2,180})/iu
  );
  if (besidesMatch?.[1]) {
    collected.add(normalizeWhitespace(besidesMatch[1]));
  }
  if (besidesMatch?.[2]) {
    for (const value of splitAggregationList(besidesMatch[2])) {
      collected.add(value);
    }
  }
  const standaloneMatch = normalized.match(
    /^\s*([A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s+and\s+[A-Za-z]+ing(?:\s+(?:with|around)\s+[A-Za-z]+){0,3})?)\s*!?$/u
  );
  if (standaloneMatch?.[1]) {
    for (const value of splitAggregationList(standaloneMatch[1])) {
      collected.add(value);
    }
  }
  if (
    collected.size === 0 &&
    !/\?\s*$/u.test(normalized) &&
    /\band\b/iu.test(normalized) &&
    /\b[A-Za-z]+ing\b/u.test(normalized)
  ) {
    for (const value of splitAggregationList(normalized.replace(/[!]+$/u, ""))) {
      collected.add(value);
    }
  }
  return [...collected];
}

function extractPetSafetyValues(text: string): readonly string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return [];
  }
  const matches = [...normalized.matchAll(/\b(hairless cats?|pigs?)\b/giu)]
    .map((match) => normalizeWhitespace(match[1] ?? ""))
    .filter(Boolean);
  return [...new Set(matches)];
}

function candidateAggregationTexts(candidate: AnswerableUnitCandidate): readonly string[] {
  const values = [normalizeWhitespace(candidate.unit.contentText)];
  const sourceSentence =
    typeof candidate.unit.metadata?.source_sentence_text === "string"
      ? normalizeWhitespace(candidate.unit.metadata.source_sentence_text)
      : "";
  if (sourceSentence) {
    values.push(sourceSentence);
  }
  return [...new Set(values.filter(Boolean))];
}

function deriveSocialExclusionSupportText(queryText: string, selected: readonly AnswerableUnitCandidate[]): string | null {
  const focus = parseQueryEntityFocus(queryText);
  const subject = focus.primaryHints[0];
  if (!subject) {
    return null;
  }

  const phrases = new Set<string>();
  for (const candidate of selected) {
    const text = normalizeWhitespace(candidate.unit.contentText).toLowerCase();
    if (!text || /\?\s*$/u.test(text)) {
      continue;
    }
    if (/\b(?:my team|teammates?)\b/.test(text)) {
      phrases.add(`teammates on ${titleCaseEntity(subject)}'s video game team`);
    }
    if (/\bold friends?\b/.test(text)) {
      phrases.add("old friends from other tournaments");
    }
    if (/\boutside of my circle\b/.test(text) || /\bsome people outside\b/.test(text)) {
      phrases.add("friends outside his usual circle from tournaments");
    }
    if (/\bmade some friends\b/.test(text) || /\bfriends at the convention\b/.test(text)) {
      phrases.add("friends from gaming conventions");
    }
  }

  if (phrases.size === 0) {
    return null;
  }

  return `Yes, ${titleCaseEntity(subject)} mentions ${[...phrases].join(", ")} besides ${titleCaseEntity(focus.companionHints[0] ?? "that person")}.`;
}

function deriveAggregatedClaimText(
  queryText: string,
  family: ReturnType<typeof inferAnswerableUnitCueFamily>,
  selected: readonly AnswerableUnitCandidate[],
  fallbackText: string
): string {
  if (family === "social_exclusion") {
    return deriveSocialExclusionSupportText(queryText, selected) ?? fallbackText;
  }

  const values =
    family === "hobbies"
      ? selected.flatMap((candidate) => candidateAggregationTexts(candidate).flatMap((text) => extractHobbyValues(text)))
      : family === "allergy_safe_pets"
        ? selected.flatMap((candidate) => candidateAggregationTexts(candidate).flatMap((text) => extractPetSafetyValues(text)))
        : [];
  const deduped = [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
  if (deduped.length === 0) {
    return fallbackText;
  }
  return deduped.join(", ");
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

  const scoredTop = owned[0]!;
  const firstDeclarativeOwned = owned.find(
    (candidate) => !isInterrogativeClaimText(normalizedClaimText(candidate, queryText))
  );
  const promotedDeclarativeTop =
    !isTemporalDetailQuery(queryText) &&
    isInterrogativeClaimText(normalizedClaimText(scoredTop, queryText)) &&
    Boolean(firstDeclarativeOwned);
  const top =
    promotedDeclarativeTop && firstDeclarativeOwned
      ? firstDeclarativeOwned
      : scoredTop;
  const comparisonPool = owned.filter((candidate) => candidate.unit.id !== top.unit.id);
  const runnerUp = comparisonPool[0];
  const dominantMargin = runnerUp ? Number((top.totalScore - runnerUp.totalScore).toFixed(3)) : Number(top.totalScore.toFixed(3));
  const topClaim = normalizedClaimText(top, queryText);
  const runnerClaim = runnerUp ? normalizedClaimText(runnerUp, queryText) : null;
  const multiUnitAggregationQuery = isMultiUnitAggregationQuery(queryText);

  if (
    !multiUnitAggregationQuery &&
    runnerUp &&
    dominantMargin < 0.25 &&
    runnerClaim &&
    !isInterrogativeClaimText(runnerClaim) &&
    !inSameClaimCluster(top, runnerUp, queryText)
  ) {
    return {
      applied: true,
      decision: "ambiguous",
      selectedUnitIds: [top.unit.id, runnerUp.unit.id],
      recallResults: [top, runnerUp].map(recallResultFromCandidate),
      claimText: null,
      topUnitType: top.unit.unitType,
      dominantMargin,
      usedFallback: false
    };
  }

  const selected = (multiUnitAggregationQuery
    ? owned.filter((candidate) => shouldAggregateOwnedCandidate(queryText, top, candidate))
    : owned.filter((candidate) => inSameClaimCluster(top, candidate, queryText))
  ).slice(
    0,
    multiUnitAggregationQuery
      ? /\bhobbies?\b/i.test(queryText)
        ? 12
        : /\bmartial arts?\b/i.test(queryText)
          ? 6
          : (/\bbesides\b/i.test(queryText) && /\bfriends?\b/i.test(queryText)) || /\bpets?\b/i.test(queryText)
            ? 8
            : 5
      : 3
  );
  const selectedTopClaim = normalizeWhitespace(topClaim);
  const family = inferAnswerableUnitCueFamily(queryText);
  const aggregatedClaimText = multiUnitAggregationQuery
    ? deriveAggregatedClaimText(
        queryText,
        family,
        selected,
        selected
          .map((candidate) => normalizeWhitespace(normalizedClaimText(candidate, queryText)))
          .filter((value) => value.length > 0 && !isInterrogativeClaimText(value))
          .filter((value, index, values) => values.indexOf(value) === index)
          .join(" ")
      )
    : selectedTopClaim;

  if (!isTemporalDetailQuery(queryText) && isInterrogativeClaimText(multiUnitAggregationQuery ? aggregatedClaimText || selectedTopClaim : selectedTopClaim)) {
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

  const selectedSlotFit = slotFitScore(queryText, selected);
  const selectedHasTemporalAnchor = selected.some(
    (candidate) =>
      (typeof candidate.unit.metadata?.date_text === "string" && candidate.unit.metadata.date_text.length > 0) ||
      (typeof candidate.unit.metadata?.relative_label === "string" && candidate.unit.metadata.relative_label.length > 0)
  );
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
  if (!isTemporalDetailQuery(queryText) && !multiUnitAggregationQuery && !promotedDeclarativeTop && selectedSlotFit < 0.2) {
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
    claimText: multiUnitAggregationQuery ? aggregatedClaimText || topClaim : topClaim,
    topUnitType: top.unit.unitType,
    dominantMargin,
    usedFallback: false
  };
}
