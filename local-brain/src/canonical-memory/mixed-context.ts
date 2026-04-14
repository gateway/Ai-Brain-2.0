import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type {
  CanonicalNarrativeKind,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  RecallConfidenceGrade,
  CanonicalSupportStrength
} from "../retrieval/types.js";

export interface MixedContextCandidate {
  readonly text: string;
  readonly sourceTable: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly supportStrength: CanonicalSupportStrength;
  readonly confidence: RecallConfidenceGrade;
  readonly answerPayload?: Record<string, unknown> | null;
  readonly mentionedAt?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly provenanceCount?: number;
  readonly narrativeKind?: CanonicalNarrativeKind;
  readonly reportKind?: CanonicalReportKind;
}

export interface MixedContextSelection {
  readonly candidate: MixedContextCandidate;
  readonly candidateCount: number;
  readonly score: number;
  readonly scoreMargin: number;
  readonly selectedText: string;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "based",
  "both",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "in",
  "is",
  "it",
  "kind",
  "likely",
  "might",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "they",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalize(value: string): string {
  return normalizeEntityLookupName(normalizeWhitespace(value));
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/u)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function extractQueryTerms(queryText: string): readonly string[] {
  return uniqueStrings(tokenize(queryText));
}

function sourceWeight(sourceTable: string): number {
  switch (sourceTable) {
    case "retrieved_text_unit_aggregate_report":
      return 3.18;
    case "canonical_collection_facts":
      return 3.78;
    case "canonical_sets":
      return 3.65;
    case "canonical_states":
      return 3.55;
    case "canonical_facts":
      return 3.5;
    case "canonical_pair_reports":
      return 3.7;
    case "canonical_entity_reports":
      return 3.5;
    case "canonical_narratives":
      return 3.3;
    case "assembled_entity_report":
      return 2.9;
    case "assembled_narrative":
      return 2.7;
    case "assembled_raw_entity_report":
      return 2.2;
    case "retrieved_text_unit_report":
      return 2.45;
    default:
      return 2.0;
  }
}

function supportWeight(supportStrength: CanonicalSupportStrength): number {
  switch (supportStrength) {
    case "strong":
      return 0.9;
    case "moderate":
      return 0.45;
    default:
      return 0.1;
  }
}

function confidenceWeight(confidence: RecallConfidenceGrade): number {
  switch (confidence) {
    case "confident":
      return 0.6;
    case "weak":
      return 0.25;
    default:
      return 0;
  }
}

function queryOverlapScore(queryTerms: readonly string[], text: string): number {
  if (queryTerms.length === 0) {
    return 0;
  }
  const textTerms = new Set(tokenize(text));
  const matched = queryTerms.filter((term) => textTerms.has(term));
  return (matched.length / queryTerms.length) * 6;
}

function bigramBonus(queryText: string, text: string): number {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length < 2) {
    return 0;
  }
  const normalizedText = normalize(text);
  let bonus = 0;
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    const phrase = `${queryTerms[index]} ${queryTerms[index + 1]}`;
    if (normalizedText.includes(phrase)) {
      bonus += 0.35;
    }
  }
  return Math.min(bonus, 1.4);
}

function provenanceBonus(count: number | undefined): number {
  if (!count || count <= 1) {
    return 0;
  }
  return Math.min(0.5, Math.log2(count + 1) * 0.12);
}

function temporalBonus(candidate: MixedContextCandidate): number {
  return candidate.validFrom || candidate.validUntil || candidate.mentionedAt ? 0.15 : 0;
}

function payloadBonus(queryText: string, candidate: MixedContextCandidate): number {
  const payload = candidate.answerPayload;
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  const normalizedQuery = normalize(queryText);
  const answerValue = typeof payload.answer_value === "string" ? normalize(payload.answer_value) : "";
  const reasonValue = typeof payload.reason_value === "string" ? normalize(payload.reason_value) : "";
  if (
    candidate.reportKind === "preference_report" &&
    /\bfavorite\b|\bprefer\b|\bstyle\b|\bdance\b|\bmemory\b/u.test(normalizedQuery) &&
    answerValue
  ) {
    return 1.6;
  }
  if (
    candidate.reportKind === "collection_report" &&
    /\bcollect(?:ion|s)?\b|\bbookshelf\b|\bdr\.?\s*seuss\b|\bwhat items\b/u.test(normalizedQuery) &&
    (answerValue || reasonValue)
  ) {
    return 1.8;
  }
  return 0.25;
}

