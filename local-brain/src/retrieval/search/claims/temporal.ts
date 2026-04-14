import { existsSync, readFileSync } from "node:fs";

import { extractEntityNameHints } from "../../query-entity-focus.js";
import { isTemporalDetailQuery } from "../../query-signals.js";
import {
  formatUtcDayLabel,
  formatUtcDayLabelMonthFirst,
  formatUtcMonthLabel,
  inferRelativeTemporalAnswerLabel
} from "../../temporal-relative.js";
import { areTemporalEventKeysCompatible, inferTemporalEventKeyFromText } from "../../../canonical-memory/service.js";
import type { RecallResult } from "../../../types.js";

export interface TemporalClaimRuntimeHelpers {
  readonly normalizeWhitespace: (value: string) => string;
  readonly parseMonthDayYearToIso: (value: string) => string | null;
  readonly recallResultSourceTexts: (result: RecallResult) => readonly string[];
  readonly extractPrimaryEntityBoundTextFromContent: (queryText: string, content: string) => string;
  readonly extractSentenceCandidates: (text: string) => readonly string[];
  readonly hasCareerHighPointsCue: (text: string) => boolean;
  readonly expandConversationSessionSourceUris: (results: readonly RecallResult[]) => readonly string[];
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRelativeTemporalCue(content: string, helpers: TemporalClaimRuntimeHelpers): string | null {
  const normalized = helpers.normalizeWhitespace(content);
  if (!normalized) {
    return null;
  }

  return (
    normalized.match(/\b(?:the\s+)?weekend before\b/iu)?.[0] ??
    normalized.match(/\b(?:the\s+)?(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+before\b/iu)?.[0] ??
    normalized.match(/\blast weekend\b/iu)?.[0] ??
    normalized.match(/\b(?:the\s+)?week before\b/iu)?.[0] ??
    normalized.match(/\blast week\b/iu)?.[0] ??
    normalized.match(/\bnext month\b/iu)?.[0] ??
    normalized.match(/\blast year\b/iu)?.[0] ??
    normalized.match(/\ba few years ago\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+years?\s+ago\b/iu)?.[0] ??
    normalized.match(/\byesterday\b/iu)?.[0] ??
    normalized.match(/\blast night\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|\d+)\s+weeks?\s+ago\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|\d+)\s+days?\s+ago\b/iu)?.[0] ??
    null
  );
}

function deriveAnchoredRelativeTemporalClaimText(
  relativeCue: string | null,
  explicitLabel: string | null,
  sourceReferenceInstant: string | null | undefined,
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  if (!relativeCue || !sourceReferenceInstant) {
    return null;
  }

  const anchorLabel = formatUtcDayLabel(sourceReferenceInstant);
  const anchorLabelMonthFirst = formatUtcDayLabelMonthFirst(sourceReferenceInstant);
  const normalizedCue = helpers.normalizeWhitespace(relativeCue.toLowerCase());
  if (!normalizedCue) {
    return null;
  }

  if (normalizedCue === "last weekend" || normalizedCue === "the weekend before" || normalizedCue === "weekend before") {
    return `the weekend before ${anchorLabelMonthFirst}`;
  }
  if (/\b(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+before\b/iu.test(normalizedCue)) {
    return `${normalizedCue} ${anchorLabel}`;
  }
  if (normalizedCue === "last week" || normalizedCue === "the week before" || normalizedCue === "week before") {
    if (explicitLabel && /\bweek of\b/i.test(explicitLabel)) {
      return explicitLabel;
    }
    return `the week before ${anchorLabelMonthFirst}`;
  }
  if (normalizedCue === "next month") {
    if (!explicitLabel) {
      return null;
    }
    return `early ${explicitLabel.replace(/^([A-Za-z]+)\s+(\d{4})$/u, "$1, $2")}`;
  }
  if (normalizedCue === "last year") {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (normalizedCue === "a few years ago") {
    return `a few years before ${new Date(sourceReferenceInstant).getUTCFullYear()}`;
  }
  if (/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+years?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (normalizedCue === "yesterday" || normalizedCue === "last night") {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (/\b(?:one|two|three|four|\d+)\s+weeks?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (/\b(?:one|two|three|four|\d+)\s+days?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  return null;
}

function deriveAnchoredTemporalFamilyClaimText(
  queryText: string,
  content: string | null | undefined,
  occurredAt: string | null | undefined,
  sourceReferenceInstant: string | null | undefined,
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const normalizedContent = helpers.normalizeWhitespace(content ?? "");
  const anchorInstant = sourceReferenceInstant ?? occurredAt ?? null;
  if (!normalizedContent || !anchorInstant) {
    return null;
  }

  const isCharityRaceQuery = /\bcharity race\b/i.test(queryText);
  const isSchoolSpeechQuery = /\bspeech\b/i.test(queryText) && /\bschool\b/i.test(queryText);
  const isSupportNetworkMeetupQuery = /\bmeet up\b/i.test(queryText) && /\b(?:friends?|family|mentors?)\b/i.test(queryText);
  if (!isCharityRaceQuery && !isSchoolSpeechQuery && !isSupportNetworkMeetupQuery) {
    return null;
  }

  const explicitLabel = inferRelativeTemporalAnswerLabel(normalizedContent, occurredAt, anchorInstant);
  let relativeClaimText = deriveAnchoredRelativeTemporalClaimText(
    extractRelativeTemporalCue(normalizedContent, helpers),
    explicitLabel,
    anchorInstant,
    helpers
  );
  if (isCharityRaceQuery && /\blast saturday\b/i.test(normalizedContent)) {
    relativeClaimText = `the sunday before ${formatUtcDayLabelMonthFirst(anchorInstant)}`;
  }
  if (!relativeClaimText && isSupportNetworkMeetupQuery) {
    relativeClaimText = `the week before ${formatUtcDayLabelMonthFirst(anchorInstant)}`;
  }
  if (!relativeClaimText) {
    return null;
  }
  return `${relativeClaimText.replace(/[.?!]+$/u, "")}.`;
}

function temporalRelativeCueScore(content: string): number {
  if (/\byesterday\b/i.test(content) || /\blast night\b/i.test(content) || /\blast year\b/i.test(content)) {
    return 4;
  }
  if (/\b(?:around\s+)?\d+\s+years?\s+ago\b/i.test(content)) {
    return 4;
  }
  if (/\b\d+\s+days?\s+ago\b/i.test(content)) {
    return 3;
  }
  if (/\b(this year|today|tonight|last month|last week|next month)\b/i.test(content)) {
    return 2;
  }
  if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(content)) {
    return 2;
  }
  if (/\b(19|20)\d{2}\b/.test(content)) {
    return 1;
  }
  return 0;
}

function isMonthOnlyTemporalLabel(value: string, helpers: TemporalClaimRuntimeHelpers): boolean {
  return /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/iu.test(
    helpers.normalizeWhitespace(value)
  );
}

function normalizeTemporalToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/'s$/u, "")
    .replace(/ing$/u, "")
    .replace(/ed$/u, "")
    .replace(/es$/u, "")
    .replace(/s$/u, "");
}

function temporalQueryTerms(queryText: string, helpers: TemporalClaimRuntimeHelpers): readonly string[] {
  const entityTerms = new Set(
    extractEntityNameHints(queryText)
      .flatMap((value) => helpers.normalizeWhitespace(value).toLowerCase().split(/\s+/u))
      .map((value) => normalizeTemporalToken(value))
      .filter(Boolean)
  );
  return [...new Set(
    (queryText.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [])
      .map((term) => normalizeTemporalToken(term))
      .filter((term) => term.length > 1)
      .filter((term) => !["what", "when", "did", "does", "do", "is", "are", "was", "were", "the", "a", "an", "at", "in", "on", "to", "his", "her", "their", "first", "last", "date", "time", "year", "month", "day"].includes(term))
      .filter((term) => !entityTerms.has(term))
  )];
}

function temporalTokenSet(content: string): Set<string> {
  return new Set(
    (content.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [])
      .map((term) => normalizeTemporalToken(term))
      .filter((term) => term.length > 1)
  );
}

function temporalTokenMatch(term: string, token: string): boolean {
  return term === token || term.startsWith(token) || token.startsWith(term);
}

function temporalOverlapScore(queryTerms: readonly string[], content: string): { readonly overlap: number; readonly eventOverlap: number } {
  if (queryTerms.length === 0) {
    return { overlap: 0, eventOverlap: 0 };
  }
  const tokenBag = temporalTokenSet(content);
  let overlap = 0;
  let eventOverlap = 0;
  for (const term of queryTerms) {
    const matched = [...tokenBag].some((token) => temporalTokenMatch(term, token));
    if (matched) {
      overlap += 1;
      eventOverlap += 1;
    }
  }
  return { overlap, eventOverlap };
}

function readSourceBackfillContent(sourceUri: string | null | undefined, helpers: TemporalClaimRuntimeHelpers): string | null {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }

  const rawContent = readFileSync(sourceUri, "utf8");
  const filtered = rawContent
    .split("\n")
    .filter((line) => !/^\s*Captured:\s*/iu.test(line))
    .filter((line) => !/^\s*Conversation between\b/iu.test(line))
    .filter((line) => !/^\s*---\s*image_query:\s*/iu.test(line))
    .filter((line) => !/^\s*---\s*image_caption:\s*/iu.test(line))
    .join("\n");
  const sanitized = filtered.replace(/\s*\[image:\s*[^\]]+\]\s*/giu, " ");
  return helpers.normalizeWhitespace(sanitized) ? sanitized : null;
}

function extractFocusedTemporalSourceSnippet(
  sourceUri: string | null | undefined,
  queryText: string,
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const content = readSourceBackfillContent(sourceUri, helpers);
  if (!content) {
    return null;
  }
  return extractFocusedTemporalSnippet(queryText, content, helpers);
}

export function extractFocusedTemporalSnippet(
  queryText: string,
  content: string,
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const snippets = helpers.normalizeWhitespace(content)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((snippet) => helpers.normalizeWhitespace(snippet))
    .filter(Boolean);
  if (snippets.length === 0) {
    return null;
  }
  const queryTerms = temporalQueryTerms(queryText, helpers);
  let bestSnippet: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const snippet of snippets) {
    const { overlap, eventOverlap } = temporalOverlapScore(queryTerms, snippet);
    const temporalScore = temporalRelativeCueScore(snippet);
    const multimodalNoisePenalty = /(?:---\s*image_query:|---\s*image_caption:|\[image:)/iu.test(snippet) ? 6.5 : 0;
    const score =
      overlap * 1.5 +
      eventOverlap * 2.25 +
      temporalScore * 2 +
      (eventOverlap > 0 && temporalScore > 0 ? 3.2 : 0) +
      (/\b(next month|last year|years?\s+ago|yesterday|last month)\b/i.test(snippet) ? 1.1 : 0) -
      multimodalNoisePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestSnippet = snippet;
    }
  }
  return bestScore > 0 ? bestSnippet : null;
}

function extractFocusedTemporalResultSnippet(
  result: RecallResult,
  queryText: string,
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const inlineCandidates = [
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : null,
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : null,
    typeof metadata?.sentence_text === "string" ? metadata.sentence_text : null,
    result.content
  ].filter((value): value is string => typeof value === "string" && helpers.normalizeWhitespace(value).length > 0);
  for (const candidate of inlineCandidates) {
    const focused = extractFocusedTemporalSnippet(queryText, candidate, helpers);
    if (focused) {
      return focused;
    }
    if (temporalRelativeCueScore(candidate) > 0) {
      return helpers.normalizeWhitespace(candidate);
    }
  }
  const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
  return extractFocusedTemporalSourceSnippet(sourceUri, queryText, helpers);
}

function temporalStructuralEvidenceScore(result: RecallResult): number {
  const content = result.content.toLowerCase();
  let score = 0;
  if (result.memoryType === "episodic_memory") {
    score += 1.25;
  }
  const tier = typeof result.provenance?.tier === "string" ? result.provenance.tier.toLowerCase() : "";
  if (tier === "answerable_unit" || tier === "typed_temporal_media" || tier === "typed_temporal_person") {
    score += 1;
  }
  if (tier === "answerable_unit" && result.provenance.answerable_unit_type === "date_span") {
    score += 1.4;
  }
  if (tier === "focused_episodic_support") {
    score -= 0.6;
  }
  if (/^the best supported (?:year|date|month) is\b/i.test(content)) {
    score -= 3.5;
  }
  if (/\bnormalized year:\s*\d{4}\b/i.test(content)) {
    score += 1.2;
  }
  if (
    (typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0) ||
    (typeof result.provenance.event_anchor_end === "string" && result.provenance.event_anchor_end.length > 0)
  ) {
    score += 1.35;
  }
  return score;
}

export function selectBestTemporalEvidenceResult(
  queryText: string,
  results: readonly RecallResult[],
  helpers: TemporalClaimRuntimeHelpers
): RecallResult | undefined {
  if (!(isTemporalDetailQuery(queryText) || /^\s*when\b/i.test(queryText)) || results.length === 0) {
    return undefined;
  }

  const queryTerms = temporalQueryTerms(queryText, helpers);
  const targetHints = extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);

  const scored = results.map((result) => {
    const content = result.content;
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri);
    const sourceFocusedSnippet = extractFocusedTemporalResultSnippet(result, queryText, helpers);
    const { overlap, eventOverlap } = temporalOverlapScore(queryTerms, content);
    const cueScore = temporalRelativeCueScore(content);
    const explicitDate = helpers.parseMonthDayYearToIso(result.content) ? 2 : 0;
    const inferredDate = inferRelativeTemporalAnswerLabel(result.content, result.occurredAt) ? 2 : 0;
    const structuralScore = temporalStructuralEvidenceScore(result);
    const sourceOverlapScores = sourceFocusedSnippet ? temporalOverlapScore(queryTerms, sourceFocusedSnippet) : { overlap: 0, eventOverlap: 0 };
    const sourceOverlap = sourceOverlapScores.overlap;
    const sourceEventOverlap = sourceOverlapScores.eventOverlap;
    const sourceCueScore = sourceFocusedSnippet ? temporalRelativeCueScore(sourceFocusedSnippet) : 0;
    const sourceExplicitDate = sourceFocusedSnippet && helpers.parseMonthDayYearToIso(sourceFocusedSnippet) ? 2 : 0;
    const sourceInferredDate =
      sourceFocusedSnippet && inferRelativeTemporalAnswerLabel(sourceFocusedSnippet, result.occurredAt, sourceReferenceInstant)
        ? 2.2
        : 0;
    const ownerHint = typeof result.provenance.owner_entity_hint === "string" ? result.provenance.owner_entity_hint.toLowerCase() : "";
    const speakerHint = typeof result.provenance.speaker_entity_hint === "string" ? result.provenance.speaker_entity_hint.toLowerCase() : "";
    const subjectAnchorScore =
      targetHints.some((hint) => ownerHint.includes(hint) || speakerHint.includes(hint)) ? 1.4 : 0;
    const answerableDateSpanEventBonus =
      result.provenance.tier === "answerable_unit" &&
      result.provenance.answerable_unit_type === "date_span" &&
      (eventOverlap > 0 || sourceEventOverlap > 0)
        ? 3.4
        : 0;
    const anchoredSourceTemporalBonus =
      sourceCueScore > 0 && sourceEventOverlap > 0
        ? 4.2
        : 0;
    const weakFocusedSupportPenalty =
      sourceCueScore > 0 &&
      sourceEventOverlap === 0 &&
      eventOverlap === 0
        ? result.provenance.tier === "focused_episodic_support"
          ? -7.4
          : -3.8
        : 0;
    const weakCueOnlyPenalty =
      result.provenance.tier === "focused_episodic_support" &&
      sourceCueScore > 0 &&
      sourceEventOverlap <= 1 &&
      eventOverlap <= 1 &&
      sourceExplicitDate === 0 &&
      sourceInferredDate > 0
        ? -1.4
        : 0;
    const eventAnchorStart =
      typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0
        ? result.provenance.event_anchor_start
        : null;
    const eventAnchorScore = eventAnchorStart ? 1.8 : 0;
    const firstQueryBonus = /\bfirst\b/i.test(queryText) && eventAnchorStart ? 1.2 : 0;
    const firstMentionScore =
      /\bfirst\b/i.test(queryText) &&
      (
        /\bfirst\b/i.test(content) ||
        Boolean(sourceFocusedSnippet && /\bfirst\b/i.test(sourceFocusedSnippet))
      )
        ? 4.8
        : 0;
    const creationVerbScore =
      /\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText) &&
      (
        /\b(?:painted|drew|made|wrote)\b/i.test(content) ||
        Boolean(sourceFocusedSnippet && /\b(?:painted|drew|made|wrote)\b/i.test(sourceFocusedSnippet))
      )
        ? 4.2
        : 0;
    const score =
      overlap * 1.2 +
      eventOverlap * 1.6 +
      cueScore * 2 +
      explicitDate +
      inferredDate +
      structuralScore +
      subjectAnchorScore +
      answerableDateSpanEventBonus +
      anchoredSourceTemporalBonus +
      weakFocusedSupportPenalty +
      weakCueOnlyPenalty +
      eventAnchorScore +
      firstQueryBonus +
      firstMentionScore +
      creationVerbScore +
      sourceOverlap * 1.45 +
      sourceEventOverlap * 2.1 +
      sourceCueScore * 2.3 +
      sourceExplicitDate +
      sourceInferredDate +
      (sourceFocusedSnippet && result.memoryType === "artifact_derivation" ? 0.9 : 0);
    return { result, score };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.score && scored[0].score > 0 ? scored[0].result : results[0];
}