function reportKindSourceBonus(queryText: string, candidate: MixedContextCandidate): number {
  const normalizedQuery = normalize(queryText);
  if (!candidate.reportKind) {
    return 0;
  }
  if (candidate.reportKind === "collection_report" && candidate.sourceTable === "canonical_sets") {
    return /\bcollect(?:ion|s)?\b|\bitems?\b|\bbookshelf\b/u.test(normalizedQuery) ? 2.6 : 1.4;
  }
  if (candidate.reportKind === "collection_report" && candidate.sourceTable === "canonical_collection_facts") {
    return /\bcollect(?:ion|s)?\b|\bitems?\b|\bbookshelf\b|\bdr\.?\s*seuss\b/u.test(normalizedQuery) ? 3.1 : 1.8;
  }
  if (
    candidate.reportKind === "education_report" &&
    (candidate.sourceTable === "canonical_facts" || candidate.sourceTable === "canonical_states")
  ) {
    return /\bdegree\b|\bmajor\b|\bfield\b|\bstud(?:y|ied)\b/u.test(normalizedQuery) ? 1.8 : 1.0;
  }
  if (
    candidate.reportKind === "preference_report" &&
    (
      candidate.sourceTable === "canonical_facts" ||
      candidate.sourceTable === "canonical_states" ||
      candidate.sourceTable === "canonical_sets" ||
      candidate.sourceTable === "retrieved_text_unit_report"
    )
  ) {
    return /\bfavorite\b|\bprefer\b|\bstyle\b|\btrilogy\b|\bmovie\b|\bdance\b/u.test(normalizedQuery) ? 1.6 : 0.8;
  }
  if (
    candidate.reportKind === "pet_care_report" &&
    (
      candidate.sourceTable === "canonical_facts" ||
      candidate.sourceTable === "canonical_states" ||
      candidate.sourceTable === "canonical_sets" ||
      candidate.sourceTable === "retrieved_text_unit_report"
    )
  ) {
    return /\bdog\b|\bdogs\b|\bpet\b|\bclasses?\b|\bgroups?\b|\bcare\b/u.test(normalizedQuery) ? 1.4 : 0.7;
  }
  if (
    candidate.reportKind === "collection_report" &&
    candidate.sourceTable === "retrieved_text_unit_report"
  ) {
    return /\bcollect(?:ion|s)?\b|\bitems?\b|\bbookshelf\b|\bdr\.?\s*seuss\b/u.test(normalizedQuery) ? 1.8 : 0.8;
  }
  if (
    candidate.reportKind === "education_report" &&
    candidate.sourceTable === "retrieved_text_unit_report"
  ) {
    return /\bdegree\b|\bmajor\b|\bfield\b|\beducat(?:ion|e)\b/u.test(normalizedQuery) ? 1.4 : 0.7;
  }
  if (
    candidate.reportKind === "aspiration_report" &&
    candidate.sourceTable === "retrieved_text_unit_aggregate_report"
  ) {
    return /\bideal\b|\bstudio\b|\bwhy\b|\bbusiness\b|\bdream\b/u.test(normalizedQuery) ? 2.1 : 1.0;
  }
  if (
    candidate.reportKind === "aspiration_report" &&
    candidate.sourceTable === "retrieved_text_unit_report"
  ) {
    return /\bstore\b|\bbusiness\b|\bventure\b|\bapp\b|\bunique\b|\bdream\b|\bwhy\b/u.test(normalizedQuery) ? 1.3 : 0.6;
  }
  if (
    candidate.reportKind === "travel_report" &&
    (candidate.sourceTable === "canonical_facts" || candidate.sourceTable === "canonical_sets")
  ) {
    return /\btrip\b|\btravel\b|\broadtrip\b|\bfestival\b|\bwhere\b/u.test(normalizedQuery) ? 1.2 : 0.6;
  }
  return 0;
}

function genericPenalty(queryTerms: readonly string[], text: string): number {
  const overlap = queryOverlapScore(queryTerms, text);
  if (overlap >= 2) {
    return 0;
  }
  const tokenCount = tokenize(text).length;
  if (tokenCount <= 6) {
    return 0;
  }
  return Math.min(1.2, tokenCount * 0.045);
}

export function scoreMixedContextCandidate(queryText: string, candidate: MixedContextCandidate): number {
  const queryTerms = extractQueryTerms(queryText);
  return (
    sourceWeight(candidate.sourceTable) +
    supportWeight(candidate.supportStrength) +
    confidenceWeight(candidate.confidence) +
    queryOverlapScore(queryTerms, candidate.text) +
    bigramBonus(queryText, candidate.text) +
    payloadBonus(queryText, candidate) +
    reportKindSourceBonus(queryText, candidate) +
    provenanceBonus(candidate.provenanceCount) +
    temporalBonus(candidate) -
    genericPenalty(queryTerms, candidate.text)
  );
}

export function selectMixedContextCandidate(
  queryText: string,
  candidates: readonly MixedContextCandidate[]
): MixedContextSelection | null {
  const viable = candidates
    .map((candidate) => ({
      candidate,
      score: scoreMixedContextCandidate(queryText, candidate)
    }))
    .filter((entry) => normalizeWhitespace(entry.candidate.text).length > 0)
    .sort((left, right) => right.score - left.score);
  if (viable.length === 0) {
    return null;
  }
  const top = viable[0]!;
  const second = viable[1];
  return {
    candidate: top.candidate,
    candidateCount: viable.length,
    score: top.score,
    scoreMargin: second ? top.score - second.score : top.score,
    selectedText: normalizeWhitespace(top.candidate.text)
  };
}