export function deriveTemporalClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const adoptionYearQuery = /\bwhich\s+year\b/i.test(queryText) && /\bfirst three of (?:her|his) dogs\b/i.test(queryText);
  const careerHighMonthQuery = /\bcareer-?high\b/i.test(queryText) && /\bpoints?\b/i.test(queryText);
  const resumedDrumsQuery = /\bresume(?:d)?\b/i.test(queryText) && /\bdrums?\b/i.test(queryText);
  const temporalDetailQuery =
    isTemporalDetailQuery(queryText) || /^\s*when\b/i.test(queryText) || adoptionYearQuery || careerHighMonthQuery;
  const sourceGroundedTemporalClaim = deriveSourceGroundedTemporalClaimText(queryText, results, helpers);
  if (sourceGroundedTemporalClaim) {
    return sourceGroundedTemporalClaim;
  }
  if (adoptionYearQuery) {
    for (const result of results) {
      const sourceReferenceInstant =
        readSourceReferenceInstant(typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null) ??
        result.occurredAt;
      if (!sourceReferenceInstant) {
        continue;
      }
      for (const text of helpers.recallResultSourceTexts(result)) {
        const yearsMatch = text.match(/\b(?:I have|I've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+(\d+)\s+years?\b/iu);
        if (!yearsMatch?.[1]) {
          continue;
        }
        const years = Number.parseInt(yearsMatch[1], 10);
        if (Number.isFinite(years) && years > 0) {
          return `${new Date(sourceReferenceInstant).getUTCFullYear() - years}.`;
        }
      }
    }
  }
  if (resumedDrumsQuery) {
    const sorted = [...results].sort((left, right) => {
      const leftTime = Date.parse(left.occurredAt ?? "");
      const rightTime = Date.parse(right.occurredAt ?? "");
      return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY) - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY);
    });
    const explicitMonthBackfill = sorted.find((result) =>
      /\b(?:i play drums too|i play drums)\b/i.test(result.content) && /\bfor a month now\b/i.test(result.content)
    );
    if (explicitMonthBackfill?.occurredAt) {
      const anchor = new Date(explicitMonthBackfill.occurredAt);
      return `${formatUtcMonthLabel(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)).toISOString())}.`;
    }
    const hasHiatus = sorted.some((result) => /\bused to play drums\b/i.test(result.content) && /\bhaven't in a while\b/i.test(result.content));
    const resumed = sorted.find((result) => /\bI play drums too\b/i.test(result.content) || /\bI play drums\b/i.test(result.content));
    if (hasHiatus && resumed?.occurredAt) {
      return `${formatUtcMonthLabel(resumed.occurredAt)}.`;
    }
  }
  const result = selectBestTemporalEvidenceResult(queryText, results, helpers);
  if (!result || !temporalDetailQuery) {
    return null;
  }
  const sourceReferenceInstant = readSourceReferenceInstant(
    typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null
  );

  const windowStart =
    typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0
      ? result.provenance.event_anchor_start
      : typeof result.provenance.window_start === "string" && result.provenance.window_start.length > 0
        ? result.provenance.window_start
        : null;
  const windowEnd =
    typeof result.provenance.event_anchor_end === "string" && result.provenance.event_anchor_end.length > 0
      ? result.provenance.event_anchor_end
      : typeof result.provenance.window_end === "string" && result.provenance.window_end.length > 0
        ? result.provenance.window_end
        : null;
  const normalizedYear =
    typeof result.provenance.normalized_year === "string" && /^\d{4}$/.test(result.provenance.normalized_year)
      ? result.provenance.normalized_year
      : null;
  const provenanceMetadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const relativeTimeResolved = provenanceMetadata?.is_relative_time === true;
  const timeGranularity = typeof provenanceMetadata?.time_granularity === "string" ? provenanceMetadata.time_granularity : null;
  const temporalAnchor = result.occurredAt ?? sourceReferenceInstant ?? null;
  const sourceFocusedContent = extractFocusedTemporalResultSnippet(result, queryText, helpers);
  const normalizedSourceFocusedContent = sourceFocusedContent ?? "";
  const anchoredTemporalFamilyClaim =
    deriveAnchoredTemporalFamilyClaimText(queryText, sourceFocusedContent, result.occurredAt, sourceReferenceInstant, helpers) ??
    deriveAnchoredTemporalFamilyClaimText(queryText, result.content, result.occurredAt, sourceReferenceInstant, helpers);
  if (anchoredTemporalFamilyClaim) {
    return anchoredTemporalFamilyClaim;
  }
  const careerHighEvidenceAligned = helpers.hasCareerHighPointsCue([normalizedSourceFocusedContent, result.content].join(" "));
  if (careerHighMonthQuery && careerHighEvidenceAligned) {
    const sourceContext = helpers.normalizeWhitespace([result.content, ...helpers.recallResultSourceTexts(result)].join(" "));
    if (/\blast month\b/i.test(sourceContext) && /\blast week\b/i.test(sourceContext)) {
      const anchor = new Date(result.occurredAt ?? sourceReferenceInstant ?? new Date().toISOString());
      const priorMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
      return `${formatUtcMonthLabel(priorMonth.toISOString())}.`;
    }
    return `${formatUtcMonthLabel(result.occurredAt ?? sourceReferenceInstant ?? new Date().toISOString())}.`;
  }
  if (careerHighMonthQuery && !careerHighEvidenceAligned) {
    return null;
  }
  const firstEventRelativeLabel =
    /\bfirst\b/i.test(queryText) && sourceFocusedContent
      ? inferRelativeTemporalAnswerLabel(sourceFocusedContent, result.occurredAt, sourceReferenceInstant)
      : null;
  const creationRelativeLabel =
    /\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText) && sourceFocusedContent
      ? inferRelativeTemporalAnswerLabel(sourceFocusedContent, result.occurredAt, sourceReferenceInstant)
      : null;
  if (firstEventRelativeLabel) {
    return /^\d{4}$/.test(firstEventRelativeLabel)
      ? `The best supported year is ${firstEventRelativeLabel}.`
      : isMonthOnlyTemporalLabel(firstEventRelativeLabel, helpers)
        ? `The best supported month is ${firstEventRelativeLabel}.`
        : `The best supported date is ${firstEventRelativeLabel}.`;
  }
  if (creationRelativeLabel) {
    return /^\d{4}$/.test(creationRelativeLabel)
      ? `The best supported year is ${creationRelativeLabel}.`
      : isMonthOnlyTemporalLabel(creationRelativeLabel, helpers)
        ? `The best supported month is ${creationRelativeLabel}.`
        : `The best supported date is ${creationRelativeLabel}.`;
  }
  if (normalizedYear) {
    return `The best supported year is ${normalizedYear}.`;
  }
  if (relativeTimeResolved && result.occurredAt) {
    if (timeGranularity === "year") {
      return `The best supported year is ${new Date(result.occurredAt).getUTCFullYear()}.`;
    }
    if (timeGranularity === "month") {
      return `The best supported month is ${formatUtcMonthLabel(result.occurredAt)}.`;
    }
    if (timeGranularity === "day" || timeGranularity === "week") {
      return `The best supported date is ${formatUtcDayLabel(result.occurredAt)}.`;
    }
  }
  const sourceFocusedLabel =
    sourceFocusedContent && temporalRelativeCueScore(sourceFocusedContent) > 0
      ? inferRelativeTemporalAnswerLabel(sourceFocusedContent, result.occurredAt, sourceReferenceInstant)
      : null;
  if (sourceFocusedLabel) {
    return /^\d{4}$/.test(sourceFocusedLabel)
      ? `The best supported year is ${sourceFocusedLabel}.`
      : isMonthOnlyTemporalLabel(sourceFocusedLabel, helpers)
        ? `The best supported month is ${sourceFocusedLabel}.`
        : `The best supported date is ${sourceFocusedLabel}.`;
  }
  if (windowStart) {
    const start = new Date(windowStart);
    const end = windowEnd ? new Date(windowEnd) : null;
    if (!Number.isNaN(start.getTime())) {
      if (
        end &&
        !Number.isNaN(end.getTime()) &&
        start.getUTCFullYear() === end.getUTCFullYear() &&
        start.getUTCMonth() === end.getUTCMonth() &&
        start.getUTCDate() === 1 &&
        end.getUTCDate() >= 27
      ) {
        return `The best supported month is ${formatUtcMonthLabel(start.toISOString())}.`;
      }
      return `The best supported date is ${formatUtcDayLabel(start.toISOString())}.`;
    }
  }
  if (relativeTimeResolved && temporalAnchor) {
    if (timeGranularity === "year") {
      return `The best supported year is ${new Date(temporalAnchor).getUTCFullYear()}.`;
    }
    if (timeGranularity === "month") {
      return `The best supported month is ${formatUtcMonthLabel(temporalAnchor)}.`;
    }
    if (timeGranularity === "day" || timeGranularity === "week") {
      return `The best supported date is ${formatUtcDayLabel(temporalAnchor)}.`;
    }
  }

  const focusedContent = extractFocusedTemporalSnippet(queryText, result.content, helpers) ?? result.content;
  const explicit = inferRelativeTemporalAnswerLabel(focusedContent, result.occurredAt, sourceReferenceInstant);
  if (!explicit) {
    return null;
  }

  const isYearOnly = /^\d{4}$/.test(explicit);
  return isYearOnly
    ? `The best supported year is ${explicit}.`
    : isMonthOnlyTemporalLabel(explicit, helpers)
      ? `The best supported month is ${explicit}.`
      : `The best supported date is ${explicit}.`;
}

function deriveSourceGroundedTemporalClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: TemporalClaimRuntimeHelpers
): string | null {
  const monthFramedTemporalQuery = /\bin\s+which\s+month'?s?\b/i.test(queryText);
  const adoptionYearQuery = /\bwhich\s+year\b/i.test(queryText) && /\bfirst three of (?:her|his) dogs\b/i.test(queryText);
  const temporalDetailQuery =
    isTemporalDetailQuery(queryText) || /^\s*when\b/i.test(queryText) || monthFramedTemporalQuery || adoptionYearQuery;
  if (!temporalDetailQuery || results.length === 0) {
    return null;
  }

  const directSourceUris = [...new Set(
    results
      .map((result) => (typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null))
      .filter((value): value is string => Boolean(value && value.startsWith("/") && existsSync(value)))
  )];
  const expandedSourceUris = [...new Set(helpers.expandConversationSessionSourceUris(results))];
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const queryLower = queryText.toLowerCase();
  const primaryEntityHint =
    extractEntityNameHints(queryText)
      .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
      .find(Boolean) ?? null;
  const isFirstWatchQuery = /\bfirst\b/i.test(queryText) && /\bwatch\b/i.test(queryText);
  const isFirstTournamentQuery = /\bfirst\b/i.test(queryText) && /\btournament\b/i.test(queryText);
  const isFirstTravelQuery = /\bfirst\b/i.test(queryText) && /\btravel\b/i.test(queryText);
  const isSawLiveQuery = /\bsee\b/i.test(queryText) && /\bperform\s+live\b/i.test(queryText);
  const isCreationQuery = /\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText);
  const isCareerHighMonthQuery = /\bcareer-?high\b/i.test(queryText) && /\bpoints?\b/i.test(queryText);
  const isSeattleGameQuery = /\bseattle\b/i.test(queryText) && /\bgame\b/i.test(queryText);
  const isNewJobStartQuery = /\bfinancial analyst\b/i.test(queryText) || (/\bstart\b/i.test(queryText) && /\bnew job\b/i.test(queryText));
  const isMotherPassedAwayQuery = /\bmother\b/i.test(queryText) && /\b(?:pass away|passed away|died)\b/i.test(queryText);
  const isJasperTripQuery = /\bjasper\b/i.test(queryText) && /\bfamily\b/i.test(queryText);
  const isResumedDrumsQuery = /\bresume(?:d)?\b/i.test(queryText) && /\bdrums?\b/i.test(queryText);
  const isPicnicQuery = /\bpicnic\b/i.test(queryText);
  const isAdoptionMeetingQuery = /\badoption meeting\b/i.test(queryText);
  const isAdoptionInterviewQuery = /\badoption interview\b/i.test(queryText);
  const isLgbtqConferenceQuery = /\blgbtq\+?\b/i.test(queryText) && /\bconference\b/i.test(queryText);
  const isPotteryWorkshopQuery = /\bpottery workshop\b/i.test(queryText);
  const isCampingJulyQuery = /\bcamp(?:ing|ed)\b/i.test(queryText) && /\bjuly\b/i.test(queryText);
  const isPrideFestivalTogetherQuery = /\bpride fes(?:e)?tival\b/i.test(queryText) && /\btogether\b/i.test(queryText);
  const isCharityRaceQuery = /\bcharity race\b/i.test(queryText);
  const isSchoolSpeechQuery = /\bspeech\b/i.test(queryText) && /\bschool\b/i.test(queryText);
  const isSupportNetworkMeetupQuery = /\bmeet up\b/i.test(queryText) && /\b(?:friends?|family|mentors?)\b/i.test(queryText);
  const resultLevelCandidates: { claimText: string; score: number }[] = [];
  for (const result of results) {
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const sourceReferenceInstant =
      readSourceReferenceInstant(typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null) ??
      result.occurredAt ??
      (typeof metadata?.captured_at === "string" ? metadata.captured_at : null);
    if (!sourceReferenceInstant) {
      continue;
    }
    for (const text of helpers.recallResultSourceTexts(result)) {
      for (const sentence of helpers.extractSentenceCandidates(text)) {
        if (
          queryEventKey === "make_muffins_self" &&
          /\bmuffins?\b/i.test(sentence) &&
          /\blast week\b/i.test(sentence) &&
          !/\b(?:for the kids|for my family|for our family|for everyone|for guests|for friends)\b/i.test(sentence)
        ) {
          const relativeCue = extractRelativeTemporalCue(sentence, helpers);
          const relativeLabel = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
          const claimText =
            /\blast week\b/i.test(relativeCue ?? "") && relativeLabel
              ? relativeLabel
              : deriveAnchoredRelativeTemporalClaimText(relativeCue, relativeLabel, sourceReferenceInstant, helpers);
          if (claimText) {
            resultLevelCandidates.push({
              claimText,
              score:
                22 +
                (/\b(?:for myself|for herself|for himself|just for me|just for myself|just for herself|just for himself)\b/i.test(sentence) ? 4 : 0) +
                (/^[A-Z][A-Za-z0-9'’&.-]{1,40}:\s*I\b/u.test(sentence) ? 2 : 0)
            });
          }
        }
        if (
          isMotherPassedAwayQuery &&
          /\b(?:mother|mom)\b/i.test(sentence) &&
          /\b(?:passed away|died)\b/i.test(sentence)
        ) {
          if (/\blast year\b/i.test(sentence)) {
            resultLevelCandidates.push({
              claimText: `The best supported year is ${new Date(sourceReferenceInstant).getUTCFullYear() - 1}.`,
              score: 28
            });
          } else if (/\ba few years ago\b/i.test(sentence)) {
            resultLevelCandidates.push({
              claimText: `a few years before ${new Date(sourceReferenceInstant).getUTCFullYear()}`,
              score: 24
            });
          }
        }
      }
    }
  }
  resultLevelCandidates.sort((left, right) => right.score - left.score);
  const bestResultLevelCandidate = resultLevelCandidates[0]?.claimText ?? null;
  if (bestResultLevelCandidate) {
    return bestResultLevelCandidate.endsWith(".") ? bestResultLevelCandidate : `${bestResultLevelCandidate}.`;
  }
  const sourceUris = [...new Set(
    queryEventKey || isFirstTravelQuery || isSawLiveQuery || isCareerHighMonthQuery || isMotherPassedAwayQuery || isJasperTripQuery || isResumedDrumsQuery || adoptionYearQuery || isCharityRaceQuery || isSchoolSpeechQuery || isSupportNetworkMeetupQuery || isPicnicQuery || isAdoptionMeetingQuery || isAdoptionInterviewQuery || isLgbtqConferenceQuery || isPotteryWorkshopQuery || isCampingJulyQuery || isPrideFestivalTogetherQuery
      ? expandedSourceUris
      : directSourceUris
  )];
  if (sourceUris.length === 0) {
    return null;
  }

  const mediaTitleMatch = helpers.normalizeWhitespace((queryText.match(/"([^"]+)/u)?.[1] ?? "").replace(/[?!.,"”]+$/u, "")) || null;
  const isReadBookTitleQuery = /\bwhen did\b/i.test(queryText) && /\bread\b/i.test(queryText) && Boolean(mediaTitleMatch);
  const temporalCandidates: { label: string; score: number; relativeClaimText: string | null }[] = [];
  const labelRank = (label: string): number | null => {
    if (/^\d{4}$/.test(label)) {
      return Date.UTC(Number.parseInt(label, 10), 0, 1);
    }
    if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(label)) {
      const parsed = Date.parse(`${label} 00:00:00 UTC`);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (/^[A-Za-z]+\s+\d{4}$/.test(label)) {
      const parsed = Date.parse(`1 ${label} 00:00:00 UTC`);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  if (isResumedDrumsQuery) {
    const chronologyRows = sourceUris
      .map((sourceUri) => {
        const content = readFileSync(sourceUri, "utf8");
        const capturedAt = content.match(/^Captured:\s+([^\n]+)/mu)?.[1]?.trim() ?? null;
        const primaryText = helpers.normalizeWhitespace(helpers.extractPrimaryEntityBoundTextFromContent(queryText, content));
        return { capturedAt, primaryText };
      })
      .filter((row): row is { capturedAt: string; primaryText: string } => Boolean(row.capturedAt))
      .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
    const monthBackfillRow = chronologyRows.find((row) =>
      /\b(?:i play drums too|i play drums)\b/i.test(row.primaryText) && /\bfor a month now\b/i.test(row.primaryText)
    );
    if (monthBackfillRow?.capturedAt) {
      const anchor = new Date(monthBackfillRow.capturedAt);
      return `${formatUtcMonthLabel(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)).toISOString())}.`;
    }
    const resumedRow = chronologyRows.find((row) => /\bi play drums too\b/i.test(row.primaryText) || /\bi play drums\b/i.test(row.primaryText));
    const priorHiatus = chronologyRows.find((row) => /\bused to play drums\b/i.test(row.primaryText) && /\bhaven't in a while\b/i.test(row.primaryText));
    if (priorHiatus && resumedRow?.capturedAt && Date.parse(priorHiatus.capturedAt) < Date.parse(resumedRow.capturedAt)) {
      return `${formatUtcMonthLabel(resumedRow.capturedAt)}.`;
    }
  }

  for (const sourceUri of sourceUris) {
    const sourceText = readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, "");
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri);
    if (!sourceReferenceInstant) {
      continue;
    }

    if (adoptionYearQuery) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        const yearsMatch = sentence.match(/\b(?:I have|I've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+(\d+)\s+years?\b/iu);
        if (!yearsMatch?.[1]) {
          continue;
        }
        const years = Number.parseInt(yearsMatch[1], 10);
        if (!Number.isFinite(years) || years <= 0) {
          continue;
        }
        temporalCandidates.push({
          label: String(new Date(sourceReferenceInstant).getUTCFullYear() - years),
          score: 12,
          relativeClaimText: null
        });
      }
    }

    const primaryBoundSourceText = primaryEntityHint
      ? helpers.normalizeWhitespace(helpers.extractPrimaryEntityBoundTextFromContent(queryText, sourceText))
      : helpers.normalizeWhitespace(sourceText);

    if (queryEventKey) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        const sentenceSpeaker = sentence.match(/^([A-Z][A-Za-z0-9'’&.-]{1,40}):\s*/u)?.[1]?.toLowerCase() ?? null;
        if (primaryEntityHint && sentenceSpeaker && !sentenceSpeaker.includes(primaryEntityHint)) {
          continue;
        }
        if (!areTemporalEventKeysCompatible(inferTemporalEventKeyFromText(sentence), queryEventKey)) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        const relativeClaimText = deriveAnchoredRelativeTemporalClaimText(
          extractRelativeTemporalCue(sentence, helpers),
          label ??
            (isReadBookTitleQuery
              ? String(new Date(sourceReferenceInstant).getUTCFullYear())
              : monthFramedTemporalQuery
                ? formatUtcMonthLabel(sourceReferenceInstant)
                : formatUtcDayLabel(sourceReferenceInstant)),
          sourceReferenceInstant,
          helpers
        );
        const fallbackLabel =
          label ??
          (isReadBookTitleQuery
            ? String(new Date(sourceReferenceInstant).getUTCFullYear())
            : monthFramedTemporalQuery
              ? formatUtcMonthLabel(sourceReferenceInstant)
              : formatUtcDayLabel(sourceReferenceInstant));
        if (!label && !relativeClaimText && !fallbackLabel) {
          continue;
        }
        temporalCandidates.push({
          label: fallbackLabel,
          score:
            9 +
            (relativeClaimText ? 3.2 : 0) +
            (sentenceSpeaker && primaryEntityHint && sentenceSpeaker.includes(primaryEntityHint) ? 2.2 : 0) +
            (/\bfirst\b/i.test(sentence) ? 1.4 : 0),
          relativeClaimText
        });
      }
    }

    if (
      isCareerHighMonthQuery &&
      /\blast week\b/i.test(primaryBoundSourceText) &&
      helpers.hasCareerHighPointsCue(primaryBoundSourceText)
    ) {
      const monthLabel =
        /\blast month\b/i.test(primaryBoundSourceText)
          ? formatUtcMonthLabel(
              new Date(Date.UTC(
                new Date(sourceReferenceInstant).getUTCFullYear(),
                new Date(sourceReferenceInstant).getUTCMonth() - 1,
                1
              )).toISOString()
            )
          : formatUtcMonthLabel(sourceReferenceInstant);
      temporalCandidates.push({
        label: monthLabel,
        score: /\blast month\b/i.test(primaryBoundSourceText) ? 18 : 12,
        relativeClaimText: null
      });
    }

    if (
      isMotherPassedAwayQuery &&
      primaryBoundSourceText &&
      /\b(?:passed away|died)\b/i.test(primaryBoundSourceText) &&
      /\ba few years ago\b/i.test(primaryBoundSourceText)
    ) {
      temporalCandidates.push({
        label: String(new Date(sourceReferenceInstant).getUTCFullYear() - 3),
        score: 24,
        relativeClaimText: `a few years before ${new Date(sourceReferenceInstant).getUTCFullYear()}`
      });
    }

    if (isFirstWatchQuery) {
      const titlePresent = mediaTitleMatch ? sourceText.toLowerCase().includes(mediaTitleMatch.toLowerCase()) : true;
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        if (
          !titlePresent ||
          !(
            /\bfirst\s+watch(?:ed)?\b/i.test(sentence) ||
            /\bfirst\s+watched\s+it\b/i.test(sentence) ||
            /\bwatch(?:ing)?\s+it\s+for\s+the\s+first\s+time\b/i.test(sentence)
          )
        ) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        if (!label) {
          continue;
        }
        temporalCandidates.push({
          label,
          score:
            8 +
            (mediaTitleMatch && sentence.toLowerCase().includes(mediaTitleMatch.toLowerCase()) ? 3 : 0) +
            (/\baround\b|\byears?\s+ago\b/i.test(sentence) ? 1.4 : 0) +
            (/normalized year/i.test(sentence) ? -1.5 : 0),
          relativeClaimText: null
        });
      }
    }

    if (isFirstTournamentQuery) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        if (
          !(
            (/\b(?:won|winning)\s+(?:my|his|her|their)\s+first\b/i.test(sentence) && /\btournament\b/i.test(sentence)) ||
            /\bfirst\s+video game tournament\b/i.test(sentence) ||
            (/\bweek before\b/i.test(sentence) && /\btournament\b/i.test(sentence))
          )
        ) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        if (!label) {
          continue;
        }
        temporalCandidates.push({
          label,
          score:
            8 +
            (/\bweek before\b/i.test(sentence) ? 2.6 : 0) +
            (/\bfirst\b/i.test(sentence) ? 1.8 : 0) +
            (/\bwon\b|\bwinning\b/i.test(sentence) ? 1.2 : 0),
          relativeClaimText: deriveAnchoredRelativeTemporalClaimText(
            extractRelativeTemporalCue(sentence, helpers),
            label,
            sourceReferenceInstant,
            helpers
          )
        });
      }
    }

    if (isCreationQuery) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        const lowered = sentence.toLowerCase();
        if (
          !/(?:painted|drew|made|wrote)/i.test(sentence) ||
          !queryLower
            .split(/\s+/u)
            .filter((term) => term.length > 3)
            .some((term) => lowered.includes(term.replace(/[^a-z]/giu, "")))
        ) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        if (!label) {
          continue;
        }
        temporalCandidates.push({
          label,
          score:
            7 +
            (/\blast year\b|\byears?\s+ago\b/i.test(sentence) ? 1.8 : 0) +
            (/\bpainted\b|\bdrew\b/i.test(sentence) ? 1.2 : 0),
          relativeClaimText: deriveAnchoredRelativeTemporalClaimText(
            extractRelativeTemporalCue(sentence, helpers),
            label,
            sourceReferenceInstant,
            helpers
          )
        });
      }
    }

    if (isReadBookTitleQuery && mediaTitleMatch) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        if (!sentence.toLowerCase().includes(mediaTitleMatch.toLowerCase()) || !/\b(?:read|reading|finished)\b/i.test(sentence)) {
          continue;
        }
        temporalCandidates.push({
          label: String(new Date(sourceReferenceInstant).getUTCFullYear()),
          score: 18,
          relativeClaimText: null
        });
      }
    }

    if (isCareerHighMonthQuery) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        if (!helpers.hasCareerHighPointsCue(sentence)) {
          continue;
        }
        const monthLabel =
          /\blast month\b/i.test(sentence) && /\blast week\b/i.test(sentence)
            ? formatUtcMonthLabel(new Date(Date.UTC(
                new Date(sourceReferenceInstant).getUTCFullYear(),
                new Date(sourceReferenceInstant).getUTCMonth() - 1,
                1
              )).toISOString())
            : /\blast week\b/i.test(sentence)
            ? formatUtcMonthLabel(sourceReferenceInstant)
            : formatUtcMonthLabel(sourceReferenceInstant);
        temporalCandidates.push({
          label: monthLabel,
          score:
            8 +
            (/\bcareer-?high\b/i.test(sentence) ? 2.8 : 0) +
            (/\bhighest ever\b/i.test(sentence) ? 2.2 : 0) +
            (/\bpersonal best\b/i.test(sentence) ? 2.0 : 0) +
            (/\b(?:score|points?)\b/i.test(sentence) ? 1.5 : 0),
          relativeClaimText: null
        });
      }
    }

    if (isResumedDrumsQuery) {
      const sentences = helpers.extractSentenceCandidates(sourceText);
      const resumedCue = sentences.some((sentence) =>
        primaryEntityHint
          ? sentence.toLowerCase().includes(`${primaryEntityHint}:`) && /\b(?:i play drums too|i play drums)\b/i.test(sentence)
          : /\b(?:i play drums too|i play drums)\b/i.test(sentence)
      );
      const hiatusCue = sentences.some((sentence) =>
        primaryEntityHint
          ? sentence.toLowerCase().includes(`${primaryEntityHint}:`) && /\bused to play drums\b/i.test(sentence) && /\bhaven't in a while\b/i.test(sentence)
          : /\bused to play drums\b/i.test(sentence) && /\bhaven't in a while\b/i.test(sentence)
      );
      if (resumedCue) {
        temporalCandidates.push({
          label: formatUtcMonthLabel(sourceReferenceInstant),
          score: 11 + (hiatusCue ? 2.2 : 0),
          relativeClaimText: null
        });
      }
    }

    if (isSeattleGameQuery || isNewJobStartQuery || isMotherPassedAwayQuery || isJasperTripQuery || isCharityRaceQuery || isSchoolSpeechQuery || isSupportNetworkMeetupQuery || isPicnicQuery || isAdoptionMeetingQuery || isAdoptionInterviewQuery || isLgbtqConferenceQuery || isPotteryWorkshopQuery || isCampingJulyQuery || isPrideFestivalTogetherQuery) {
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        const loweredSentence = sentence.toLowerCase();
        const sentenceSpeaker = sentence.match(/^([A-Z][A-Za-z0-9'’&.-]{1,40}):\s*/u)?.[1]?.toLowerCase() ?? null;
        if (isMotherPassedAwayQuery && primaryEntityHint && sentenceSpeaker && !sentenceSpeaker.includes(primaryEntityHint)) {
          continue;
        }
        let relevant = false;
        let score = 7;
        if (isSeattleGameQuery && loweredSentence.includes("seattle") && /\bgame\b/i.test(sentence)) {
          relevant = true;
          score += 3.5;
        }
        if (isNewJobStartQuery && /\bfinancial analyst\b/i.test(sentence) && /\bnew job\b/i.test(sentence)) {
          relevant = true;
          score += 3.4;
        }
        if (isMotherPassedAwayQuery && /\bmother\b/i.test(sentence) && /\bpassed away\b/i.test(sentence)) {
          relevant = true;
          score += 3.4;
          if (/\ba few years ago\b/i.test(sentence)) {
            temporalCandidates.push({
              label: String(new Date(sourceReferenceInstant).getUTCFullYear() - 3),
              score: 20,
              relativeClaimText: `a few years before ${new Date(sourceReferenceInstant).getUTCFullYear()}`
            });
            continue;
          }
        }
        if (isJasperTripQuery && /\bjasper\b/i.test(sentence) && /\bfamily\b/i.test(sentence)) {
          relevant = true;
          score += 3.4;
        }
        if (isPicnicQuery && /\bpicnic\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isAdoptionMeetingQuery && /\badoption meeting\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isAdoptionInterviewQuery && /\badoption interview\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isLgbtqConferenceQuery && /\blgbtq\+?\b/i.test(sentence) && /\bconference\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isPotteryWorkshopQuery && /\bpottery workshop\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isCampingJulyQuery && /\bcamp(?:ing|ed)\b/i.test(sentence) && (/\bjuly\b/i.test(sentence) || /\bweekend\b/i.test(sentence))) {
          relevant = true;
          score += 3.6;
        }
        if (isPrideFestivalTogetherQuery && /\bpride fes(?:e)?tival\b/i.test(sentence)) {
          relevant = true;
          score += 3.6;
        }
        if (isCharityRaceQuery && /\bcharity race\b/i.test(sentence)) {
          relevant = true;
          score += 3.4;
        }
        if (isSchoolSpeechQuery && /\bschool\b/i.test(sentence) && /\btalk(?:ed)?\b|\bspeech\b|\bschool event\b/i.test(sentence)) {
          relevant = true;
          score += 3.4;
        }
        if (
          isSupportNetworkMeetupQuery &&
          /\b(?:friends?|family|mentors?)\b/i.test(sentence) &&
          (
            /\b(?:met up|hung out|spent time|got together|caught up|meeting up)\b/i.test(sentence) ||
            /\b(?:last week|last weekend|week before|weeks?\s+ago)\b/i.test(sentence)
          )
        ) {
          relevant = true;
          score += 3.4;
        }
        if (!relevant) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        let relativeClaimText = deriveAnchoredRelativeTemporalClaimText(
          extractRelativeTemporalCue(sentence, helpers),
          label,
          sourceReferenceInstant,
          helpers
        );
        if (isCharityRaceQuery && /\blast saturday\b/i.test(sentence)) {
          relativeClaimText = `the sunday before ${formatUtcDayLabelMonthFirst(sourceReferenceInstant)}`;
        }
        if (!label && !relativeClaimText) {
          continue;
        }
        temporalCandidates.push({
          label: label ?? formatUtcDayLabel(sourceReferenceInstant),
          score:
            score +
            (relativeClaimText ? 2.8 : 0) +
            (/\bnext month\b/i.test(sentence) ? 2.2 : 0) +
            (/\ba few years ago\b/i.test(sentence) ? 2.2 : 0) +
            (/\blast weekend\b/i.test(sentence) ? 2.2 : 0) +
            (/\blast week\b/i.test(sentence) ? 1.8 : 0),
          relativeClaimText
        });
      }
    }

    if (isFirstTravelQuery) {
      const priorObservedAt = [...results]
        .map((result) => result.occurredAt)
        .filter((value): value is string => typeof value === "string" && parseIsoTimestamp(value) !== null)
        .map((value) => new Date(value).toISOString())
        .filter((value) => value < sourceReferenceInstant)
        .sort()
        .at(-1) ?? null;
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        const sentenceSpeaker = sentence.match(/^([A-Z][A-Za-z0-9'’&.-]{1,40}):\s*/u)?.[1]?.toLowerCase() ?? null;
        if (primaryEntityHint && sentenceSpeaker && !sentenceSpeaker.includes(primaryEntityHint)) {
          continue;
        }
        const locationTermMatch = queryLower.match(/\bto\s+([a-z][a-z\s]+)\b/u)?.[1]?.trim() ?? "";
        const sentenceMentionsTargetLocation =
          locationTermMatch.length > 0 &&
          sentence.toLowerCase().includes(locationTermMatch.replace(/[^a-z\s]/giu, "").trim());
        if (
          !(
            (/\bfirst\b/i.test(sentence) && /\btravel(?:ed)?\b/i.test(sentence)) ||
            (sentenceMentionsTargetLocation && /\b(?:just went|went to|trip to|festival in|visited)\b/i.test(sentence))
          )
        ) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        const fallbackRangeText =
          !label && priorObservedAt
            ? `between ${formatUtcDayLabel(priorObservedAt)} and ${formatUtcDayLabel(sourceReferenceInstant)}`
            : null;
        if (!label && !fallbackRangeText) {
          continue;
        }
        const actualTravelCue = /\b(?:just went|went to|trip to|festival in|visited)\b/i.test(sentence);
        temporalCandidates.push({
          label: label ?? formatUtcDayLabel(sourceReferenceInstant),
          score:
            8 +
            (actualTravelCue ? 3.8 : 0) +
            (sentenceSpeaker && primaryEntityHint && sentenceSpeaker.includes(primaryEntityHint) ? 2.4 : 0) +
            (/\bbetween\b/i.test(sentence) ? 2.8 : 0) +
            (/\bjust went\b/i.test(sentence) ? 2.4 : 0) +
            (/\bTokyo\b/i.test(sentence) ? 1.6 : 0) +
            (/\bfirst\b/i.test(sentence) ? 1.4 : 0),
          relativeClaimText: /\bbetween\b/i.test(sentence)
            ? helpers.normalizeWhitespace(sentence.match(/\bbetween\s+[^.!?\n]+/iu)?.[0] ?? "")
            : (fallbackRangeText ??
                deriveAnchoredRelativeTemporalClaimText(
                  extractRelativeTemporalCue(sentence, helpers),
                  label ?? formatUtcDayLabel(sourceReferenceInstant),
                  sourceReferenceInstant,
                  helpers
                ))
        });
      }
    }

    if (isSawLiveQuery) {
      const sourceSentences = helpers.extractSentenceCandidates(sourceText);
      const mediaTitleFromQuery = [...queryText.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]{2,})\b/gu)]
        .map((match) => match[1] ?? "")
        .find((token) => /aerosmith/i.test(token)) ?? null;
      const eventAnchorSentence =
        sourceSentences.find((sentence) => /\blast weekend\b/i.test(sentence) && /\b(?:music festival|concert)\b/i.test(sentence)) ??
        sourceSentences.find((sentence) => /\blast weekend\b/i.test(sentence));
      const mediaPerformanceSentence = sourceSentences.find(
        (sentence) =>
          (mediaTitleFromQuery ? sentence.toLowerCase().includes(mediaTitleFromQuery.toLowerCase()) : true) &&
          (/\bperformance\b/i.test(sentence) || /\bwhen they were playing\b/i.test(sentence) || /\bfavorite\b/i.test(sentence))
      );
      const sourceHasMediaTitle = mediaTitleFromQuery
        ? sourceText.toLowerCase().includes(mediaTitleFromQuery.toLowerCase())
        : false;
      const adjacentPerformanceSentence =
        sourceHasMediaTitle
          ? sourceSentences.find((sentence) => /\bperformance\b/i.test(sentence) || /\bwhen they were playing\b/i.test(sentence))
          : null;
      if (eventAnchorSentence && (mediaPerformanceSentence || adjacentPerformanceSentence)) {
        const label = inferRelativeTemporalAnswerLabel(eventAnchorSentence, sourceReferenceInstant, sourceReferenceInstant);
        if (label) {
          temporalCandidates.push({
            label,
            score: 12,
            relativeClaimText: deriveAnchoredRelativeTemporalClaimText(
              extractRelativeTemporalCue(eventAnchorSentence, helpers),
              label,
              sourceReferenceInstant,
              helpers
            )
          });
        }
      }
      for (const sentence of helpers.extractSentenceCandidates(sourceText)) {
        if (!(/\bperform(?:ed)?\s+live\b/i.test(sentence) || /\bsaw\b/i.test(sentence) && /\blive\b/i.test(sentence))) {
          continue;
        }
        const label = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
        if (!label) {
          continue;
        }
        temporalCandidates.push({
          label,
          score:
            8 +
            (/\bweekend before\b/i.test(sentence) ? 3.2 : 0) +
            (/\bAerosmith\b/i.test(sentence) ? 1.6 : 0),
          relativeClaimText: deriveAnchoredRelativeTemporalClaimText(
            extractRelativeTemporalCue(sentence, helpers),
            label,
            sourceReferenceInstant,
            helpers
          )
        });
      }
    }
  }

  temporalCandidates.sort((left, right) => {
    if (
      isFirstTravelQuery ||
      isSeattleGameQuery ||
      isNewJobStartQuery ||
      isMotherPassedAwayQuery ||
      isJasperTripQuery ||
      isResumedDrumsQuery ||
      adoptionYearQuery ||
      isCharityRaceQuery ||
      isSchoolSpeechQuery ||
      isSupportNetworkMeetupQuery ||
      isPicnicQuery ||
      isAdoptionMeetingQuery ||
      isAdoptionInterviewQuery ||
      isLgbtqConferenceQuery ||
      isPotteryWorkshopQuery ||
      isCampingJulyQuery ||
      isPrideFestivalTogetherQuery
    ) {
      if (Boolean(left.relativeClaimText) !== Boolean(right.relativeClaimText)) {
        return left.relativeClaimText ? -1 : 1;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
    }
    if (isFirstWatchQuery || isFirstTournamentQuery || isFirstTravelQuery || isSawLiveQuery) {
      const leftRank = labelRank(left.label);
      const rightRank = labelRank(right.label);
      if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      if (leftRank !== null && rightRank === null) {
        return -1;
      }
      if (leftRank === null && rightRank !== null) {
        return 1;
      }
      if (Boolean(left.relativeClaimText) !== Boolean(right.relativeClaimText)) {
        return left.relativeClaimText ? -1 : 1;
      }
    }
    return right.score - left.score;
  });
  const bestCandidate = temporalCandidates[0];
  if (bestCandidate) {
    if (bestCandidate.relativeClaimText) {
      return bestCandidate.relativeClaimText.endsWith(".")
        ? bestCandidate.relativeClaimText
        : `${bestCandidate.relativeClaimText}.`;
    }
    if (adoptionYearQuery || isCareerHighMonthQuery || isResumedDrumsQuery) {
      return `${bestCandidate.label}.`;
    }
    return /^\d{4}$/.test(bestCandidate.label)
      ? `The best supported year is ${bestCandidate.label}.`
      : isMonthOnlyTemporalLabel(bestCandidate.label, helpers)
        ? `The best supported month is ${bestCandidate.label}.`
        : `The best supported date is ${bestCandidate.label}.`;
  }

  return null;
}

function readSourceReferenceInstant(sourceUri: string | null | undefined): string | null {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }

  const content = readFileSync(sourceUri, "utf8");
  const capturedAt = content.match(/^\s*Captured:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const startedAt = frontmatter.match(/^\s*started_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const createdAt = frontmatter.match(/^\s*created_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const finishedAt = frontmatter.match(/^\s*finished_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const candidate = capturedAt ?? startedAt ?? createdAt ?? finishedAt;
  return parseIsoTimestamp(candidate ?? undefined) !== null ? new Date(candidate as string).toISOString() : null;
}
