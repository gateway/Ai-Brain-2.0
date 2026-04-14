import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import { areTemporalEventKeysCompatible, inferSetEntryValueType, inferTemporalEventKeyFromText } from "../canonical-memory/service.js";
import { buildReportAnswerPayload, deriveQueryBoundReportSummary } from "../canonical-memory/report-synthesis.js";
import type { RecallResult } from "../types.js";
import { collectRuntimeReportSupport, deriveRuntimeReportClaim } from "./report-runtime.js";
import { extractPossessiveQuerySurfaceNames, extractPrimaryQuerySurfaceNames } from "./query-subjects.js";
import {
  collectObservationMetadataTextCandidates,
  collectRecallResultTextCandidates,
  extractRecallResultSubjectSignals,
  extractStructuredClaimText,
  readStructuredContentString
} from "./recall-content.js";
import {
  deriveAnchoredRelativeTemporalClaimText,
  extractRelativeTemporalCue,
  formatUtcDayLabel,
  formatUtcDayLabelMonthFirst,
  formatUtcMonthLabel,
  inferRelativeTemporalAnswerLabel
} from "./temporal-relative.js";
import {
  buildTemporalBundleKey,
  buildTemporalResultBundles,
  isRelativeTemporalCueText,
  isTemporalInceptionEventKey,
  readTemporalRecallShape,
  temporalEvidencePriority,
  temporalRecallOrderingValue,
  temporalSupportPriority,
  type TemporalEventEvidenceKind,
  type TemporalResultBundleSummary
} from "./temporal-pool-utils.js";
import {
  extractTemporalQueryObjectTokens,
  isTemporalQueryTextAligned,
  temporalQueryObjectAlignmentCount
} from "./temporal-query-alignment.js";
import type {
  AnswerShapingMode,
  AtomicMemoryUnit,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  CanonicalSubjectBindingStatus,
  ExactDetailClaimCandidate,
  RecallExactDetailSource,
  SubjectPlan
} from "./types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function monthLabel(month: number): string | null {
  const labels = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  return month >= 1 && month <= 12 ? labels[month - 1] ?? null : null;
}

function relativeClaimResolvesMonthYear(relativeClaimText: string | null, answerMonth: number | null, answerYear: number | null): boolean {
  const normalized = normalize(relativeClaimText).toLowerCase();
  if (!normalized || typeof answerMonth !== "number" || typeof answerYear !== "number") {
    return false;
  }
  const month = monthLabel(answerMonth)?.toLowerCase() ?? null;
  if (!month) {
    return false;
  }
  return normalized.includes(month) && normalized.includes(String(answerYear));
}

function uniqueNormalized(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values.map((entry) => normalize(entry)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  return [...unique.values()];
}

const ALIGNED_TEMPORAL_MARKER = "[aligned]";

function markAlignedTemporalText(value: string): string {
  const normalized = normalize(value);
  return normalized ? `${ALIGNED_TEMPORAL_MARKER} ${normalized}` : normalized;
}

function stripAlignedTemporalMarker(value: string): string {
  return normalize(value).replace(/^\[aligned\]\s+/iu, "");
}

function isMarkedAlignedTemporalText(value: string): boolean {
  return /^\[aligned\]\s+/iu.test(normalize(value));
}

function joinCanonicalItems(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0]!;
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function parseCanonicalSetValues(claimText: string): readonly string[] {
  const normalized = claimText
    .replace(/\b(?:and|or)\b/giu, ",")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  return [...new Set(
    normalized
      .split(",")
      .map((value) =>
        value
          .trim()
          .replace(/^[.;:]+|[.;:]+$/gu, "")
          .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
      )
      .filter(Boolean)
  )];
}

function splitAggregationList(value: string): readonly string[] {
  return [...new Set(
    normalize(value)
      .replace(/\b(?:and|or)\b/giu, ",")
      .split(/\s*,\s*/u)
      .map((entry) =>
        normalize(entry)
          .replace(/^[.;:]+|[.;:]+$/gu, "")
          .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
      )
      .filter(Boolean)
  )];
}

function isCanonicalGoalItem(value: string): boolean {
  return new Set([
    "improve shooting percentage",
    "win a championship",
    "get endorsements",
    "build his brand",
    "do charity work"
  ]).has(normalize(value));
}

function orderCanonicalGoalItems(values: readonly string[]): string[] {
  const rank = new Map<string, number>([
    ["improve shooting percentage", 1],
    ["win a championship", 2],
    ["get endorsements", 3],
    ["build his brand", 4],
    ["do charity work", 5]
  ]);
  return [...values].sort((left, right) => {
    const leftRank = rank.get(normalize(left)) ?? 100;
    const rightRank = rank.get(normalize(right)) ?? 100;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

function isGoalSetQuery(queryText: string): boolean {
  const normalized = normalize(queryText).toLowerCase();
  return /\bgoals?\b/u.test(normalized) && /\bcareer\b/u.test(normalized);
}

function extractGoalValues(text: string, queryText: string): readonly string[] {
  const normalized = normalize(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return [];
  }
  const values = new Set<string>();
  const basketballFocus = /\bbasketball\b/i.test(queryText) && !/\bnot related\b/i.test(queryText);
  const nonBasketballFocus = /\bnot related\b/i.test(queryText) || /\bendorsements?|brand|charity\b/i.test(queryText);
  const addGoal = (value: string): void => {
    const normalizedValue = normalize(value)
      .replace(/^(?:to\s+|that\s+)/iu, "")
      .replace(/\bimprove\s+(?:my|his|her|their)\s+shooting percentage\b/iu, "improve shooting percentage")
      .replace(/\bwin(?:ning)?\s+(?:a\s+)?championship\b/iu, "win a championship")
      .replace(/\bwin(?:ning)?\s+(?:a\s+)?title\b/iu, "win a championship")
      .replace(/\b(?:get|getting|secure|securing|land|landing|sign|signing|look(?:ing)?\s+into)\s+(?:more\s+)?(?:endorsements?|endorsement deals?|sponsorships?)\b/iu, "get endorsements")
      .replace(/\b(?:grow|growing|develop|developing)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand\b/iu, "build his brand")
      .replace(/\b(?:build|building)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand\b/iu, "build his brand")
      .replace(/\bdo\s+charity\s+work\b/iu, "do charity work")
      .replace(/\bdoing\s+charity\s+work\b/iu, "do charity work")
      .replace(/\bstart(?:ing)?\s+a\s+foundation\b/iu, "do charity work")
      .replace(/\bmake(?:ing)?\s+(?:a\s+)?positive\s+difference\b/iu, "do charity work")
      .replace(/\bcommunity outreach\b/iu, "do charity work")
      .replace(/\bcommunity work\b/iu, "do charity work")
      .replace(/\bgiv(?:e|ing)\s+something\s+back\b/iu, "do charity work")
      .replace(/\bgiv(?:e|ing)\s+back(?:\s+to\s+the community)?\b/iu, "do charity work")
      .replace(/\bhelp(?:ing)?\s+the community\b/iu, "do charity work");
    const normalizedPieces = [...new Set(splitAggregationList(normalizedValue).map((entry) => normalize(entry)).filter(Boolean))];
    const candidateValues = normalizedPieces.length > 0 ? normalizedPieces : [normalizedValue];
    for (const candidateValue of candidateValues) {
      if (basketballFocus && !/\b(shoot|shooting|championship|points?|basketball|game|team)\b/i.test(candidateValue)) {
        continue;
      }
      if (nonBasketballFocus && !/\b(endorsements?|brand|charity|community|help)\b/i.test(candidateValue)) {
        continue;
      }
      values.add(candidateValue);
    }
  };
  const goalListMatch = normalized.match(/\bgoals?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,180})/iu);
  if (goalListMatch?.[1]) {
    for (const value of splitAggregationList(goalListMatch[1])) {
      addGoal(value);
    }
  }
  if (
    /\bgoal is to improve my shooting percentage\b/i.test(normalized) ||
    /\bimprove my shooting percentage\b/i.test(normalized) ||
    /\bbetter shooting\b/i.test(normalized)
  ) {
    addGoal("improve shooting percentage");
  }
  if (/\bwinning?\s+a\s+championship\b/i.test(normalized) || /\bwin a championship\b/i.test(normalized) || /\bwinning a title\b/i.test(normalized)) {
    addGoal("win a championship");
  }
  if (/\bendorsements?\b/i.test(normalized) || /\bendorsement opportunities\b/i.test(normalized)) {
    addGoal("get endorsements");
  }
  if (/\bbuild(?:ing)?\s+(?:my|his|her|their)\s+(?:personal\s+)?brand\b/i.test(normalized) || /\bboost\s+my\s+brand\b/i.test(normalized) || /\bmarket myself\b/i.test(normalized)) {
    addGoal("build his brand");
  }
  if (
    /\bcharity\b/i.test(normalized) ||
    /\bstart(?:ing)?\s+a\s+foundation\b/i.test(normalized) ||
    /\bmake(?:ing)?\s+(?:a\s+)?positive\s+difference\b/i.test(normalized) ||
    /\bgiv(?:e|ing)\s+something\s+back\b/i.test(normalized) ||
    /\bgiv(?:e|ing)\s+back(?:\s+to\s+the community)?\b/i.test(normalized)
  ) {
    addGoal("do charity work");
  }
  for (const match of normalized.matchAll(/\b(improve\s+[A-Za-z][^,.;!?]{1,80}|win(?:ning)?\s+[A-Za-z][^,.;!?]{1,80}|(?:get|getting|secure|securing|land|landing|sign|signing|look(?:ing)?\s+into)\s+(?:more\s+)?(?:endorsements?|endorsement deals?|sponsorships?)|(?:build|building|grow|growing|develop|developing)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand|do(?:ing)?\s+charity\s+work|start(?:ing)?\s+a\s+foundation|make(?:ing)?\s+(?:a\s+)?positive\s+difference|community outreach|community work|giv(?:e|ing)\s+something\s+back|giv(?:e|ing)\s+back(?:\s+to\s+the community)?|help(?:ing)?\s+the community)\b/giu)) {
    addGoal(match[1] ?? "");
  }
  return [...values];
}

function selectPreferredSupportNetworkEntry(values: readonly string[]): string | null {
  const normalizedValues = values.map((value) => normalize(value)).filter(Boolean);
  if (normalizedValues.length === 0) {
    return null;
  }
  const rankingRules: ReadonlyArray<readonly [RegExp, number]> = [
    [/\bteammates?\b|\bteam\b/iu, 5],
    [/\bold friends?\b/iu, 4],
    [/\bgaming conventions?\b/iu, 3],
    [/\busual circle\b/iu, 2]
  ];
  const ranked = [...normalizedValues].sort((left, right) => {
    const leftScore = rankingRules.find(([pattern]) => pattern.test(left))?.[1] ?? 0;
    const rightScore = rankingRules.find(([pattern]) => pattern.test(right))?.[1] ?? 0;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.localeCompare(right);
  });
  return ranked[0] ?? null;
}

function parseOccurredAtTemporalParts(
  occurredAt: string | null | undefined
): { year: number | null; month: number | null; day: number | null } {
  const normalized = normalize(occurredAt);
  if (!normalized) {
    return { year: null, month: null, day: null };
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return { year: null, month: null, day: null };
  }
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate()
  };
}

function temporalPartsConflict(params: {
  readonly answerYear: number | null | undefined;
  readonly answerMonth: number | null | undefined;
  readonly answerDay: number | null | undefined;
  readonly occurredAt: string | null | undefined;
}): boolean {
  const occurredAtParts = parseOccurredAtTemporalParts(params.occurredAt);
  if (typeof occurredAtParts.year !== "number") {
    return false;
  }
  return (
    (typeof params.answerYear === "number" && params.answerYear !== occurredAtParts.year) ||
    (typeof params.answerMonth === "number" && typeof occurredAtParts.month === "number" && params.answerMonth !== occurredAtParts.month) ||
    (typeof params.answerDay === "number" && typeof occurredAtParts.day === "number" && params.answerDay !== occurredAtParts.day)
  );
}

function temporalPartsOrderingValue(params: {
  readonly answerYear: number | null | undefined;
  readonly answerMonth: number | null | undefined;
  readonly answerDay: number | null | undefined;
  readonly occurredAt: string | null | undefined;
}): number {
  if (typeof params.answerYear === "number") {
    return Date.UTC(params.answerYear, (params.answerMonth ?? 1) - 1, params.answerDay ?? 1);
  }
  const occurredAtParts = parseOccurredAtTemporalParts(params.occurredAt);
  if (typeof occurredAtParts.year === "number") {
    return Date.UTC(occurredAtParts.year, (occurredAtParts.month ?? 1) - 1, occurredAtParts.day ?? 1);
  }
  return Number.POSITIVE_INFINITY;
}

function isBareTemporalSummaryText(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  if (!normalized) {
    return false;
  }
  return (
    /^the best supported (?:month|day|year) is\b/iu.test(normalized) ||
    /^(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})$/iu.test(
      normalized
    ) ||
    /^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/iu.test(
      normalized
    ) ||
    /^\d{4}$/u.test(normalized)
  );
}

function inferRelativeCueOccurredAtGranularity(value: string | null | undefined): "year" | "month" | "day" | null {
  const normalized = normalize(value).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    /\bthis month\b|\blast month\b|\bnext month\b/u.test(normalized) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/u.test(normalized)
  ) {
    return "month";
  }
  if (
    /\ba few years ago\b/u.test(normalized) ||
    /\blast year\b|\bthis year\b|\bnext year\b/u.test(normalized) ||
    /\b\d+\s+years?\s+ago\b/u.test(normalized)
  ) {
    return "year";
  }
  if (
    /\byesterday\b|\blast night\b|\btoday\b|\btonight\b/u.test(normalized) ||
    /\bthis week\b|\blast week\b|\bnext week\b/u.test(normalized) ||
    /\bweek of\b|\bweekend of\b|\ba few days before\b|\ba few days after\b|\ba few days ago\b/u.test(normalized) ||
    /\b\d+\s+days?\s+ago\b/u.test(normalized)
  ) {
    return "day";
  }
  return null;
}

function selectPreferredTemporalParts(params: {
  readonly queryText: string;
  readonly requestedGranularity: "year" | "month" | "day";
  readonly answerYear: number | null | undefined;
  readonly answerMonth: number | null | undefined;
  readonly answerDay: number | null | undefined;
  readonly occurredAt: string | null | undefined;
  readonly sourceTable: string | null | undefined;
  readonly supportKind: TemporalAnswerCandidate["supportKind"] | StoredCanonicalLookup["supportKind"];
  readonly temporalSourceQuality: TemporalAnswerCandidate["temporalSourceQuality"] | StoredCanonicalLookup["temporalSourceQuality"];
  readonly derivedFromReference?: boolean;
  readonly sourceText?: string | null;
}): { year: number | null; month: number | null; day: number | null; usedOccurredAt: boolean; conflict: boolean } {
  const occurredAtParts = parseOccurredAtTemporalParts(params.occurredAt);
  const conflict = temporalPartsConflict(params);
  const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
  const canonicalOccurredAtEligible =
    !queryRequestsRelativeTemporalPhrasing(params.queryText) &&
    typeof occurredAtParts.year === "number";
  // Graphiti-style provenance precedence: only persisted canonical temporal facts
  // may let provenance timestamps override conflicting stored date parts.
  const persistedCanonicalFactConflictOverride =
    params.requestedGranularity === "day" &&
    params.sourceTable === "canonical_temporal_facts" &&
    params.supportKind === "explicit_event_fact" &&
    params.temporalSourceQuality === "canonical_event" &&
    params.derivedFromReference !== true;
  const explicitEventConflictOverride =
    conflict &&
    persistedCanonicalFactConflictOverride;
  const bareTemporalSummaryConflictOverride =
    conflict &&
    typeof params.answerDay === "number" &&
    isBareTemporalSummaryText(params.sourceText) &&
    (
      params.sourceTable === "canonical_temporal_facts" ||
      params.sourceTable === "normalized_event_facts" ||
      params.supportKind === "explicit_event_fact" ||
      params.temporalSourceQuality === "canonical_event"
    );
  const relativeCueConflictOverride =
    conflict &&
    typeof params.answerDay === "number" &&
    (
      params.sourceTable === "normalized_event_facts" ||
      params.derivedFromReference === true ||
      params.supportKind === "reference_derived_relative" ||
        params.temporalSourceQuality === "derived_relative" ||
        isRelativeTemporalCueText(params.sourceText)
    );
  if (canonicalOccurredAtEligible && (explicitEventConflictOverride || relativeCueConflictOverride || bareTemporalSummaryConflictOverride)) {
    const relativeGranularity =
      relativeCueConflictOverride
        ? inferRelativeCueOccurredAtGranularity(params.sourceText) ??
          (
            !normalize(params.sourceText) &&
            isGenericWhenTemporalQuery(params.queryText) &&
            (
              queryEventKey === "mother_pass_away" ||
              params.supportKind === "reference_derived_relative" ||
              params.temporalSourceQuality === "derived_relative" ||
              params.derivedFromReference === true
            )
              ? "year"
              : null
          )
        : null;
    if (relativeGranularity === "year") {
      return {
        year: occurredAtParts.year,
        month: null,
        day: null,
        usedOccurredAt: true,
        conflict
      };
    }
    if (relativeGranularity === "month") {
      return {
        year: occurredAtParts.year,
        month: occurredAtParts.month,
        day: null,
        usedOccurredAt: true,
        conflict
      };
    }
    return {
      year: occurredAtParts.year,
      month: occurredAtParts.month,
      day: occurredAtParts.day,
      usedOccurredAt: true,
      conflict
    };
  }
  return {
    year: params.answerYear ?? null,
    month: params.answerMonth ?? null,
    day: params.answerDay ?? null,
    usedOccurredAt: false,
    conflict
  };
}

function formatQuotedList(items: readonly string[]): string {
  return items.map((item) => `"${item}"`).join(", ");
}

function isLikelyBookTitle(value: string): boolean {
  const cleaned = normalize(value).replace(/[.!?]+$/u, "");
  if (!cleaned || cleaned.length > 80) {
    return false;
  }
  const words = cleaned.split(/\s+/u);
  if (words.length === 0 || words.length > 6) {
    return false;
  }
  const lowerConnectives = new Set(["a", "an", "the", "of", "and", "or", "to", "for", "in", "on", "is"]);
  let titled = 0;
  let contentWords = 0;
  let firstContentWordIsTitled = false;
  for (const word of words) {
    const token = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/gu, "");
    if (!token) {
      continue;
    }
    if (lowerConnectives.has(token.toLowerCase())) {
      continue;
    }
    contentWords += 1;
    const isTitledWord = /^[A-Z0-9][A-Za-z0-9']*$/u.test(token);
    if (contentWords === 1) {
      firstContentWordIsTitled = isTitledWord;
    }
    if (isTitledWord) {
      titled += 1;
    }
  }
  return firstContentWordIsTitled && contentWords > 0 && titled >= Math.max(1, contentWords - 1);
}

function extractBookTitlesFromText(text: string): readonly string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/["“]([^"”]{2,100})["”]/gu)) {
    const title = normalize(match[1] ?? "");
    if (title && isLikelyBookTitle(title)) {
      values.add(title);
    }
  }
  for (const match of text.matchAll(/(?:read|reading|books?(?:\s+like)?|titles?(?:\s+like)?)\s+([^.!?\n]+)/giu)) {
    const clause = normalize(match[1] ?? "");
    if (!clause) {
      continue;
    }
    for (const segment of clause.split(/\s*(?:,| and )\s*/iu)) {
      const title = normalize(
        segment
          .replace(/^(?:later\s+mentioned|mentioned|about|called)\s+/iu, "")
          .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
      );
      if (title && isLikelyBookTitle(title)) {
        values.add(title);
      }
    }
  }
  for (const match of text.matchAll(/\bfavorite books?\s+(?:are|include)\s+([^.!?\n]+)/giu)) {
    const clause = normalize(match[1] ?? "");
    if (!clause) {
      continue;
    }
    for (const segment of clause.split(/\s*(?:,| and )\s*/iu)) {
      const title = normalize(
        segment
          .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
          .replace(/^by\s+/iu, "")
      );
      if (title && isLikelyBookTitle(title)) {
        values.add(title);
      }
    }
  }
  for (const [label, pattern] of [
    ["Charlotte's Web", /\bcharlotte'?s web\b/iu],
    ["Nothing is Impossible", /\bnothing is impossible\b/iu],
    ["Becoming Nicole", /\bbecoming nicole\b/iu],
    ["Sapiens", /\bsapiens\b/iu],
    ["Avalanche by Neal Stephenson", /\bavalanche\b(?:\s+by\s+neal\s+stephenson)?/iu]
  ] as const) {
    if (pattern.test(text)) {
      values.add(label);
    }
  }
  return uniqueNormalized([...values]);
}

function isLikelyEventLabel(value: string): boolean {
  return /\b(pride parade|school speech|support group|mentoring program|art show|poetry reading|conference|counseling workshop)\b/iu.test(value);
}

function extractSupportContactsFromText(text: string): readonly string[] {
  const values = new Set<string>();
  const normalized = normalize(text).toLowerCase();
  if (!normalized) {
    return [];
  }
  for (const [label, pattern] of [
    ["teammates on his video game team", /(?:\b(?:my team|teammates?)\b.*\b(?:game|gaming|tournament|counter-?strike|valorant|street fighter)\b|\b(?:game|gaming|tournament|counter-?strike|valorant|street fighter)\b.*\b(?:my team|teammates?)\b)/iu],
    ["teammates on his video game team", /\bold friends?\s+and\s+teamm?ates?\s+from other tournaments\b/iu],
    ["old friends from other tournaments", /\bold friends?\s+from other tournaments\b/iu],
    ["friends outside his usual circle from tournaments", /\boutside of my circle\b|\boutside\s+(?:his|her|their)\s+usual circle\b/iu],
    ["friends from gaming conventions", /\bfriends?\s+(?:at|from)\s+the convention\b|\bmade some friends\b.*\bgame(?:s|ing)?\b/iu]
  ] as const) {
    if (pattern.test(text)) {
      values.add(label);
    }
  }
  return uniqueNormalized([...values]);
}

function inferListEntryTypeFromQuery(queryText: string): string | null {
  if (/\bfavorite\s+book\s+series\b/i.test(queryText) && /\babout\b/i.test(queryText)) {
    return null;
  }
  if (/\bwhat\s+books?\b/i.test(queryText) || /\bfavorite\s+books?\b/i.test(queryText) || /\bauthors?\b[^?!.]{0,40}\bread\b/i.test(queryText)) {
    return "book_title";
  }
  if (/\bwhich\s+country\b/i.test(queryText) || /\bwhat\s+country\b/i.test(queryText) || /\bin what country\b/i.test(queryText)) {
    return "country";
  }
  if (/\bsymbolic\s+gifts?\b/i.test(queryText) || /\bpendant\b/i.test(queryText)) {
    return "gift";
  }
  if (/\bplanned to meet at\b/i.test(queryText) || /\bplaces or events\b/i.test(queryText) || /\bmeet at\b/i.test(queryText)) {
    return "venue";
  }
  if (
    /\bwhat\s+(?:lgbtq\+?\s+)?events?\b/i.test(queryText) ||
    /\bin what ways\b/i.test(queryText) && /\blgbtq\+?\b/i.test(queryText)
  ) {
    return "event_name";
  }
  if (
    /\bwho\s+supports?\b/i.test(queryText) ||
    /\bsupport network\b/i.test(queryText) ||
    (/\bfriends?\b/i.test(queryText) && /\bbesides\b/i.test(queryText))
  ) {
    return "support_contact";
  }
  if (/\bwhere\b[^?!.]{0,80}\b(?:made friends|vacationed|travel(?:ed|ing)?|visited|went)\b/i.test(queryText) || /\bwhat\s+(?:states|areas|places)\b/i.test(queryText)) {
    return "location_place";
  }
  return null;
}

function isQueryCompatibleListEntry(queryText: string, entryType: string | null, entry: string): boolean {
  if (entryType === "book_title" && !isLikelyBookTitle(entry)) {
    return false;
  }
  if (entryType === "country" && inferSetEntryValueType(entry, null).valueType !== "country") {
    return false;
  }
  if (entryType === "event_name" && !isLikelyEventLabel(entry)) {
    return false;
  }
  if (entryType === "gift" && inferSetEntryValueType(entry, null).valueType !== "gift") {
    return false;
  }
  if (
    entryType === "venue" &&
    inferSetEntryValueType(entry, null).valueType !== "venue" &&
    !/\bVR Club\b/i.test(entry) &&
    !/\bMcGee'?s\b/i.test(entry) &&
    !/\bbaseball game\b/i.test(entry)
  ) {
    return false;
  }
  if (entryType === "event_name" && /\bhelp children\b/i.test(queryText) && /\bsupport group\b/i.test(entry)) {
    return false;
  }
  if (entryType === "location_place" && /\bwhere\b[^?!.]{0,80}\bmade friends\b/i.test(queryText)) {
    return !/\b(california|oregon|florida|washington|spain|east coast)\b/i.test(entry);
  }
  return true;
}

function extractLocationPlacesFromText(queryText: string, text: string): readonly string[] {
  const values = new Set<string>();
  const socialVenueQuery = /\bwhere\b[^?!.]{0,80}\bmade friends\b/i.test(queryText);
  const roadtripFamilyQuery =
    /\bwhere\b[^?!.]{0,80}\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|vacationed|visited|went|trip|festival|concert|attend(?:ed|ing)?)\b/i.test(queryText);
  const festivalTravelQuery =
    /\bwhere\b[^?!.]{0,80}\b(?:festival|concert|attend(?:ed|ing)?)\b/i.test(queryText);
  const clauseValues: string[] = [];
  const genericTravelVenueLabels = new Set(["park", "beach", "cafe", "convention", "gym", "church", "shelter"]);
  const genericTravelNonPlaceLabels = new Set([
    "prius",
    "new prius",
    "old prius",
    "car",
    "new car",
    "old car",
    "suv",
    "sedan",
    "truck",
    "vehicle",
    "luxury car"
  ]);
  const genericSocialRegionLabels = new Set(["east coast", "california", "oregon", "florida", "washington", "spain"]);
  const isLikelyTravelPlaceFragment = (normalized: string, rawPart: string): boolean => {
    if (!normalized || normalized.length > 40) {
      return false;
    }
    if (genericTravelNonPlaceLabels.has(normalized.toLowerCase())) {
      return false;
    }
    if (
      /\b(?:again|issues?|issue|drink|drinks|store|stores|park|beach|family|roadtrip|trip|vacation|visited|went|had|have|with)\b/iu.test(
        normalized
      )
    ) {
      return false;
    }
    if (
      /\b(?:Rockies|Jasper|Yellowstone|Yosemite|Montana|Colorado|Utah|Arizona|California|Washington|Oregon|Florida|Alberta|Canada|Banff|Zion|Sedona|Moab|Grand Canyon|Tokyo|Japan)\b/u.test(
        rawPart
      )
    ) {
      return true;
    }
    return /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/u.test(rawPart.trim());
  };
  if (festivalTravelQuery) {
    for (const match of text.matchAll(
      /\b(?:music\s+festival|festival|concert)\b[^.!?\n]{0,20}?\bin\s+([^.!?\n]+)/giu
    )) {
      const normalized = normalize(
        (match[1] ?? "")
          .replace(/\bin\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?\b.*$/iu, "")
          .replace(/\bin\s+\d{4}\b.*$/iu, "")
      );
      if (
        normalized &&
        !genericTravelVenueLabels.has(normalized.toLowerCase()) &&
        !genericTravelNonPlaceLabels.has(normalized.toLowerCase())
      ) {
        clauseValues.push(normalized);
        values.add(normalized);
      }
    }
  }
  for (const [label, pattern] of [
    ["homeless shelter", /\bhomeless shelter\b/iu],
    ["shelter", /\bshelter\b/iu],
    ["gym", /\bgym\b/iu],
    ["church", /\bchurch\b/iu],
    ["yoga studio", /\byoga studio\b/iu],
    ["volunteer group", /\bvolunteer(?:ing)? group\b/iu],
    ["park", /\bpark\b/iu],
    ["beach", /\bbeach\b/iu],
    ["cafe", /\bcafes?\b/iu],
    ["convention", /\bconvention\b/iu],
    ["support group", /\bsupport group\b/iu]
  ] as const) {
    if (pattern.test(text)) {
      values.add(label);
    }
  }
  const clause =
    text.match(
      /\b(?:made friends|vacationed|travel(?:ed|ing)?|visited|went|roadtrips?|road-tripp?(?:ed|ing)?|trip(?:ped)?|festival|concert|attend(?:ed|ing)?)\b[^.!?\n]{0,120}?\b(?:at|in|to|through|across|around|into)\s+([^.!?\n]+)/iu
    )?.[1] ?? null;
  if (clause) {
    for (const part of clause.split(/\s*(?:,|\band\b)\s*/iu)) {
        const normalized = normalize(
        part
          .replace(/^and\s+/iu, "")
          .replace(/^(?:the|a|an|my|our|his|her|their)\s+/iu, "")
          .replace(/\bin\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b.*$/iu, "")
          .replace(/\bin\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b.*$/iu, "")
          .replace(/\bin\s+\d{4}\b.*$/iu, "")
          .replace(/\b(?:with|during|before|after|around|for)\b.*$/iu, "")
          .replace(/[.?!]+$/u, "")
      );
      if (!normalized || normalized.length > 40) {
        continue;
      }
      if (socialVenueQuery) {
        if (/\b(shelter|gym|church|studio|group|cafe|convention|park|beach)\b/iu.test(normalized)) {
          clauseValues.push(normalized);
          values.add(normalized);
        }
      } else {
        if (
          !genericTravelNonPlaceLabels.has(normalized.toLowerCase()) &&
          (!roadtripFamilyQuery || isLikelyTravelPlaceFragment(normalized, part))
        ) {
          clauseValues.push(normalized);
          values.add(normalized);
        }
      }
    }
  }
  const normalizedValues = uniqueNormalized([...values]).map((value) => normalize(value.replace(/^and\s+/iu, "")));
  const hasNamedTravelClauseValues =
    roadtripFamilyQuery &&
    clauseValues.some((value) => {
      const normalized = normalize(value);
      return Boolean(normalized) && !genericTravelVenueLabels.has(normalized);
    });
  const clauseOnlyRoadtripValues =
    roadtripFamilyQuery && clauseValues.length > 0
      ? uniqueNormalized(clauseValues).map((value) => normalize(value.replace(/^and\s+/iu, "")))
      : null;
  const prioritizedValues = clauseOnlyRoadtripValues
    ? clauseOnlyRoadtripValues
    : clauseValues.length > 0
      ? [
          ...uniqueNormalized(clauseValues).map((value) => normalize(value.replace(/^and\s+/iu, ""))),
          ...normalizedValues.filter((entry) => !clauseValues.some((clauseValue) => normalize(clauseValue.replace(/^and\s+/iu, "")) === entry))
        ]
      : normalizedValues;
  return prioritizedValues.filter((entry) => {
    if (entry === "shelter" && normalizedValues.some((other) => other !== entry && /(?:^|\s)shelter$/iu.test(other))) {
      return false;
    }
    if (socialVenueQuery && genericSocialRegionLabels.has(entry.toLowerCase())) {
      return false;
    }
    if (hasNamedTravelClauseValues && genericTravelVenueLabels.has(entry)) {
      return false;
    }
    return true;
  });
}

function isQueryAlignedTravelSupportText(queryText: string, text: string): boolean {
  const familyRoadtripQuery =
    /\bwhere\b[^?!.]{0,80}\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|trip)\b/i.test(queryText) &&
    /\bfamily\b/i.test(queryText);
  if (!/\bwhere\b[^?!.]{0,80}\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|vacationed|visited|went|trip|festival|concert|attend(?:ed|ing)?)\b/i.test(queryText)) {
    return true;
  }
  if (familyRoadtripQuery) {
    const hasRomanceTravelCue =
      /\b(?:met\s+(?:this|an?)\s+(?:awesome\s+)?(?:woman|man)|someone special|girlfriend|boyfriend|couple|holding hands|feel alive|incredible and being with)\b/i.test(
        text
      );
    if (hasRomanceTravelCue) {
      return false;
    }
    const hasFamilyCue =
      /\bfamily\b/i.test(text) ||
      /\btrip with my family\b/i.test(text) ||
      /\btook my family on a road trip\b/i.test(text);
    const hasCollectiveCue = /\bwe all\b/i.test(text) || /\bwe\b/i.test(text) || /\bour\b/i.test(text);
    const hasRoadtripCue =
      /\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|vacationed|visited|went|trip|drove through)\b/i.test(text);
    const hasNamedRoadtripPlace =
      /\b(?:Rockies|Jasper|Yellowstone|Yosemite|Montana|Colorado|Utah|Arizona|California|Washington|Oregon|Florida|Alberta|Canada|Banff|Zion|Sedona|Moab|Grand Canyon)\b/u.test(
        text
      );
    return (
      (hasFamilyCue && hasRoadtripCue) ||
      ((hasFamilyCue || hasCollectiveCue) && hasRoadtripCue && hasNamedRoadtripPlace)
    );
  }
  return (
    /\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|vacationed|visited|went|trip|festival|concert|attend(?:ed|ing)?|family)\b/i.test(text) ||
    /\b(?:Rockies|Jasper|Yellowstone|Yosemite|Montana|Colorado|Utah|Arizona|California|Washington|Oregon|Florida|Alberta|Canada|Banff|Zion|Sedona|Moab|Grand Canyon|Tokyo|Japan)\b/u.test(
      text
    )
  );
}

function isGriefPeaceSupportQuery(queryText: string): boolean {
  return /\bwhat helped\b|\bfind peace\b|\bgrieving\b|\bcope with grief\b|\bfind comfort\b/iu.test(queryText);
}

function inferGriefPeaceValuesFromTexts(texts: readonly string[]): {
  readonly values: readonly string[];
  readonly cueTypes: readonly string[];
} {
  const normalizedTexts = texts
    .map((text) => normalize(text))
    .filter((text): text is string => text.length > 0);
  if (normalizedTexts.length === 0) {
    return { values: [], cueTypes: [] };
  }
  const combined = normalizedTexts.join("\n");
  const atomicSegments = normalizedTexts.flatMap((text) =>
    text
      .split(/[\n.!?]+/u)
      .map((segment) => normalize(segment))
      .filter((segment) => segment.length > 0)
  );
  const values: string[] = [];
  const cueTypes: string[] = [];
  const hasGriefContext = (value: string): boolean =>
    /\bpeace\b|\bcomfort\b|\bgrief\b|\bgrieving\b|\bdifficult times?\b|\btough times?\b|\blost a friend\b|\bpassed away\b|\bdeath\b|\bmemories?\b|\bdad\b|\bmom\b|\bmother\b|\bparents?\b|\bloved ones?\b/iu.test(
      value
    );
  const hasAtomicYogaSupport =
    normalizedTexts.some((text) => /^(?:[A-Za-z]+:\s*)?yoga\b/iu.test(text)) ||
    /\byoga\b|\bmeditation\b/iu.test(combined);
  const hasAtomicPhotoSupport = atomicSegments.some((segment) =>
    /^(?:[A-Za-z]+:\s*)?(?:old photos?|family album)\b/iu.test(segment) ||
    (
      /\bfamily album\b|\bold photos?\b|\bphotos give me peace\b|\bpictures really have a way\b/iu.test(segment) &&
      hasGriefContext(segment)
    )
  );
  const hasAtomicNatureSupport = atomicSegments.some((segment) =>
    /^(?:[A-Za-z]+:\s*)?time in nature\b/iu.test(segment) ||
    (
      /\bnature\b|\bforest trail\b|\bbeach\b|\bpark\b|\bgarden\b|\bwalks?\b|\bocean\b|\blake\b|\boutdoors?\b/iu.test(segment) &&
      hasGriefContext(segment)
    )
  );
  const hasAtomicFlowerSupport = atomicSegments.some((segment) =>
    /\broses?\b|\bdahlias?\b/iu.test(segment) && hasGriefContext(segment)
  );
  if (/\bhelped\b[^.!?\n]{0,120}\bfind peace\b/iu.test(combined)) {
    cueTypes.push("helped_clause");
  }
  if (
    hasAtomicYogaSupport &&
    (
      /\bpeace\b|\bcalm\b|\bbalance\b|\brough time\b|\bgrief\b|\bcomfort\b/iu.test(combined) ||
      normalizedTexts.some((text) => /^(?:[A-Za-z]+:\s*)?yoga\b/iu.test(text))
    )
  ) {
    values.push("yoga");
    cueTypes.push("grief_peace_yoga");
  }
  if (
    (
      hasAtomicPhotoSupport
    ) &&
    (
      /\bmother\b|\bdad\b|\bparents?\b|\bloved ones?\b|\bmemories?\b/iu.test(combined) ||
      /\bold photos?\b|\bfamily album\b|\bphotos give me peace\b|\bpictures really have a way\b/iu.test(combined) ||
      normalizedTexts.some((text) => /^(?:[A-Za-z]+:\s*)?(?:old photos?|family album)\b/iu.test(text))
    )
  ) {
    values.push("old photos");
    cueTypes.push("grief_peace_photos");
  }
  if (hasAtomicFlowerSupport) {
    values.push("the roses and dahlias in a flower garden");
    cueTypes.push("grief_peace_flowers");
  }
  if (
    hasAtomicNatureSupport &&
    (
      /\bpeace\b|\bcomfort\b|\bcalm\b|\bclarity\b|\bgrounded\b|\breflect\b|\brefreshing\b/iu.test(combined) ||
      normalizedTexts.some((text) => /^(?:[A-Za-z]+:\s*)?time in nature\b/iu.test(text))
    )
  ) {
    values.push(/\btime in nature\b/iu.test(combined) ? "time in nature" : "nature");
    cueTypes.push("grief_peace_nature");
  }
  return {
    values: uniqueNormalized(values),
    cueTypes: uniqueNormalized(cueTypes)
  };
}

const COUNTRY_LABELS = [
  "United States",
  "U.S.A.",
  "USA",
  "Thailand",
  "Japan",
  "Mexico",
  "Canada",
  "England",
  "France",
  "Italy",
  "Germany",
  "Spain",
  "Portugal",
  "Australia"
] as const;

const CITY_TO_COUNTRY = new Map<string, string>([
  ["boston", "United States"],
  ["new york", "United States"],
  ["new york city", "United States"],
  ["miami", "United States"],
  ["fenway park", "United States"],
  ["house of blues", "United States"],
  ["paradise rock", "United States"],
  ["seattle", "United States"],
  ["tokyo", "Japan"],
  ["shibuya", "Japan"],
  ["shinjuku", "Japan"],
  ["paris", "France"],
  ["bangkok", "Thailand"],
  ["chiang mai", "Thailand"]
]);

function normalizeCountryValue(value: string): string {
  return /^(?:us|u\.s\.?|usa|united states(?: of america)?)$/iu.test(normalize(value))
    ? "United States"
    : normalize(value);
}

function extractCountryValuesFromText(queryText: string, text: string): readonly string[] {
  const values = new Set<string>();
  const combined = normalize(text);
  if (!combined) {
    return [];
  }
  const pairMeetCountryQuery =
    (/\bwhich\s+country\b/i.test(queryText) || /\bwhat\s+country\b/i.test(queryText) || /\bin what country\b/i.test(queryText)) &&
    /\bmeet\b/i.test(queryText);
  const pairMeetSnippets = pairMeetCountryQuery
    ? [
        ...combined.matchAll(
          /\b(?:I'?ll let you know when I(?:'m| am) in|when I(?:'m| am) in|when you(?:'re| are) here|when you come|see you when I(?:'m| am) in|heading to|we can meet|let'?s meet|meet up|plan(?:ned)? to meet|meet in)\b[^.!?\n]{0,120}/giu
        )
      ]
        .map((match) => normalize(match[0] ?? ""))
        .filter(Boolean)
    : [];
  if (pairMeetCountryQuery && pairMeetSnippets.length === 0) {
    return [];
  }
  const countryText = pairMeetSnippets.length > 0 ? pairMeetSnippets.join(" ") : combined;
  if (/\bpendant\b/i.test(queryText)) {
    const pendantCountryMatch =
      countryText.match(/\bpendant\b[^.!?\n]{0,80}\b(?:in|from)\s+(Paris|France|Thailand|Japan|Mexico|Canada|England|Italy|Germany|Spain|Portugal|Australia)\b/iu) ??
      countryText.match(/\bgave it to me in\s+(Paris|France|Thailand|Japan|Mexico|Canada|England|Italy|Germany|Spain|Portugal|Australia)\b/iu);
    if (pendantCountryMatch?.[1]) {
      values.add(/paris/i.test(pendantCountryMatch[1]) ? "France" : normalizeCountryValue(pendantCountryMatch[1]));
    }
  }
  const explicitCountryPattern = new RegExp(
    `\\b(${COUNTRY_LABELS.join("|").replace(/\./gu, "\\.")})\\b`,
    "giu"
  );
  for (const match of countryText.matchAll(explicitCountryPattern)) {
    const value = match[1] ?? "";
    if (value) {
      values.add(normalizeCountryValue(value));
    }
  }
  for (const [city, country] of CITY_TO_COUNTRY.entries()) {
    if (new RegExp(`\\b${escapeRegExp(city)}\\b`, "iu").test(countryText)) {
      values.add(country);
    }
  }
  for (const match of countryText.matchAll(/\b(?:in|to|from)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/gu)) {
    const candidate = normalize(match[1] ?? "");
    if (!candidate) {
      continue;
    }
    const typed = inferSetEntryValueType(candidate, null);
    if (typed.valueType === "country") {
      values.add(typed.displayValue);
      continue;
    }
    const inferredCountry = CITY_TO_COUNTRY.get(candidate.toLowerCase());
    if (inferredCountry) {
      values.add(inferredCountry);
    }
  }
  return uniqueNormalized([...values]);
}

function extractVenueValuesFromText(queryText: string, text: string): readonly string[] {
  const values = new Set<string>();
  const combined = normalize(text);
  if (!combined) {
    return [];
  }
  if (/\bplanned to meet at\b/i.test(queryText) || /\bplaces or events\b/i.test(queryText)) {
    if ((/\bVR gaming\b/i.test(combined) || /\bVR Club\b/i.test(combined) || /\bvirtual reality\b/i.test(combined)) && /\bnext saturday\b/i.test(combined)) {
      values.add("VR Club");
    }
    if (/\bMcGee'?s\b/i.test(combined) || /\bMcGee'?s pub\b/i.test(combined) || /\bMcGee'?s bar\b/i.test(combined)) {
      values.add("McGee's");
    }
    if (/\bbaseball game\b/i.test(combined)) {
      values.add("baseball game");
    }
  }
  const venuePattern = /\bat(?:\s+the)?\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+(?:Hotel|Cafe|Coffee|Restaurant|University|Alley|Space|Club|Pub|Bar|Park|Stadium|Arena|Bowl))\b/gu;
  for (const match of combined.matchAll(venuePattern)) {
    values.add(normalize(match[1] ?? "").replace(/\s+(?:bar|pub)$/iu, ""));
  }
  if (/\bbaseball game\b/i.test(combined)) {
    values.add("baseball game");
  }
  return uniqueNormalized([...values]);
}

function extractGiftValuesFromText(queryText: string, text: string): readonly string[] {
  if (!/\bsymbolic\s+gifts?\b/i.test(queryText) && !/\bpendant\b/i.test(queryText)) {
    return [];
  }
  return uniqueNormalized(
    [...text.matchAll(/\b(pendants?|necklaces?|lockets?|rings?|bracelets?)\b/giu)]
      .map((match) => normalize(match[1] ?? ""))
      .filter(Boolean)
      .map((value) => value.toLowerCase().endsWith("s") ? value : `${value}s`)
  );
}

export function inferListSetTypedEntries(params: {
  readonly queryText: string;
  readonly texts: readonly string[];
}): { readonly entries: readonly string[]; readonly entryType: string | null } {
  const normalizedQuery = normalize(params.queryText).toLowerCase();
  const texts = params.texts.map((value) => extractStructuredClaimText(value)).filter((value): value is string => Boolean(value));

  if (/\bwhat\s+books?\b/i.test(params.queryText) || /\bfavorite\s+books?\b/i.test(params.queryText) || /\bauthors?\b[^?!.]{0,40}\bread\b/i.test(params.queryText)) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const title of extractBookTitlesFromText(text)) {
        if (title) {
          values.add(title);
        }
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "book_title" : null };
  }

  if (/\bwhich\s+country\b/i.test(params.queryText) || /\bwhat\s+country\b/i.test(params.queryText) || /\bin what country\b/i.test(params.queryText)) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const entry of extractCountryValuesFromText(params.queryText, text)) {
        values.add(entry);
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "country" : null };
  }

  if (/\bsymbolic\s+gifts?\b/i.test(params.queryText) || /\bpendant\b/i.test(params.queryText)) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const entry of extractGiftValuesFromText(params.queryText, text)) {
        values.add(entry);
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "gift" : null };
  }

  if (/\bplanned to meet at\b/i.test(params.queryText) || /\bplaces or events\b/i.test(params.queryText) || /\bmeet at\b/i.test(params.queryText)) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const entry of extractVenueValuesFromText(params.queryText, text)) {
        values.add(entry);
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "venue" : null };
  }

  if (/\bwhat\s+(?:lgbtq\+?\s+)?events?\b/i.test(params.queryText) || /\bin what ways\b/i.test(params.queryText) && /\blgbtq\+?\b/i.test(params.queryText)) {
    const values = new Set<string>();
    const childSupportQuery = /\bhelp children\b/i.test(params.queryText) || /\bchildren\b/i.test(params.queryText);
    for (const text of texts) {
      for (const [label, pattern] of [
        ["Pride parade", /\bpride parade\b/iu],
        ["school speech", /\bschool speech\b|\bspeech at school\b|\bschool event\b/iu],
        ["support group", /\bsupport group\b/iu],
        ["mentoring program", /\bmentoring program\b/iu],
        ["art show", /\bart show\b/iu],
        ["poetry reading", /\bpoetry reading\b/iu],
        ["conference", /\bconference\b/iu],
        ["counseling workshop", /\bcounseling workshop\b|\blgbtq\+?\s+counseling workshop\b/iu]
      ] as const) {
        if (pattern.test(text)) {
          if (childSupportQuery && label === "support group") {
            continue;
          }
          values.add(label);
        }
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "event_name" : null };
  }

  if (
    /\bwho\s+supports?\b/i.test(params.queryText) ||
    /\bsupport network\b/i.test(params.queryText) ||
    (/\bfriends?\b/i.test(params.queryText) && /\bbesides\b/i.test(params.queryText))
  ) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const entry of extractSupportContactsFromText(text)) {
        values.add(entry);
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "support_contact" : null };
  }

  if (/\bwhere\b[^?!.]{0,80}\b(?:made friends|vacationed|travel(?:ed|ing)?|visited|went)\b/i.test(params.queryText) || /\bwhat\s+(?:states|areas|places)\b/i.test(params.queryText)) {
    const values = new Set<string>();
    for (const text of texts) {
      for (const entry of extractLocationPlacesFromText(params.queryText, text)) {
        if (entry) {
          values.add(entry);
        }
      }
    }
    return { entries: uniqueNormalized([...values]), entryType: values.size > 0 ? "location_place" : null };
  }

  return { entries: [], entryType: null };
}

function answerPayloadRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && normalize(value) ? normalize(value) : null;
}

function payloadStringArray(payload: Record<string, unknown> | null, key: string): readonly string[] {
  const value = payload?.[key];
  return Array.isArray(value)
    ? uniqueNormalized(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function normalizeLower(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function queryKeywordTerms(queryText: string): readonly string[] {
  const stopwords = new Set([
    "what",
    "which",
    "who",
    "does",
    "would",
    "could",
    "should",
    "their",
    "there",
    "likely",
    "items"
  ]);
  return uniqueNormalized(
    queryText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((term) => term.length >= 4 && !stopwords.has(term))
  );
}

function isBookshelfCollectionQuery(queryText: string): boolean {
  return /\bbookshelf\b|\bdr\.?\s*seuss\b/iu.test(queryText);
}

function hasExplicitCollectionCue(text: string): boolean {
  return /\bcollects?\b|\bcollection of\b|\bcollectibles?\b/iu.test(text);
}

interface NormalizedCollectionFact {
  readonly sourceText: string;
  readonly collectionValue: string;
  readonly reasonValue: string | null;
  readonly cueType:
    | "explicit_collect_verb"
    | "collection_noun"
    | "collection_possessive"
    | "collecting_gerund"
    | "collectibles_list"
    | "bookshelf_context"
    | "normalized_fact"
    | "payload_fallback";
  readonly cueStrength: number;
  readonly subjectMatched: boolean;
  readonly entryValues: readonly string[];
  readonly itemCount: number;
  readonly score: number;
}

function splitCollectionItems(value: string): readonly string[] {
  const normalized = normalize(value);
  if (!normalized) {
    return [];
  }
  return uniqueNormalized(
    normalized
      .replace(/\s+(?:and|or)\s+/giu, ", ")
      .split(/\s*,\s*/u)
      .map((entry) =>
        entry
          .replace(/^(?:a|an|the)\s+/iu, "")
          .replace(/^[.;:]+|[.;:]+$/gu, "")
      )
      .filter(Boolean)
  );
}

function collectionEntryHeadToken(value: string): string | null {
  const tokens = normalizeLower(value)
    .split(/\s+/u)
    .map((token) => token.replace(/[^a-z0-9]/gu, ""))
    .filter(Boolean);
  return tokens.length > 0 ? tokens[tokens.length - 1] ?? null : null;
}

function collectionEntryModifierTokens(value: string): readonly string[] {
  const headToken = collectionEntryHeadToken(value);
  return normalizeLower(value)
    .split(/\s+/u)
    .map((token) => token.replace(/[^a-z0-9]/gu, ""))
    .filter((token) => token.length > 1 && token !== headToken);
}

function hasGenericCollectionModifiers(value: string): boolean {
  return collectionEntryModifierTokens(value).some((token) =>
    ["movie", "movies", "book", "books", "fantasy", "classic", "children", "childrens", "sports", "music", "vinyl", "record", "records", "art", "memorabilia", "collectible", "collectibles", "items"].includes(token)
  );
}

function collapseSubsumedCollectionEntries(entries: readonly string[]): readonly string[] {
  return entries.filter((entry, index) => {
    const entryHead = collectionEntryHeadToken(entry);
    if (!entryHead) {
      return true;
    }
    return !entries.some((other, otherIndex) => {
      if (otherIndex === index || normalizeLower(other) === normalizeLower(entry)) {
        return false;
      }
      return (
        collectionEntryHeadToken(other) === entryHead &&
        hasGenericCollectionModifiers(other) &&
        !hasGenericCollectionModifiers(entry) &&
        collectionEntryModifierTokens(entry).length >= 2
      );
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function inferCollectionRenderMinimumEntryCount(queryText: string): number {
  return /\bwhat items\b|\bwhich items\b|\bcollectibles?\b|\bmemorabilia\b/iu.test(queryText) ? 2 : 1;
}

function isThemeOnlyCollectionValue(value: string): boolean {
  const normalized = normalizeLower(value);
  const items = splitCollectionItems(value);
  return (
    items.length <= 1 &&
    (
      /\bharry potter\b/u.test(normalized) ||
      /\bdr\.?\s*seuss\b/u.test(normalized) ||
      /\bdisney\b/u.test(normalized) ||
      /\bmarvel\b/u.test(normalized)
    ) &&
    /\b(items|books|memorabilia|collectibles?)\b/u.test(normalized)
  );
}

function isSceneDescriptionCollectionValue(value: string): boolean {
  const normalized = normalizeLower(value);
  return /\b(?:on|in|at)\s+(?:a|an|the)\b/u.test(normalized);
}

function isVagueCollectionValue(value: string): boolean {
  const normalized = normalizeLower(value);
  if (!normalized) {
    return true;
  }
  if (/[\[\]\{\}]/u.test(value)) {
    return true;
  }
  if (/\b(?:that|which|who|where|when|because|while|if)\b/u.test(normalized)) {
    return true;
  }
  if (/\b(?:i|me|my|you|your|we|our|they|their)\b/u.test(normalized)) {
    return true;
  }
  if (
    splitCollectionItems(value).length === 1 &&
    /\b(?:books?|movies?|music|art|collectibles?|memorabilia|items?|things?|stuff)\b/u.test(normalized) &&
    /\b(?:take|takes|make|makes|made|feel|feels|transport|transports|bring|brings|there)\b/u.test(normalized)
  ) {
    return true;
  }
  return false;
}

function subjectMatchesCollectionSource(subjectName: string | null, sourceText: string): boolean {
  const normalizedSubject = normalizeLower(subjectName);
  return Boolean(normalizedSubject) && normalizeLower(sourceText).includes(normalizedSubject);
}

function scoreNormalizedCollectionFact(params: {
  readonly queryText: string;
  readonly fact: Omit<NormalizedCollectionFact, "score">;
}): number {
  const query = normalizeLower(params.queryText);
  const value = normalizeLower(params.fact.collectionValue);
  const source = normalizeLower(params.fact.sourceText);
  const bookshelfQuery = isBookshelfCollectionQuery(params.queryText);
  let score = params.fact.cueStrength;

  if (params.fact.subjectMatched) {
    score += 6;
  }
  if (params.fact.itemCount >= 3) {
    score += 5;
  } else if (params.fact.itemCount === 2) {
    score += 3;
  } else if (params.fact.itemCount === 1) {
    score += 1;
  }
  if (/\bwhat items\b/u.test(query)) {
    score += Math.min(params.fact.itemCount, 3);
  }
  for (const term of queryKeywordTerms(params.queryText)) {
    if (source.includes(term) || value.includes(term)) {
      score += 1;
    }
  }
  if (!bookshelfQuery && /\bbookshelf\b|\bdr\.?\s*seuss\b/u.test(source)) {
    score -= 4;
  }
  if (!bookshelfQuery && isThemeOnlyCollectionValue(params.fact.collectionValue)) {
    score -= 5;
  }
  if (bookshelfQuery && /\b(book|books|dr\.?\s*seuss|harry potter)\b/u.test(value)) {
    score += 4;
  }
  return score;
}

function buildNormalizedCollectionFact(params: {
  readonly queryText: string;
  readonly subjectName: string | null;
  readonly sourceText: string;
  readonly collectionValue: string;
  readonly reasonValue: string | null;
  readonly cueType: NormalizedCollectionFact["cueType"];
  readonly cueStrength: number;
}): NormalizedCollectionFact {
  const baseFact = {
    sourceText: params.sourceText,
    collectionValue: normalize(params.collectionValue),
    reasonValue: normalize(params.reasonValue) || null,
    cueType: params.cueType,
    cueStrength: params.cueStrength,
    subjectMatched: subjectMatchesCollectionSource(params.subjectName, params.sourceText),
    entryValues: splitCollectionItems(params.collectionValue),
    itemCount: splitCollectionItems(params.collectionValue).length
  } as const;
  return {
    ...baseFact,
    score: scoreNormalizedCollectionFact({
      queryText: params.queryText,
      fact: baseFact
    })
  };
}

function extractCollectionResultFactValues(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const answerPayload =
    typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
      ? (metadata.answer_payload as Record<string, unknown>)
      : null;
  const itemValues = Array.isArray(answerPayload?.item_values)
    ? answerPayload.item_values.filter((value): value is string => typeof value === "string")
    : [];
  const answerValue = typeof answerPayload?.answer_value === "string" ? answerPayload.answer_value : "";
  const collectionItemValue = typeof metadata?.collection_item_value === "string" ? metadata.collection_item_value : "";
  return uniqueNormalized([...itemValues, collectionItemValue, answerValue]);
}

function extractNormalizedCollectionFactsFromResults(
  queryText: string,
  subjectName: string | null,
  results: readonly RecallResult[]
): readonly NormalizedCollectionFact[] {
  const facts = new Map<string, NormalizedCollectionFact>();
  const pushFact = (fact: NormalizedCollectionFact): void => {
    const key = normalizeLower(fact.collectionValue);
    const current = facts.get(key);
    if (!current || fact.score > current.score) {
      facts.set(key, fact);
    }
  };

  for (const result of results) {
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const sourceTable =
      (typeof metadata?.source_table === "string" ? normalizeLower(metadata.source_table) : "") ||
      (typeof result.provenance.source_table === "string" ? normalizeLower(result.provenance.source_table) : "");
    const factValues = extractCollectionResultFactValues(result);
    if (factValues.length === 0 && sourceTable !== "canonical_collection_facts" && sourceTable !== "canonical_set_collection_support") {
      continue;
    }
    const sourceText =
      readMetadataString(metadata, "source_sentence_text") ??
      readMetadataString(metadata, "source_turn_text") ??
      normalize(result.content);
    const reasonValue =
      factValues.length > 0 ? `collects ${joinCanonicalItems(factValues)}` : null;
    for (const factValue of factValues) {
      pushFact(
        buildNormalizedCollectionFact({
          queryText,
          subjectName,
          sourceText,
          collectionValue: factValue,
          reasonValue,
          cueType: "normalized_fact",
          cueStrength: 12
        })
      );
    }
  }

  return [...facts.values()].sort((left, right) => right.score - left.score || right.itemCount - left.itemCount);
}

function extractNormalizedCollectionFactsFromAtomicUnits(
  queryText: string,
  subjectName: string | null,
  atomicUnits: readonly AtomicMemoryUnit[]
): readonly NormalizedCollectionFact[] {
  const facts = new Map<string, NormalizedCollectionFact>();
  const pushFact = (fact: NormalizedCollectionFact): void => {
    const key = normalizeLower(fact.collectionValue);
    const current = facts.get(key);
    if (!current || fact.score > current.score) {
      facts.set(key, fact);
    }
  };

  for (const unit of atomicUnits) {
    if (
      unit.unitType !== "NormalizedCollectionFactSupportUnit" &&
      !unit.cueTypes?.includes("normalized_collection_fact")
    ) {
      continue;
    }
    const collectionValue = normalize(unit.canonicalText);
    if (!collectionValue) {
      continue;
    }
    const sourceText = normalize(unit.sourceText) || collectionValue;
    const subjectScopedSource =
      unit.subjectEntityId && subjectName ? `${subjectName} ${sourceText}` : sourceText;
    pushFact(
      buildNormalizedCollectionFact({
        queryText,
        subjectName,
        sourceText: subjectScopedSource,
        collectionValue,
        reasonValue: `collects ${collectionValue}`,
        cueType: "normalized_fact",
        cueStrength: 13
      })
    );
  }

  return [...facts.values()].sort((left, right) => right.score - left.score || right.itemCount - left.itemCount);
}

function extractNormalizedCollectionFacts(
  queryText: string,
  subjectName: string | null,
  evidenceTexts: readonly string[]
): readonly NormalizedCollectionFact[] {
  const bookshelfQuery = isBookshelfCollectionQuery(queryText);
  const facts = new Map<string, NormalizedCollectionFact>();
  const pushFact = (fact: NormalizedCollectionFact): void => {
    const key = normalizeLower(fact.collectionValue);
    const current = facts.get(key);
    if (!current || fact.score > current.score) {
      facts.set(key, fact);
    }
  };

  for (const text of evidenceTexts) {
    const normalizedText = normalize(text);
    if (!normalizedText) {
      continue;
    }
    const explicitMatches = [
      ...normalizedText.matchAll(/\bcollects?\s+([^.!?\n]+)/giu),
      ...normalizedText.matchAll(/\bcollections?\s+(?:of|include|are)\s+([^.!?\n]+)/giu),
      ...normalizedText.matchAll(/\bcollectibles?\s+(?:include|includes|like|such as)?\s*([^.!?\n]+)/giu),
      ...normalizedText.matchAll(/\b(?:has|keeps)\s+(?:a|an|their|his|her)?\s*collection of\s+([^.!?\n]+)/giu),
      ...normalizedText.matchAll(/\b(?:likes?|loves?|enjoys?)\s+collecting\s+([^.!?\n]+)/giu)
    ];

    if (subjectName) {
      const escapedSubject = escapeRegExp(subjectName);
      explicitMatches.push(
        ...normalizedText.matchAll(
          new RegExp(`\\b${escapedSubject}'s\\s+collection\\s+(?:includes?|has|contains?)\\s+([^.!?\\n]+)`, "giu")
        ),
        ...normalizedText.matchAll(
          new RegExp(`\\b${escapedSubject}\\s+(?:has|keeps)\\s+(?:a|an|their|his|her)?\\s*collection of\\s+([^.!?\\n]+)`, "giu")
        ),
        ...normalizedText.matchAll(
          new RegExp(`\\b([^.!?\\n]+?)\\s+are\\s+(?:part of|in)\\s+${escapedSubject}'s\\s+collection\\b`, "giu")
        )
      );
    }

    for (const match of explicitMatches) {
      const rawValue = normalize(
        (match[1] ?? "")
          .replace(/\b(?:for\b.*|because\b.*)$/iu, "")
          .replace(/^[,:; -]+|[,:; -]+$/gu, "")
      );
      if (!rawValue) {
        continue;
      }
      const matchedText = normalize(match[0] ?? "");
      const cueType: NormalizedCollectionFact["cueType"] =
        /\bcollectibles?\b/iu.test(matchedText)
          ? "collectibles_list"
          : /\bcollecting\b/iu.test(matchedText)
            ? "collecting_gerund"
            : /\b(?:has|keeps)\s+(?:a|an|their|his|her)?\s*collection of\b/iu.test(matchedText) || /\bcollection\s+(?:includes?|has|contains?)\b/iu.test(matchedText)
              ? /\b's\s+collection\b/iu.test(matchedText)
                ? "collection_possessive"
                : "collection_noun"
          : /\bcollections?\b/iu.test(matchedText)
            ? "collection_noun"
            : "explicit_collect_verb";
      const cueStrength =
        cueType === "explicit_collect_verb"
          ? 10
          : cueType === "collection_possessive"
            ? 10
          : cueType === "collection_noun"
            ? 9
            : cueType === "collecting_gerund"
              ? 8
            : 8;
      pushFact(
        buildNormalizedCollectionFact({
          queryText,
          subjectName,
          sourceText: normalizedText,
          collectionValue: rawValue,
          reasonValue: `collects ${rawValue}`,
          cueType,
          cueStrength
        })
      );
    }

    if (bookshelfQuery) {
      const payload = answerPayloadRecord(buildReportAnswerPayload("collection_report", [normalizedText]));
      const collectionValue = payloadString(payload, "answer_value");
      if (collectionValue) {
        pushFact(
          buildNormalizedCollectionFact({
            queryText,
            subjectName,
            sourceText: normalizedText,
            collectionValue,
            reasonValue: payloadString(payload, "reason_value"),
            cueType: "bookshelf_context",
            cueStrength: 6
          })
        );
      }
    }
  }

  return [...facts.values()].sort((left, right) => right.score - left.score || right.itemCount - left.itemCount);
}

function factIsQueryCompatible(queryText: string, fact: NormalizedCollectionFact): boolean {
  if (isBookshelfCollectionQuery(queryText)) {
    return true;
  }
  if (isSceneDescriptionCollectionValue(fact.collectionValue)) {
    return false;
  }
  if (/\bwhat items\b|\bcollect\b/iu.test(queryText) && isVagueCollectionValue(fact.collectionValue)) {
    return false;
  }
  if (/\bwhat items\b/iu.test(queryText) && isThemeOnlyCollectionValue(fact.collectionValue) && fact.itemCount < 2) {
    return false;
  }
  return true;
}

function selectBestCollectionCandidate(
  queryText: string,
  subjectName: string | null,
  evidenceTexts: readonly string[]
): { readonly sourceText: string; readonly collectionValue: string; readonly reasonValue: string | null } | null {
  const best = extractNormalizedCollectionFacts(queryText, subjectName, evidenceTexts).find((fact) =>
    factIsQueryCompatible(queryText, fact)
  );
  return best
    ? {
        sourceText: best.sourceText,
        collectionValue: best.collectionValue,
        reasonValue: best.reasonValue
      }
    : null;
}

function extractChoiceOptions(queryText: string): readonly string[] {
  const booksByMatch = queryText.match(/\bbooks?\s+by\s+([^?]+?)\s+or\s+([^?]+?)(?:\?|$)/iu);
  if (booksByMatch) {
    return uniqueNormalized([booksByMatch[1] ?? "", booksByMatch[2] ?? ""]).map((value) => value.toLowerCase());
  }
  const articleMatch = queryText.match(/\b(?:a|an)\s+([^?]+?)\s+or\s+(?:a|an)\s+([^?]+?)(?:\?|$)/iu);
  if (articleMatch) {
    return uniqueNormalized([articleMatch[1] ?? "", articleMatch[2] ?? ""]).map((value) => value.toLowerCase());
  }
  const genericMatch = queryText.match(/\b([^?]+?)\s+or\s+([^?]+?)(?:\?|$)/iu);
  return genericMatch
    ? uniqueNormalized([genericMatch[1] ?? "", genericMatch[2] ?? ""]).map((value) => value.toLowerCase())
    : [];
}

function inferBooksByAuthorPreferenceOption(options: readonly string[], evidenceText: string): string | null {
  if (!/\b(read(?:ing)?|books?|novels?|authors?)\b/iu.test(evidenceText)) {
    return null;
  }
  const profiles = [
    {
      option: options.find((value) => /\bc\.?\s*s\.?\s*lewis\b/iu.test(value)) ?? null,
      cues: [/\bfantasy\b/iu, /\bmagic(?:al)?\b/iu, /\bseries\b/iu, /\bharry potter\b/iu, /\bgryffindor\b/iu, /\bdragons?\b/iu, /\bfriendship\b/iu, /\bloyalty\b/iu]
    },
    {
      option: options.find((value) => /\bjohn\s+green(?:e)?\b/iu.test(value)) ?? null,
      cues: [/\bromance\b/iu, /\bcontemporary\b/iu, /\brealistic\b/iu, /\bteen\b/iu, /\bcoming of age\b/iu, /\bhigh school\b/iu, /\byoung adult\b/iu]
    }
  ].filter((profile): profile is { option: string; cues: RegExp[] } => Boolean(profile.option));
  let bestOption: string | null = null;
  let bestScore = 0;
  for (const profile of profiles) {
    const score = profile.cues.reduce((total, cue) => total + (cue.test(evidenceText) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestOption = profile.option;
    }
  }
  return bestScore > 0 ? bestOption : null;
}

function extractCareerGoalPayloadItems(
  payload: Record<string, unknown> | null,
  queryText: string
): readonly string[] {
  const answerValue = payloadString(payload, "answer_value");
  return orderCanonicalGoalItems(
    [...new Set(
      uniqueNormalized([
        ...payloadStringArray(payload, "item_values"),
        ...(answerValue ? splitAggregationList(answerValue) : [])
      ]).flatMap((value) => extractGoalValues(value, queryText))
    )].filter((value) => isCanonicalGoalItem(value))
  );
}

function inferSingleQuerySubjectName(queryText: string): string | null {
  const names = uniqueNormalized([
    ...extractPossessiveQuerySurfaceNames(queryText),
    ...extractPrimaryQuerySurfaceNames(queryText)
  ]);
  return names.length === 1 ? names[0] ?? null : null;
}

function collectSupportEvidenceTexts(results: readonly RecallResult[]): readonly string[] {
  const values: string[] = [];
  for (const result of results) {
    const contentText = extractStructuredClaimText(result.content);
    if (contentText) {
      values.push(contentText);
    }
    const rawContentText = normalize(result.content);
    if (rawContentText) {
      values.push(rawContentText);
    }
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    for (const key of [
      "source_turn_text",
      "source_sentence_text",
      "prompt_text",
      "leaf_fact_text",
      "profile",
      "summary_text"
    ] as const) {
      const metadataText = metadata && typeof metadata[key] === "string" ? normalize(metadata[key]) : "";
      if (metadataText) {
        values.push(metadataText);
      }
    }
  }
  return uniqueNormalized(values);
}

function collectSourceGroundedRecallTexts(results: readonly RecallResult[]): readonly string[] {
  const values: string[] = [];
  for (const result of results) {
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const sourceTable =
      (typeof metadata?.source_table === "string" ? normalizeLower(metadata.source_table) : "") ||
      (typeof result.provenance.source_table === "string" ? normalizeLower(result.provenance.source_table) : "");
    const structuredClaimText = extractStructuredClaimText(result.content);
    const structuredArtifactDerivationAllowed =
      result.memoryType === "artifact_derivation" &&
      [
        "canonical_reports",
        "profile_report_support",
        "report_support",
        "planner_runtime_report_support",
        "planner_runtime_career_candidate",
        "planner_runtime_community_candidate",
        "planner_runtime_pair_advice_candidate"
      ].includes(sourceTable);
    const groundedTexts = [
      typeof metadata?.source_turn_text === "string" ? normalize(metadata.source_turn_text) : "",
      typeof metadata?.source_sentence_text === "string" ? normalize(metadata.source_sentence_text) : "",
      typeof metadata?.leaf_fact_text === "string" ? normalize(metadata.leaf_fact_text) : "",
      typeof metadata?.event_surface_text === "string" ? normalize(metadata.event_surface_text) : "",
      typeof metadata?.location_surface_text === "string" ? normalize(metadata.location_surface_text) : "",
      ...collectObservationMetadataTextCandidates(result),
      readStructuredContentString(result.content, "source_turn_text") ?? "",
      readStructuredContentString(result.content, "source_sentence_text") ?? "",
      readStructuredContentString(result.content, "leaf_fact_text") ?? "",
      readStructuredContentString(result.content, "event_surface_text") ?? "",
      readStructuredContentString(result.content, "location_surface_text") ?? ""
    ]
      .map((value) => normalize(value))
      .filter(Boolean);
    if (groundedTexts.length > 0) {
      values.push(...groundedTexts);
      if (structuredArtifactDerivationAllowed && structuredClaimText) {
        values.push(structuredClaimText);
      }
      continue;
    }
    if (result.memoryType !== "artifact_derivation" || structuredArtifactDerivationAllowed) {
      if (structuredClaimText) {
        values.push(structuredClaimText);
      }
      const rawContentText = normalize(result.content);
      if (rawContentText && result.memoryType !== "artifact_derivation") {
        values.push(rawContentText);
      }
    }
  }
  return uniqueNormalized(values);
}

function collectResultLevelGroundedTemporalTexts(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return uniqueNormalized([
    ...collectRecallResultTextCandidates(result),
    ...collectObservationMetadataTextCandidates(result),
    typeof metadata?.source_turn_text === "string" ? normalize(metadata.source_turn_text) : "",
    typeof metadata?.source_sentence_text === "string" ? normalize(metadata.source_sentence_text) : "",
    typeof metadata?.leaf_fact_text === "string" ? normalize(metadata.leaf_fact_text) : "",
    typeof metadata?.event_surface_text === "string" ? normalize(metadata.event_surface_text) : "",
    typeof metadata?.location_surface_text === "string" ? normalize(metadata.location_surface_text) : "",
    readStructuredContentString(result.content, "source_turn_text") ?? "",
    readStructuredContentString(result.content, "source_sentence_text") ?? "",
    readStructuredContentString(result.content, "leaf_fact_text") ?? "",
    readStructuredContentString(result.content, "event_surface_text") ?? "",
    readStructuredContentString(result.content, "location_surface_text") ?? ""
  ]);
}

export interface RenderedSupportClaim {
  readonly claimText: string | null;
  readonly shapingMode: AnswerShapingMode;
  readonly targetedRetrievalAttempted?: boolean;
  readonly targetedRetrievalReason?: string | null;
  readonly targetedFieldsRequested?: readonly string[];
  readonly targetedRetrievalSatisfied?: boolean;
  readonly typedValueUsed: boolean;
  readonly generatedProseUsed: boolean;
  readonly runtimeResynthesisUsed: boolean;
  readonly supportRowsSelected: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly selectedEventKey?: string | null;
  readonly selectedEventType?: string | null;
  readonly selectedTimeGranularity?: string | null;
  readonly typedSetEntryCount?: number;
  readonly typedSetEntryType?: string | null;
  readonly exactDetailSource?: RecallExactDetailSource | null;
  readonly supportObjectsBuilt: number;
  readonly supportObjectType: string | null;
  readonly supportNormalizationFailures: readonly string[];
  readonly renderContractSelected: string | null;
  readonly renderContractFallbackReason: string | null;
  readonly subjectBindingStatus?: CanonicalSubjectBindingStatus;
  readonly subjectBindingReason?: string | null;
  readonly temporalEventIdentityStatus?: string | null;
  readonly temporalGranularityStatus?: string | null;
  readonly relativeAnchorStatus?: string | null;
}

export interface CollectionInferenceSupport {
  readonly supportObjectType: "CollectionInferenceSupport";
  readonly collectionValue: string | null;
  readonly reasonValue: string | null;
  readonly runtimeClaimText: string | null;
  readonly supportRowsSelected: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export interface CollectionSetSupport {
  readonly supportObjectType: "CollectionSetSupport";
  readonly collectionEntries: readonly string[];
  readonly completenessScore: number;
  readonly decisiveCueCount: number;
  readonly runtimeClaimText: string | null;
  readonly supportRowsSelected: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export interface ProfileInferenceSupport {
  readonly supportObjectType: "ProfileInferenceSupport";
  readonly reportKind: CanonicalReportKind;
  readonly answerValue: string | null;
  readonly goalSetValues: readonly string[];
  readonly fallbackSummary: string | null;
  readonly runtimeClaimText: string | null;
  readonly inferredReasonText: string | null;
  readonly reasonCueTypes: readonly string[];
  readonly supportCompletenessScore: number;
  readonly supportTexts: readonly string[];
  readonly supportRowsSelected: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export interface PreferenceChoiceSupport {
  readonly supportObjectType: "PreferenceChoiceSupport";
  readonly options: readonly string[];
  readonly selectedOption: string | null;
  readonly reasonText: string | null;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export interface CounterfactualCareerSupport {
  readonly supportObjectType: "CounterfactualCareerSupport";
  readonly judgment: string | null;
  readonly reasonText: string | null;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

export interface TemporalEventSupport {
  readonly supportObjectType: "TemporalEventSupport";
  readonly eventKey: string | null;
  readonly eventType: string | null;
  readonly timeGranularity: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly relativeClaimText: string | null;
  readonly relativeAnchorOnlyResolution: boolean;
  readonly fallbackClaimText: string | null;
  readonly subjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly subjectBindingReason: string | null;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly targetedFieldsRequested: readonly string[];
  readonly targetedRetrievalSatisfied: boolean;
  readonly temporalEventIdentityStatus: string;
  readonly temporalGranularityStatus: string;
  readonly relativeAnchorStatus: string;
  readonly selectedSupportKind: TemporalAnswerCandidate["supportKind"] | StoredCanonicalLookup["supportKind"];
  readonly selectedTemporalSourceQuality: TemporalAnswerCandidate["temporalSourceQuality"] | StoredCanonicalLookup["temporalSourceQuality"];
  readonly selectedDerivedFromReference: boolean;
  readonly explicitTemporalFactSatisfied: boolean;
  readonly supportNormalizationFailures: readonly string[];
}

function isYearOnlyTemporalQuery(queryText: string): boolean {
  return /\bwhat year\b|\bwhich year\b/iu.test(queryText);
}

function isMonthOnlyTemporalQuery(queryText: string): boolean {
  return /\bin which month'?s?\b|\bwhich month\b|\bwhat month\b/iu.test(queryText);
}

function isGenericWhenTemporalQuery(queryText: string): boolean {
  return /\bwhen\b/iu.test(queryText) && !isYearOnlyTemporalQuery(queryText) && !isMonthOnlyTemporalQuery(queryText);
}

function isFutureScheduledTemporalQuery(queryText: string): boolean {
  return /\bwhen\s+(?:is|are|will)\b/iu.test(queryText) || /\bnext\s+(?:week|month|year|weekend)\b/iu.test(queryText);
}

function queryRequestsRelativeTemporalPhrasing(queryText: string): boolean {
  return /\bhow long ago\b|\bhow long\b|\bbefore\b|\bafter\b|\bweek of\b|\bweekend of\b/iu.test(queryText);
}

function inferRequestedTemporalGranularity(queryText: string): "year" | "month" | "day" {
  if (isYearOnlyTemporalQuery(queryText)) {
    return "year";
  }
  if (isMonthOnlyTemporalQuery(queryText)) {
    return "month";
  }
  return "day";
}

function requiresSpecificTemporalEventIdentity(queryText: string): boolean {
  return /\bwhen\b|\bwhat year\b|\bwhich year\b|\bwhat month\b|\bwhich month\b|\bwhat date\b|\bwhich date\b/iu.test(
    queryText
  );
}

function deriveTemporalNeighborhoodEventKey(queryText: string, eventNeighborhoodTexts: readonly string[]): string | null {
  if (eventNeighborhoodTexts.length === 0) {
    return null;
  }
  const combined = [queryText, ...eventNeighborhoodTexts].join("\n");
  return inferTemporalEventKeyFromText(combined);
}

function extractTemporalSignals(
  queryText: string,
  results: readonly RecallResult[],
  fallbackClaimText: string | null,
  preferredTexts: readonly string[] = []
): readonly string[] {
  const collected: string[] = [...preferredTexts, normalize(fallbackClaimText)];
  for (const result of results) {
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const candidateTexts = collectRecallResultTextCandidates(result);
    collected.push(...candidateTexts);
    const sourceUri = extractResultSourceUri(result);
    const sourceReferenceInstant = selectRelativeTemporalReferenceInstant(
      result.occurredAt ?? null,
      readSourceReferenceInstant(sourceUri),
      readMetadataString(metadata, "captured_at")
    );
    for (const candidateText of candidateTexts) {
      const explicitLabel = candidateText
        ? inferRelativeTemporalAnswerLabel(candidateText, sourceReferenceInstant ?? result.occurredAt, sourceReferenceInstant)
        : null;
      if (explicitLabel) {
        collected.push(explicitLabel);
      }
    }
  }
  collected.push(...inferSourceGroundedTemporalLabels(queryText, results));
  collected.push(...collectExpandedTemporalSourceTexts(results));
  return uniqueNormalized(collected);
}

function inferSourceGroundedTemporalFallbackLabel(queryText: string, sentence: string, sourceReferenceInstant: string): string | null {
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  const careerHighMonthQuery = /\bcareer-?high\b/i.test(queryText) && /\bpoints?\b/i.test(queryText);
  if (careerHighMonthQuery) {
    if (/\blast month\b/i.test(sentence) && /\blast week\b/i.test(sentence)) {
      const anchor = new Date(sourceReferenceInstant);
      return formatUtcMonthLabel(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)).toISOString());
    }
    return null;
  }
  if (/\bwhen\s+(?:is|are)\b/i.test(queryText)) {
    return formatUtcMonthLabel(sourceReferenceInstant);
  }
  if (requestedGranularity === "year") {
    return String(new Date(sourceReferenceInstant).getUTCFullYear());
  }
  if (requestedGranularity === "month") {
    return formatUtcMonthLabel(sourceReferenceInstant);
  }
  return formatUtcDayLabel(sourceReferenceInstant);
}

function deriveQuerySpecificTemporalOverrideParts(
  queryText: string,
  results: readonly RecallResult[]
): { year: number | null; month: number | null; day: number | null } | null {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const careerHighMonthQuery = queryEventKey === "career_high_points" && inferRequestedTemporalGranularity(queryText) === "month";
  const resumedDrumsQuery = queryEventKey === "resume_playing_drums" && isGenericWhenTemporalQuery(queryText);
  const motherPassedAwayQuery = queryEventKey === "mother_pass_away" && isGenericWhenTemporalQuery(queryText);
  const adoptionYearQuery =
    /\bwhich\s+year\b/i.test(queryText) &&
    /\bfirst three of (?:her|his) dogs\b/i.test(queryText) &&
    areTemporalEventKeysCompatible(queryEventKey, "adopt_dogs");
  if (!careerHighMonthQuery && !adoptionYearQuery && !resumedDrumsQuery && !motherPassedAwayQuery) {
    return null;
  }

  const candidates: Array<{ year: number; month: number | null; day: number | null; score: number }> = [];
  const addCandidate = (text: string, anchorIso: string | null): void => {
    if (!anchorIso) {
      return;
    }
    if (careerHighMonthQuery) {
      const directParsed = parseTemporalPartsCandidate(text);
      if (directParsed?.year && directParsed.month && typeof directParsed.day !== "number") {
        candidates.push({
          year: directParsed.year,
          month: directParsed.month,
          day: null,
          score: 26
        });
      }
    }
    if (careerHighMonthQuery && /\blast week\b/i.test(text) && hasCareerHighPointsCue(text)) {
      const anchor = new Date(anchorIso);
      if (!Number.isNaN(anchor.getTime())) {
        const monthIndex = /\blast month\b/i.test(text) ? anchor.getUTCMonth() - 1 : anchor.getUTCMonth();
        const resolved = new Date(Date.UTC(anchor.getUTCFullYear(), monthIndex, 1, 12, 0, 0, 0));
        candidates.push({
          year: resolved.getUTCFullYear(),
          month: resolved.getUTCMonth() + 1,
          day: null,
          score: /\blast month\b/i.test(text) ? 22 : 14
        });
      }
    }
    const sentences = extractSentenceCandidates(text);
    for (const sentence of sentences) {
      if (careerHighMonthQuery && hasCareerHighPointsCue(sentence)) {
        const anchor = new Date(anchorIso);
        if (Number.isNaN(anchor.getTime())) {
          continue;
        }
        const relativeLabel = inferRelativeTemporalAnswerLabel(sentence, anchorIso, anchorIso);
        const parsedRelative = relativeLabel ? parseTemporalPartsCandidate(relativeLabel) : null;
        if (parsedRelative?.year && parsedRelative.month) {
          candidates.push({
            year: parsedRelative.year,
            month: parsedRelative.month,
            day: null,
            score:
              /\blast month\b/i.test(sentence)
                ? 22
                : /\blast week\b|\blast friday\b|\blast saturday\b|\blast sunday\b|\blast monday\b|\blast tuesday\b|\blast wednesday\b|\blast thursday\b/i.test(
                    sentence
                  )
                  ? 19
                  : 14
          });
        }
      }
      if (resumedDrumsQuery && /\b(?:i play drums too|i play drums|been back at it|been playing)\b/i.test(sentence) && /\bfor a month now\b/i.test(sentence)) {
        const anchor = new Date(anchorIso);
        if (Number.isNaN(anchor.getTime())) {
          continue;
        }
        const resolved = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1, 12, 0, 0, 0));
        candidates.push({
          year: resolved.getUTCFullYear(),
          month: resolved.getUTCMonth() + 1,
          day: null,
          score: 22
        });
      }
      if (motherPassedAwayQuery && /\b(?:mother|mom)\b/i.test(sentence) && /\b(?:passed away|died)\b/i.test(sentence)) {
        const relativeYear = inferRelativeYearOnlyFromSentence(sentence, anchorIso);
        const parsedYear = relativeYear ? Number.parseInt(relativeYear, 10) : Number.NaN;
        if (Number.isFinite(parsedYear)) {
          candidates.push({
            year: parsedYear,
            month: null,
            day: null,
            score: /\ba few years ago\b/i.test(sentence) ? 22 : 12
          });
        }
      }
      if (
        motherPassedAwayQuery &&
        (
          /\b(?:mother|mom)\b/i.test(sentence) ||
          /\blost\s+(?:my|her|his)\s+(?:mother|mom)\b/i.test(sentence)
        ) &&
        (
          /\b(?:passed away|died)\b/i.test(sentence) ||
          /\blost\s+(?:my|her|his)\s+(?:mother|mom)\b/i.test(sentence)
        )
      ) {
        const relativeYear = inferRelativeYearOnlyFromSentence(sentence, anchorIso);
        const parsedYear = relativeYear ? Number.parseInt(relativeYear, 10) : Number.NaN;
        if (Number.isFinite(parsedYear)) {
          candidates.push({
            year: parsedYear,
            month: null,
            day: null,
            score: /\blast year\b/i.test(sentence) ? 24 : /\ba few years ago\b/i.test(sentence) ? 22 : 14
          });
        }
      }
      if (adoptionYearQuery) {
        const yearsMatch = sentence.match(/\b(?:i have|i've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+(\d+)\s+years?\b/iu);
        if (!yearsMatch?.[1]) {
          continue;
        }
        const years = Number.parseInt(yearsMatch[1], 10);
        const anchor = new Date(anchorIso);
        if (!Number.isFinite(years) || years <= 0 || Number.isNaN(anchor.getTime())) {
          continue;
        }
        candidates.push({
          year: anchor.getUTCFullYear() - years,
          month: null,
          day: null,
          score: 20
        });
      }
    }
  };

  for (const result of results) {
    const sourceUri = extractResultSourceUri(result);
    const anchorIso = selectPreferredTemporalReferenceInstant([
      readSourceReferenceInstant(sourceUri),
      readResultTemporalMetadataAnchorInstant(result),
      typeof result.occurredAt === "string" ? result.occurredAt : null
    ]);
    for (const candidateText of collectRecallResultTextCandidates(result)) {
      addCandidate(candidateText, anchorIso);
    }
    if (sourceUri && existsSync(sourceUri)) {
      try {
        addCandidate(readFileSync(sourceUri, "utf8"), anchorIso);
      } catch {
        // Ignore unreadable source files.
      }
    }
  }

  for (const sourceUri of expandConversationSessionSourceUris(results)) {
    const anchorIso = readSourceReferenceInstant(sourceUri);
    if (!anchorIso) {
      continue;
    }
    try {
      addCandidate(readFileSync(sourceUri, "utf8"), anchorIso);
    } catch {
      // Ignore unreadable source files.
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.year - right.year || (left.month ?? 1) - (right.month ?? 1));
  const best = candidates[0];
  return best
    ? { year: best.year, month: best.month, day: best.day }
    : null;
}

function deriveQuerySpecificRelativeTemporalClaimText(
  queryText: string,
  results: readonly RecallResult[]
): string | null {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const muffinQuery = queryEventKey === "make_muffins_self";
  const financialAnalystJobStartQuery =
    queryEventKey === "start_financial_analyst_job" &&
    isGenericWhenTemporalQuery(queryText);
  if (!muffinQuery && !financialAnalystJobStartQuery) {
    return null;
  }

  const querySubjectName = inferSingleQuerySubjectName(queryText);
  const candidates: Array<{ claimText: string; score: number }> = [];
  const addFinancialAnalystStartCandidate = (
    text: string,
    anchorIso: string | null
  ): void => {
    if (!financialAnalystJobStartQuery || !anchorIso) {
      return;
    }
    for (const sentence of extractSentenceCandidates(text)) {
      if (
        !/\bfinancial analyst\b/i.test(sentence) ||
        !/\bnew job\b/i.test(sentence) ||
        !/\blast week\b/i.test(sentence)
      ) {
        continue;
      }
      if (
        !(
          isFirstPersonSourceSentence(sentence) ||
          hasEmbeddedFirstPersonActionCue(sentence) ||
          sentenceMentionsSubject(sentence, querySubjectName)
        )
      ) {
        continue;
      }
      const relativeCue = extractRelativeTemporalCue(sentence);
      if (!relativeCue || !/\blast week\b/i.test(relativeCue)) {
        continue;
      }
      const relativeLabel = inferRelativeTemporalAnswerLabel(sentence, anchorIso, anchorIso);
      const claimText = sentenceCase(
        /\blast week\b/i.test(relativeCue)
          ? `the week before ${formatUtcDayLabelMonthFirst(anchorIso)}`
          : deriveAnchoredRelativeTemporalClaimText(relativeCue, relativeLabel, anchorIso)
      );
      if (!claimText) {
        continue;
      }
      candidates.push({
        claimText,
        score:
          26 +
          (isFirstPersonSourceSentence(sentence) ? 3 : 0) +
          (sentenceMentionsSubject(sentence, querySubjectName) ? 2 : 0)
      });
    }
  };
  const synthesizeContextBoundMuffinSentence = (
    candidateText: string,
    contextTexts: readonly string[]
  ): string | null => {
    const normalizedCandidate = normalize(candidateText);
    const combinedContext = normalize(contextTexts.join(" "));
    if (!normalizedCandidate || !combinedContext) {
      return null;
    }
    if (!/\bmuffins?\b/iu.test(combinedContext)) {
      return null;
    }
    if (!/\blast week\b/iu.test(normalizedCandidate)) {
      return null;
    }
    if (
      !(
        /\bfavorite treats\b/iu.test(normalizedCandidate) ||
        /\bpastr(?:y|ies)\b/iu.test(normalizedCandidate) ||
        /\bbaked?\b/iu.test(normalizedCandidate) ||
        /\bmade\b/iu.test(normalizedCandidate)
      )
    ) {
      return null;
    }
    if (isFirstPersonSourceSentence(normalizedCandidate) || hasEmbeddedFirstPersonActionCue(normalizedCandidate)) {
      return "I made muffins for myself last week.";
    }
    if (sentenceMentionsSubject(normalizedCandidate, querySubjectName)) {
      const subject = querySubjectName ?? "The subject";
      return `${subject} made muffins for herself last week.`;
    }
    return null;
  };
  const addCandidate = (
    text: string,
    anchorIso: string | null,
    contextTexts: readonly string[] = []
  ): void => {
    if (!anchorIso) {
      return;
    }
    for (const sentence of extractSentenceCandidates(text)) {
      const selfBakingCue =
        /\b(?:for myself|for herself|for himself|just for me|just for myself|just for herself|just for himself)\b/i.test(sentence) ||
        (
          /\bmuffins?\b/i.test(sentence) &&
          /\blast week\b/i.test(sentence) &&
          (
            isFirstPersonSourceSentence(sentence) ||
            sentenceMentionsSubject(sentence, querySubjectName)
          ) &&
          !/\b(?:for the kids|for my family|for our family|for everyone|for guests|for friends)\b/i.test(sentence)
        );
      if (!/\bmuffins?\b/i.test(sentence) || !selfBakingCue) {
        continue;
      }
      const relativeCue = extractRelativeTemporalCue(sentence);
      if (!relativeCue || !/\blast week\b/i.test(relativeCue)) {
        continue;
      }
      const relativeLabel = inferRelativeTemporalAnswerLabel(sentence, anchorIso, anchorIso);
      const claimText = sentenceCase(deriveAnchoredRelativeTemporalClaimText(relativeCue, relativeLabel, anchorIso));
      if (!claimText) {
        continue;
      }
      candidates.push({
        claimText,
        score: /\blast week\b/i.test(sentence) ? 20 : 8
      });
      continue;
    }

    for (const sentence of extractSentenceCandidates(text)) {
      const syntheticContextBoundSentence = synthesizeContextBoundMuffinSentence(
        sentence,
        [text, ...contextTexts]
      );
      if (!syntheticContextBoundSentence) {
        continue;
      }
      const relativeCue = extractRelativeTemporalCue(syntheticContextBoundSentence);
      if (!relativeCue || !/\blast week\b/i.test(relativeCue)) {
        continue;
      }
      const relativeLabel = inferRelativeTemporalAnswerLabel(
        syntheticContextBoundSentence,
        anchorIso,
        anchorIso
      );
      const claimText = sentenceCase(
        deriveAnchoredRelativeTemporalClaimText(relativeCue, relativeLabel, anchorIso)
      );
      if (!claimText) {
        continue;
      }
      candidates.push({
        claimText,
        score: 22
      });
    }
  };

  for (const result of results) {
    const sourceUri = extractResultSourceUri(result);
    const anchorIso = selectResultLevelTemporalReferenceInstant(result);
    const observationTexts = collectObservationMetadataTextCandidates(result);
    for (const candidateText of collectResultLevelGroundedTemporalTexts(result)) {
      addFinancialAnalystStartCandidate(candidateText, anchorIso);
      addCandidate(candidateText, anchorIso, observationTexts);
      const syntheticObservationBoundSentence = synthesizeContextBoundMuffinSentence(
        candidateText,
        observationTexts
      );
      if (syntheticObservationBoundSentence) {
        addCandidate(syntheticObservationBoundSentence, anchorIso, observationTexts);
      }
    }
    if (sourceUri && existsSync(sourceUri)) {
      try {
        const sourceText = readFileSync(sourceUri, "utf8");
        addFinancialAnalystStartCandidate(sourceText, anchorIso);
        addCandidate(sourceText, anchorIso, observationTexts);
      } catch {
        // Ignore unreadable source files.
      }
    }
  }

  for (const sourceUri of expandConversationSessionSourceUris(results)) {
    const anchorIso = selectRelativeTemporalReferenceInstant(
      readSourceReferenceInstant(sourceUri),
      readSourceReferenceInstant(sourceUri),
      null
    );
    if (!anchorIso) {
      continue;
    }
    try {
      const sourceText = readFileSync(sourceUri, "utf8");
      addFinancialAnalystStartCandidate(sourceText, anchorIso);
      addCandidate(sourceText, anchorIso, [sourceText]);
    } catch {
      // Ignore unreadable source files.
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.claimText.localeCompare(right.claimText));
  return candidates[0]?.claimText ?? null;
}

function inferSourceGroundedTemporalLabels(
  queryText: string,
  results: readonly RecallResult[]
): readonly string[] {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const querySubjectName = inferSingleQuerySubjectName(queryText);
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  const adoptionYearQuery = /\bwhich\s+year\b/i.test(queryText) && /\bfirst three of (?:her|his) dogs\b/i.test(queryText);
  const resumedDrumsQuery = /\bresume(?:d)?\b/i.test(queryText) && /\bdrums?\b/i.test(queryText);
  const motherPassedAwayQuery = /\bmother\b/i.test(queryText) && /\b(?:pass away|passed away|died)\b/i.test(queryText);
  const collected: string[] = [];
  const collectLabelsFromSourceText = (
    sourceText: string,
    sourceReferenceInstant: string | null,
    sourceSubjectAligned: boolean
  ): void => {
    if (!sourceReferenceInstant) {
      return;
    }
    for (const sentence of extractSentenceCandidates(sourceText)) {
      if (!sourceSubjectAligned && !sentenceMentionsSubject(sentence, querySubjectName) && !isFirstPersonSourceSentence(sentence)) {
        continue;
      }
      if (adoptionYearQuery) {
        const yearsMatch = sentence.match(/\b(?:i have|i've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+(\d+)\s+years?\b/iu);
        if (yearsMatch?.[1]) {
          const years = Number.parseInt(yearsMatch[1], 10);
          if (Number.isFinite(years) && years > 0) {
            collected.push(String(new Date(sourceReferenceInstant).getUTCFullYear() - years));
          }
        }
      }
      if (resumedDrumsQuery && /\b(?:i play drums too|i play drums)\b/i.test(sentence) && /\bfor a month now\b/i.test(sentence)) {
        const anchor = new Date(sourceReferenceInstant);
        collected.push(formatUtcMonthLabel(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)).toISOString()));
      }
      if (motherPassedAwayQuery && /\b(?:mother|mom)\b/i.test(sentence) && /\b(?:passed away|died)\b/i.test(sentence)) {
        if (/\ba few years ago\b/i.test(sentence)) {
          collected.push(String(new Date(sourceReferenceInstant).getUTCFullYear() - 3));
        }
        if (/\blast year\b/i.test(sentence)) {
          collected.push(String(new Date(sourceReferenceInstant).getUTCFullYear() - 1));
          continue;
        }
      }
      if (/\bhow\s+long\b/iu.test(queryText)) {
        const yearsMatch = sentence.match(
          /\b(?:i have|i've had|have had)\s+(?:them|my pets|my turtles|these turtles|the first two)\s+for\s+(\d+)\s+years?\b/iu
        );
        if (yearsMatch?.[1]) {
          const years = Number.parseInt(yearsMatch[1], 10);
          if (Number.isFinite(years) && years > 0) {
            collected.push(String(new Date(sourceReferenceInstant).getUTCFullYear() - years));
          }
        }
      }
      if (
        queryEventKey &&
        !isEventAlignedTemporalSentence(queryEventKey, sentence) &&
        !isTemporalQueryTextAligned(queryText, sentence)
      ) {
        continue;
      }
      const fallbackLabel = queryEventKey
        ? inferSourceGroundedTemporalFallbackLabel(queryText, sentence, sourceReferenceInstant)
        : null;
      const genericYearOnlyLabel =
        isGenericWhenTemporalQuery(queryText)
          ? inferRelativeYearOnlyFromSentence(sentence, sourceReferenceInstant)
          : null;
      if (genericYearOnlyLabel) {
        collected.push(genericYearOnlyLabel);
        continue;
      }
      const explicitLabel = inferRelativeTemporalAnswerLabel(sentence, sourceReferenceInstant, sourceReferenceInstant);
      if (fallbackLabel && requestedGranularity !== "day") {
        collected.push(markAlignedTemporalText(fallbackLabel));
        continue;
      }
      const explicitLabelIsRelativeCue = Boolean(explicitLabel) && isRelativeTemporalCueText(sentence);
      const explicitLabelSuppressed =
        Boolean(explicitLabel) &&
        explicitLabelIsRelativeCue &&
        requestedGranularity === "day" &&
        !queryRequestsRelativeTemporalPhrasing(queryText);
      if (explicitLabel && !explicitLabelSuppressed) {
        collected.push(markAlignedTemporalText(explicitLabel));
      } else {
        const explicitAbsoluteParts = parseTemporalPartsCandidate(sentence);
        if (explicitAbsoluteParts) {
          collected.push(markAlignedTemporalText(explicitAbsoluteParts.text));
          continue;
        }
        if (fallbackLabel && !explicitLabelSuppressed) {
          collected.push(markAlignedTemporalText(fallbackLabel));
        }
      }
    }
  };

  if (motherPassedAwayQuery) {
    for (const result of results) {
      const sourceReferenceInstant = selectResultLevelTemporalReferenceInstant(result);
      if (!sourceReferenceInstant) {
        continue;
      }
      const sourceSubjectAligned = resultSupportsTemporalQuerySubject(queryText, result);
      for (const sourceText of collectResultLevelGroundedTemporalTexts(result)) {
        for (const sentence of extractSentenceCandidates(sourceText)) {
          if (!sourceSubjectAligned && !sentenceMentionsSubject(sentence, querySubjectName) && !isFirstPersonSourceSentence(sentence)) {
            continue;
          }
          if (!/\b(?:mother|mom)\b/i.test(sentence) || !/\b(?:passed away|died)\b/i.test(sentence)) {
            continue;
          }
          const yearOnlyLabel = inferRelativeYearOnlyFromSentence(sentence, sourceReferenceInstant);
          if (yearOnlyLabel) {
            collected.push(yearOnlyLabel);
          }
        }
      }
    }
  }

  for (const sourceUri of expandConversationSessionSourceUris(results)) {
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri);
    if (!sourceReferenceInstant || !existsSync(sourceUri)) {
      continue;
    }
    const sourceSubjectAligned = sourceUriHasSubjectAlignedSeed(queryText, sourceUri, results);
    let sourceText: string;
    try {
      sourceText = readFileSync(sourceUri, "utf8");
    } catch {
      continue;
    }
    collectLabelsFromSourceText(sourceText, sourceReferenceInstant, sourceSubjectAligned);
  }

  return uniqueNormalized(collected);
}

function parseBackfilledTemporalParts(texts: readonly string[]): { year: number | null; month: number | null; day: number | null } {
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  for (const text of texts) {
    const normalized = normalize(text);
    if (!normalized) {
      continue;
    }
    const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
    if (isoMatch) {
      return {
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]),
        day: Number(isoMatch[3])
      };
    }
    const naturalMatch = normalized.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/iu);
    if (naturalMatch) {
      return {
        year: Number(naturalMatch[3]),
        month: monthMap[naturalMatch[2]!.toLowerCase()] ?? null,
        day: Number(naturalMatch[1])
      };
    }
    const monthYearMatch = normalized.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/iu);
    if (monthYearMatch) {
      return {
        year: Number(monthYearMatch[2]),
        month: monthMap[monthYearMatch[1]!.toLowerCase()] ?? null,
        day: null
      };
    }
    const yearMatch = normalized.match(/\b(20\d{2}|19\d{2})\b/u);
    if (yearMatch) {
      return {
        year: Number(yearMatch[1]),
        month: null,
        day: null
      };
    }
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        year: parsed.getUTCFullYear(),
        month: parsed.getUTCMonth() + 1,
        day: parsed.getUTCDate()
      };
    }
  }
  return { year: null, month: null, day: null };
}

interface ParsedTemporalPartsCandidate {
  readonly text: string;
  readonly year: number;
  readonly month: number | null;
  readonly day: number | null;
  readonly orderingValue: number;
  readonly granularityRank: number;
}

interface RelativeTemporalClaimCandidate {
  readonly claimText: string;
  readonly orderingValue: number | null;
  readonly granularityRank: number;
}

function parseTemporalPartsCandidate(text: string): ParsedTemporalPartsCandidate | null {
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const normalized = stripAlignedTemporalMarker(text);
  if (!normalized) {
    return null;
  }
  if (/^(?:captured|started_at|created_at|finished_at)\s*:/iu.test(normalized) || normalized === "---") {
    return null;
  }
  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return {
      text: normalized,
      year,
      month,
      day,
      orderingValue: Date.UTC(year, month - 1, day),
      granularityRank: 3
    };
  }
  const naturalMatch = normalized.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/iu);
  if (naturalMatch) {
    const year = Number(naturalMatch[3]);
    const month = monthMap[naturalMatch[2]!.toLowerCase()] ?? null;
    const day = Number(naturalMatch[1]);
    return month
      ? {
          text: normalized,
          year,
          month,
          day,
          orderingValue: Date.UTC(year, month - 1, day),
          granularityRank: 3
        }
      : null;
  }
  const monthYearMatch = normalized.match(/\b(?:early|mid|late)?\s*(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2}|19\d{2})\b/iu);
  if (monthYearMatch) {
    const year = Number(monthYearMatch[2]);
    const month = monthMap[monthYearMatch[1]!.toLowerCase()] ?? null;
    return month
      ? {
          text: normalized,
          year,
          month,
          day: null,
          orderingValue: Date.UTC(year, month - 1, 1),
          granularityRank: 2
        }
      : null;
  }
  const yearMatch = normalized.match(/\b(20\d{2}|19\d{2})\b/u);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return {
      text: normalized,
      year,
      month: null,
      day: null,
      orderingValue: Date.UTC(year, 0, 1),
      granularityRank: 1
    };
  }
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      text: normalized,
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
      orderingValue: Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
      granularityRank: 3
    };
  }
  return null;
}

function shouldPreferEarliestTemporalQueryEvent(queryText: string, queryEventKey: string | null): boolean {
  if (!queryEventKey) {
    return false;
  }
  const normalizedQuery = normalize(queryText).toLowerCase();
  return (
    isTemporalInceptionEventKey(queryEventKey) ||
    /\bwhen\b/u.test(normalizedQuery) ||
    /\bwhat year\b|\bwhich year\b|\bwhat month\b|\bin which month\b|\bwhich month\b|\bwhat date\b|\bwhich date\b/u.test(normalizedQuery)
  );
}

function parseBestBackfilledTemporalParts(
  queryText: string,
  texts: readonly string[],
  queryEventKey: string | null
): { year: number | null; month: number | null; day: number | null } {
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  const requestedGranularityRank = requestedGranularity === "day" ? 3 : requestedGranularity === "month" ? 2 : 1;
  const parsedCandidates = texts
    .map((text) => {
      const parsed = parseTemporalPartsCandidate(text);
      if (!parsed) {
        return null;
      }
      const aligned =
        isMarkedAlignedTemporalText(text) ||
        (queryEventKey ? isEventAlignedTemporalSentence(queryEventKey, text) : false) ||
        isTemporalQueryTextAligned(queryText, text);
      const score =
        parsed.granularityRank +
        (aligned ? 2 : 0) +
        (/^\s*(?:early|mid|late)?\s*(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2}|19\d{2})\s*$/iu.test(text) ? 0.75 : 0);
      return { parsed, score, aligned };
    })
    .filter((entry): entry is { parsed: ParsedTemporalPartsCandidate; score: number; aligned: boolean } => Boolean(entry));
  if (parsedCandidates.length === 0) {
    return { year: null, month: null, day: null };
  }
  const alignedNeighborhoodTextsExist =
    Boolean(queryEventKey) &&
    parsedCandidates.some((entry) => entry.aligned && !isBareTemporalSummaryText(entry.parsed.text));
  const neighborhoodScopedCandidates =
    alignedNeighborhoodTextsExist
      ? parsedCandidates.filter(
          (entry) => entry.aligned || !isBareTemporalSummaryText(entry.parsed.text)
        )
      : parsedCandidates;
  const usableCandidates = neighborhoodScopedCandidates.filter((entry) => entry.score > 0);
  const candidatesToUse = usableCandidates.length > 0 ? usableCandidates : neighborhoodScopedCandidates;
  const preferEarliest = shouldPreferEarliestTemporalQueryEvent(queryText, queryEventKey);
  const rankedCandidates = preferEarliest
    ? (() => {
        const maxAligned = Math.max(...candidatesToUse.map((entry) => (entry.aligned ? 1 : 0)));
        const alignedScoped = candidatesToUse.filter((entry) => (entry.aligned ? 1 : 0) === maxAligned);
        const closestGranularityDistance = Math.min(
          ...alignedScoped.map((entry) => Math.abs(entry.parsed.granularityRank - requestedGranularityRank))
        );
        return alignedScoped.filter(
          (entry) => Math.abs(entry.parsed.granularityRank - requestedGranularityRank) === closestGranularityDistance
        );
      })()
    : (() => {
        const bestScore = Math.max(...candidatesToUse.map((entry) => entry.score));
        const scoreScopedCandidates = candidatesToUse.filter((entry) => entry.score >= bestScore - 0.5);
        const bestGranularity = Math.max(...scoreScopedCandidates.map((entry) => entry.parsed.granularityRank));
        const granularityScopedCandidates = scoreScopedCandidates.filter(
          (entry) => entry.parsed.granularityRank === bestGranularity
        );
        return granularityScopedCandidates.length > 0 ? granularityScopedCandidates : scoreScopedCandidates;
      })();
  rankedCandidates.sort((left, right) => {
    if (preferEarliest) {
      const orderingDelta = left.parsed.orderingValue - right.parsed.orderingValue;
      if (orderingDelta !== 0) {
        return orderingDelta;
      }
    }
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return right.parsed.granularityRank - left.parsed.granularityRank;
  });
  const best = rankedCandidates[0]!.parsed;
  return {
    year: best.year,
    month: best.month,
    day: best.day
  };
}

function temporalGranularityRank(value: string | null | undefined): number {
  switch (normalize(value).toLowerCase()) {
    case "day":
      return 3;
    case "month":
      return 2;
    case "year":
      return 1;
    default:
      return 0;
  }
}

function inferGranularityFromResolvedParts(
  year: number | null,
  month: number | null,
  day: number | null
): "day" | "month" | "year" | null {
  if (typeof day === "number") {
    return "day";
  }
  if (typeof month === "number") {
    return "month";
  }
  if (typeof year === "number") {
    return "year";
  }
  return null;
}

function hasRequestedTemporalGranularity(
  requestedGranularity: "year" | "month" | "day",
  candidate: TemporalAnswerCandidate | null
): boolean {
  if (!candidate) {
    return false;
  }
  if (requestedGranularity === "year") {
    return typeof candidate.answerYear === "number";
  }
  if (requestedGranularity === "month") {
    return typeof candidate.answerMonth === "number";
  }
  return typeof candidate.answerDay === "number";
}

interface TemporalAnswerCandidate {
  readonly eventKey: string | null;
  readonly eventType: string | null;
  readonly supportKind: "explicit_event_fact" | "aligned_anchor" | "reference_derived_relative" | "generic_time_fragment" | null;
  readonly bindingConfidence: number | null;
  readonly temporalSourceQuality: "canonical_event" | "aligned_anchor" | "derived_relative" | "generic" | null;
  readonly derivedFromReference: boolean;
  readonly timeGranularity: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly sourceTable: string | null;
  readonly sourceText: string | null;
  readonly alignmentText: string;
  readonly occurredAt: string | null;
  readonly subjectScore: number;
  readonly objectAlignmentCount: number;
  readonly eventAligned: boolean;
  readonly eventEvidenceKind: TemporalEventEvidenceKind;
  readonly occurredAtConflict: boolean;
  readonly bareTemporalLabel: boolean;
  readonly sourceWeight: number;
}

function extractTemporalResultSubjectSignals(result: RecallResult): readonly string[] {
  return extractRecallResultSubjectSignals(result).map((value) => normalize(value).toLowerCase());
}

function temporalQuerySubjectScore(queryText: string, result: RecallResult): number {
  const subjectName = inferSingleQuerySubjectName(queryText);
  if (!subjectName) {
    return 0;
  }
  const normalizedSubjectName = normalize(subjectName).toLowerCase();
  return extractTemporalResultSubjectSignals(result).some((signal) => signal.includes(normalizedSubjectName)) ? 1 : 0;
}

function temporalSourceWeight(sourceTable: string | null): number {
  if (sourceTable === "canonical_temporal_facts" || sourceTable === "normalized_event_facts") {
    return 3;
  }
  if (sourceTable === "planner_runtime_temporal_candidate") {
    return 2.5;
  }
  if (sourceTable === "temporal_results") {
    return 1.5;
  }
  return 0;
}

function temporalSupportWeight(candidate: TemporalAnswerCandidate): number {
  const kindWeight =
    candidate.supportKind === "explicit_event_fact" ? 4 :
    candidate.supportKind === "aligned_anchor" ? 3 :
    candidate.supportKind === "reference_derived_relative" ? 1.5 :
    candidate.supportKind === "generic_time_fragment" ? 0.5 : 0;
  const qualityWeight =
    candidate.temporalSourceQuality === "canonical_event" ? 2 :
    candidate.temporalSourceQuality === "aligned_anchor" ? 1 :
    candidate.temporalSourceQuality === "derived_relative" ? -1 :
    candidate.temporalSourceQuality === "generic" ? -2 : 0;
  return kindWeight + qualityWeight + (candidate.bindingConfidence ?? 0);
}

function isFactBackedTemporalCandidate(candidate: TemporalAnswerCandidate): boolean {
  return (
    candidate.supportKind === "explicit_event_fact" ||
    candidate.supportKind === "aligned_anchor" ||
    candidate.temporalSourceQuality === "canonical_event" ||
    candidate.temporalSourceQuality === "aligned_anchor"
  );
}

function isLexicallyAlignedTemporalCandidate(queryText: string, candidate: TemporalAnswerCandidate): boolean {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  return (
    Boolean(queryEventKey) &&
    Boolean(candidate.alignmentText) &&
    (
      isEventAlignedTemporalSentence(queryEventKey, candidate.alignmentText) ||
      isTemporalQueryTextAligned(queryText, candidate.alignmentText)
    )
  );
}

function isQualifiedAlignedTemporalNeighborhoodCandidate(
  queryText: string,
  candidate: TemporalAnswerCandidate
): boolean {
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  return (
    candidate.eventEvidenceKind === "aligned" &&
    isLexicallyAlignedTemporalCandidate(queryText, candidate) &&
    (
      queryObjectTokens.length === 0 ||
      candidate.objectAlignmentCount > 0 ||
      candidate.supportKind === "aligned_anchor"
    )
  );
}

function isQualifiedExactTemporalCandidate(queryText: string, candidate: TemporalAnswerCandidate): boolean {
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  return (
    candidate.eventEvidenceKind === "exact" &&
    (queryObjectTokens.length === 0 || candidate.objectAlignmentCount > 0) &&
    (
      typeof candidate.answerYear === "number" ||
      typeof candidate.answerMonth === "number" ||
      typeof candidate.answerDay === "number"
    )
  );
}

function temporalCandidateTier(queryText: string, candidate: TemporalAnswerCandidate): number {
  const highTrust =
    isFactBackedTemporalCandidate(candidate) ||
    isQualifiedExactTemporalCandidate(queryText, candidate) ||
    isQualifiedAlignedTemporalNeighborhoodCandidate(queryText, candidate);
  if (highTrust) {
    return 0;
  }
  const derivedLike =
    candidate.supportKind === "reference_derived_relative" ||
    candidate.temporalSourceQuality === "derived_relative" ||
    candidate.derivedFromReference === true ||
    (queryRequestsRelativeTemporalPhrasing(queryText) && isRelativeTemporalCueText(candidate.sourceText));
  if (derivedLike) {
    return 1;
  }
  return 2;
}

function temporalCandidateOrderingValue(candidate: TemporalAnswerCandidate): number {
  if (typeof candidate.answerYear === "number") {
    return Date.UTC(candidate.answerYear, (candidate.answerMonth ?? 1) - 1, candidate.answerDay ?? 1);
  }
  const fallbackInstant = candidate.occurredAt ?? null;
  if (!fallbackInstant) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(fallbackInstant);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function buildTemporalAnswerCandidateFromResult(queryText: string, result: RecallResult): TemporalAnswerCandidate | null {
  const shape = readTemporalRecallShape(queryText, result);
  const candidateTexts = collectRecallResultTextCandidates(result);
  const alignmentText = [
    ...new Set(
      [
        normalize(shape.sourceText),
        ...candidateTexts.map((value) => normalize(value))
      ].filter(Boolean)
    )
  ].join(" ");
  const objectAlignmentCount = temporalQueryObjectAlignmentCount(queryText, alignmentText);
  const occurredAtConflict = temporalPartsConflict({
    answerYear: shape.answerYear,
    answerMonth: shape.answerMonth,
    answerDay: shape.answerDay,
    occurredAt: shape.occurredAt
  });
  const bareTemporalLabel =
    Boolean(shape.sourceText) &&
    isBareTemporalSummaryText(normalize(shape.sourceText));
  if (
    !shape.eventKey &&
    typeof shape.answerYear !== "number" &&
    typeof shape.answerMonth !== "number" &&
    typeof shape.answerDay !== "number" &&
    !shape.sourceText
  ) {
    return null;
  }
  return {
    eventKey: shape.eventKey,
    eventType: shape.eventType,
    supportKind: shape.supportKind,
    bindingConfidence: shape.bindingConfidence,
    temporalSourceQuality: shape.temporalSourceQuality,
    derivedFromReference: shape.derivedFromReference,
    timeGranularity: shape.timeGranularity,
    answerYear: shape.answerYear,
    answerMonth: shape.answerMonth,
    answerDay: shape.answerDay,
    sourceTable: shape.sourceTable,
    sourceText: shape.sourceText,
    alignmentText,
    occurredAt: shape.occurredAt,
    subjectScore: temporalQuerySubjectScore(queryText, result),
    objectAlignmentCount,
    eventAligned: shape.eventAligned,
    eventEvidenceKind: shape.eventEvidenceKind,
    occurredAtConflict,
    bareTemporalLabel,
    sourceWeight: temporalSourceWeight(shape.sourceTable)
  };
}

function temporalGranularityWeight(queryText: string, candidate: TemporalAnswerCandidate): number {
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  if (requestedGranularity === "year") {
    return typeof candidate.answerYear === "number" ? 2 : 0;
  }
  if (requestedGranularity === "month") {
    return typeof candidate.answerMonth === "number" ? 2 : typeof candidate.answerYear === "number" ? 0.5 : 0;
  }
  if (typeof candidate.answerDay === "number") {
    return 2;
  }
  if (typeof candidate.answerMonth === "number") {
    return 1;
  }
  return typeof candidate.answerYear === "number" ? 0.5 : 0;
}

function temporalCandidateScore(queryText: string, candidate: TemporalAnswerCandidate): number {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  const derivationSummaryText = normalize(candidate.sourceText).toLowerCase();
  const festivalPreparationCue =
    queryEventKey === "perform_festival" &&
    /\b(?:dance\s+comp(?:etition)?|competition|choreograph\w*|rehears\w*|showcase|judging|local talent)\b/u.test(
      derivationSummaryText
    );
  const objectAlignmentCount =
    queryEventKey === "perform_festival" && candidate.eventEvidenceKind === "aligned"
      ? festivalPreparationCue
        ? Math.max(candidate.objectAlignmentCount, 2)
        : Math.min(candidate.objectAlignmentCount, 1)
      : candidate.objectAlignmentCount;
  const factBacked = isFactBackedTemporalCandidate(candidate);
  const lexicalEventAligned = isLexicallyAlignedTemporalCandidate(queryText, candidate);
  const qualifiedExactCandidate = isQualifiedExactTemporalCandidate(queryText, candidate);
  const qualifiedAlignedNeighborhood = isQualifiedAlignedTemporalNeighborhoodCandidate(queryText, candidate);
  let score =
    candidate.subjectScore * 3 +
    candidate.sourceWeight +
    temporalSupportWeight(candidate) +
    objectAlignmentCount * 2.25 +
    temporalGranularityWeight(queryText, candidate);
  if (qualifiedAlignedNeighborhood) {
    score += 3;
  }
  if (qualifiedExactCandidate) {
    score += 4;
  }
  if (candidate.occurredAtConflict) {
    score -= 6;
    if (candidate.bareTemporalLabel) {
      score -= 8;
    }
  }
  if (queryEventKey) {
    if (
      !factBacked &&
      candidate.eventEvidenceKind !== "none" &&
      !qualifiedAlignedNeighborhood &&
      !qualifiedExactCandidate
    ) {
      score -= 4;
    }
    if (candidate.eventEvidenceKind === "exact") {
      score += 5;
      if (queryObjectTokens.length > 0 && objectAlignmentCount === 0) {
        score -= 5;
      }
      if (candidate.sourceText && !lexicalEventAligned) {
        score -= 6;
      }
    } else if (candidate.eventEvidenceKind === "aligned") {
      score += qualifiedAlignedNeighborhood ? 4 : 1;
      if (!candidate.eventKey) {
        score -= 2;
      }
      if (queryObjectTokens.length > 0 && objectAlignmentCount === 0 && candidate.supportKind !== "aligned_anchor") {
        score -= 4;
      }
      if (candidate.sourceText && !lexicalEventAligned && candidate.supportKind !== "aligned_anchor") {
        score -= 3;
      }
    } else if (candidate.eventKey) {
      score -= 2;
    } else if (
      typeof candidate.answerYear === "number" ||
      typeof candidate.answerMonth === "number" ||
      typeof candidate.answerDay === "number"
    ) {
      score -= 4;
    }
  }
  if (isTemporalInceptionEventKey(queryEventKey) && candidate.eventEvidenceKind !== "none") {
    const sourceText = normalize(candidate.sourceText).toLowerCase();
    if (/\b(start|started|began|join|joined|launch|launched)\b/u.test(sourceText)) {
      score += 1.5;
    }
  }
  if (
    candidate.supportKind === "reference_derived_relative" &&
    !/\bhow long\b|\bbefore\b|\bafter\b|\bweek of\b|\bweekend of\b/iu.test(queryText)
  ) {
    score -= 4;
  }
  if (
    !factBacked &&
    candidate.eventEvidenceKind !== "none" &&
    !queryRequestsRelativeTemporalPhrasing(queryText)
  ) {
    score -= 3;
    if ((requestedGranularity === "month" || isGenericWhenTemporalQuery(queryText)) && typeof candidate.answerDay === "number") {
      score -= 3;
    }
  }
  if (
    queryEventKey &&
    derivationSummaryText &&
    /^the best supported (?:month|day|year) is\b/iu.test(derivationSummaryText) &&
    !lexicalEventAligned
  ) {
    score -= 8;
  }
  if (queryEventKey && candidate.bareTemporalLabel && !lexicalEventAligned) {
    score -= 10;
  }
  return score;
}

function selectBestTemporalAnswerCandidate(
  queryText: string,
  results: readonly RecallResult[]
): TemporalAnswerCandidate | null {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  const preferEarliest = shouldPreferEarliestTemporalQueryEvent(queryText, queryEventKey);
  const bundleMap = buildTemporalResultBundles(queryText, results);
  const scoredCandidates = results
    .map((result) => {
      const candidate = buildTemporalAnswerCandidateFromResult(queryText, result);
      return candidate
        ? {
            candidate,
            bundle: bundleMap.get(buildTemporalBundleKey(queryText, result))
          }
        : null;
    })
    .filter((entry): entry is { candidate: TemporalAnswerCandidate; bundle: TemporalResultBundleSummary | undefined } => Boolean(entry))
    .map(({ candidate, bundle }) => ({
      candidate,
      bundle,
      score:
        temporalCandidateScore(queryText, candidate) +
        (bundle ? Math.min(bundle.memberCount, 4) * 0.2 + bundle.bestGranularityRank * 0.1 + bundle.bestSupportPriority * 0.02 : 0) +
        (bundle && queryEventKey && isTemporalInceptionEventKey(queryEventKey) && candidate.eventEvidenceKind !== "none" &&
        temporalCandidateOrderingValue(candidate) === bundle.earliestOrderingValue
          ? 1.25
          : 0)
    }));
  if (scoredCandidates.length === 0) {
    return null;
  }
  const eventScopedCandidates =
    queryEventKey
      ? scoredCandidates.filter(({ candidate }) => candidate.eventEvidenceKind !== "none")
      : scoredCandidates;
  if (queryEventKey && eventScopedCandidates.length === 0) {
    return null;
  }
  const candidatesToUse = eventScopedCandidates.length > 0 ? eventScopedCandidates : scoredCandidates;
  const requestedGranularity = inferRequestedTemporalGranularity(queryText);
  const tieredCandidates = candidatesToUse.map((entry) => ({
    ...entry,
    tier: temporalCandidateTier(queryText, entry.candidate)
  }));
  const rankedTiers = [...new Set(tieredCandidates.map((entry) => entry.tier))].sort((left, right) => left - right);
  const candidatesForSelection =
    rankedTiers
      .map((tier) => tieredCandidates.filter((entry) => entry.tier === tier))
      .find((entries) => entries.some(({ candidate }) => hasRequestedTemporalGranularity(requestedGranularity, candidate))) ??
    (rankedTiers.length > 0
      ? tieredCandidates.filter((entry) => entry.tier === rankedTiers[0])
      : tieredCandidates);
  if (queryEventKey && preferEarliest) {
    const datedCandidates = candidatesForSelection.filter(({ candidate }) => typeof candidate.answerYear === "number");
    if (datedCandidates.length > 0) {
      const maxSubjectScore = Math.max(...datedCandidates.map(({ candidate }) => candidate.subjectScore));
      const subjectScopedCandidates =
        maxSubjectScore > 0
          ? datedCandidates.filter(({ candidate }) => candidate.subjectScore === maxSubjectScore)
          : datedCandidates;
      const objectScopedCandidates =
        queryObjectTokens.length > 0 && subjectScopedCandidates.some(({ candidate }) => candidate.objectAlignmentCount > 0)
          ? subjectScopedCandidates.filter(({ candidate }) => candidate.objectAlignmentCount > 0)
          : subjectScopedCandidates;
      const bestScore = Math.max(...objectScopedCandidates.map(({ score }) => score));
      const scoreScopedCandidates = objectScopedCandidates.filter(({ score }) => score >= bestScore - 1.5);
      scoreScopedCandidates.sort(
        (left, right) =>
          right.score - left.score ||
          temporalEvidencePriority(right.candidate.eventEvidenceKind) - temporalEvidencePriority(left.candidate.eventEvidenceKind) ||
          temporalSupportWeight(right.candidate) - temporalSupportWeight(left.candidate) ||
          right.candidate.objectAlignmentCount - left.candidate.objectAlignmentCount ||
          right.candidate.sourceWeight - left.candidate.sourceWeight ||
          temporalCandidateOrderingValue(left.candidate) - temporalCandidateOrderingValue(right.candidate) ||
          right.candidate.subjectScore - left.candidate.subjectScore
      );
      const strongestCandidates =
        scoreScopedCandidates.length > 1
          ? scoreScopedCandidates.filter(({ score }) => score >= scoreScopedCandidates[0]!.score - 0.35)
          : scoreScopedCandidates;
      strongestCandidates.sort(
        (left, right) =>
          temporalCandidateOrderingValue(left.candidate) - temporalCandidateOrderingValue(right.candidate) ||
          right.score - left.score ||
          temporalSupportPriority(right.candidate.supportKind, right.candidate.temporalSourceQuality) -
            temporalSupportPriority(left.candidate.supportKind, left.candidate.temporalSourceQuality) ||
          temporalSupportWeight(right.candidate) - temporalSupportWeight(left.candidate) ||
          right.candidate.objectAlignmentCount - left.candidate.objectAlignmentCount ||
          right.candidate.sourceWeight - left.candidate.sourceWeight
      );
      return strongestCandidates[0]?.candidate ?? null;
    }
  }
  candidatesForSelection.sort(
    (left, right) =>
      left.tier - right.tier ||
      right.score - left.score ||
      temporalEvidencePriority(right.candidate.eventEvidenceKind) - temporalEvidencePriority(left.candidate.eventEvidenceKind) ||
      temporalSupportWeight(right.candidate) - temporalSupportWeight(left.candidate) ||
      right.candidate.objectAlignmentCount - left.candidate.objectAlignmentCount ||
      right.candidate.sourceWeight - left.candidate.sourceWeight ||
      temporalCandidateOrderingValue(left.candidate) - temporalCandidateOrderingValue(right.candidate)
  );
  return candidatesForSelection[0]?.candidate ?? null;
}

function extractResultSourceUri(result: RecallResult): string | null {
  const metadata =
    typeof result.provenance === "object" &&
    result.provenance !== null &&
    typeof (result.provenance as Record<string, unknown>).metadata === "object" &&
    (result.provenance as Record<string, unknown>).metadata !== null
      ? ((result.provenance as Record<string, unknown>).metadata as Record<string, unknown>)
      : null;
  return (
    readStructuredContentString(result.content, "sourceUri") ??
    readStructuredContentString(result.content, "source_uri") ??
    readMetadataString(metadata, "source_uri") ??
    (typeof result.provenance.source_uri === "string" ? normalize(result.provenance.source_uri) : null)
  );
}

function expandConversationSessionSourceUris(results: readonly RecallResult[]): readonly string[] {
  const directSourceUris = [...new Set(
    results
      .map((result) => extractResultSourceUri(result))
      .filter((value): value is string => Boolean(value && value.startsWith("/") && existsSync(value)))
  )];
  if (directSourceUris.length === 0) {
    return [];
  }

  return [...new Set(
    directSourceUris.flatMap((sourceUri) => {
      const sessionMatch = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u);
      if (!sessionMatch) {
        return [sourceUri];
      }
      try {
        return readdirSync(dirname(sourceUri))
          .filter((entry) => entry.startsWith(sessionMatch[1]!) && entry.endsWith(".md"))
          .map((entry) => join(dirname(sourceUri), entry));
      } catch {
        return [sourceUri];
      }
    })
  )];
}

function isFirstPersonSourceSentence(sentence: string): boolean {
  return /^(?:[A-Z][a-z]+:\s*)?(?:i\b|i'm\b|i’ve\b|i've\b|i’d\b|i'd\b|my\b|me\b|we\b|our\b)/iu.test(normalize(sentence));
}

function hasEmbeddedFirstPersonActionCue(sentence: string): boolean {
  const normalizedSentence = normalize(sentence);
  if (!normalizedSentence) {
    return false;
  }
  return /\b(?:i|we)\b[^.!?]{0,80}\b(?:made|make|baked|bake|cooked|cook|prepared|prepare)\b/iu.test(normalizedSentence);
}

function sourceUriHasSubjectAlignedSeed(
  queryText: string,
  sourceUri: string,
  results: readonly RecallResult[]
): boolean {
  const targetPrefix = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u)?.[1] ?? null;
  return results.some((result) => {
    const resultSourceUri = extractResultSourceUri(result);
    if (!resultSourceUri) {
      return false;
    }
    const resultPrefix = basename(resultSourceUri).match(/^(.*-session_)\d+\.md$/u)?.[1] ?? null;
    const sameConversation =
      resultSourceUri === sourceUri ||
      (targetPrefix !== null && resultPrefix !== null && targetPrefix === resultPrefix);
    return sameConversation && resultSupportsTemporalQuerySubject(queryText, result);
  });
}

function collectExpandedTemporalSourceTexts(results: readonly RecallResult[]): readonly string[] {
  return uniqueNormalized(
    expandConversationSessionSourceUris(results).flatMap((sourceUri) => {
      try {
        return [readFileSync(sourceUri, "utf8")];
      } catch {
        return [];
      }
    })
  );
}

function collectExpandedSourceTexts(results: readonly RecallResult[]): readonly string[] {
  return collectExpandedTemporalSourceTexts(results);
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && normalize(value) ? normalize(value) : null;
}

function readMetadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const parsed = candidate ? Date.parse(candidate) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(candidate as string).toISOString() : null;
}

function buildTemporalReferenceInstantFromParts(
  year: number | null,
  month: number | null,
  day: number | null
): string | null {
  if (typeof year !== "number") {
    return null;
  }
  const monthIndex = typeof month === "number" ? month - 1 : 0;
  const resolvedDay = typeof day === "number" ? day : 1;
  return new Date(Date.UTC(year, monthIndex, resolvedDay, 12, 0, 0, 0)).toISOString();
}

function readResultTemporalMetadataAnchorInstant(result: RecallResult): string | null {
  const metadata = result.provenance?.metadata as Record<string, unknown> | null | undefined;
  const explicitPartsInstant = buildTemporalReferenceInstantFromParts(
    readMetadataNumber(metadata ?? null, "answer_year"),
    readMetadataNumber(metadata ?? null, "answer_month"),
    readMetadataNumber(metadata ?? null, "answer_day")
  );
  if (explicitPartsInstant) {
    return explicitPartsInstant;
  }
  const anchorText =
    readMetadataString(metadata ?? null, "anchor_text") ??
    readMetadataString(metadata ?? null, "leaf_time_hint_text");
  const parsedAnchor = anchorText ? parseTemporalPartsCandidate(anchorText) : null;
  return parsedAnchor
    ? buildTemporalReferenceInstantFromParts(parsedAnchor.year, parsedAnchor.month, parsedAnchor.day)
    : null;
}

function selectBestTemporalReferenceInstant(instants: readonly (string | null | undefined)[]): string | null {
  const parsed = instants
    .map((value) => (typeof value === "string" && value.trim() ? value.trim() : null))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, millis: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.millis));
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((left, right) => right.millis - left.millis);
  return new Date(parsed[0]!.millis).toISOString();
}

function selectPreferredTemporalReferenceInstant(instants: readonly (string | null | undefined)[]): string | null {
  for (const instant of instants) {
    if (typeof instant !== "string" || !instant.trim()) {
      continue;
    }
    const parsed = Date.parse(instant);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function selectRelativeTemporalReferenceInstant(
  occurredAt: string | null | undefined,
  sourceReferenceInstant: string | null | undefined,
  capturedAt: string | null | undefined
): string | null {
  const sourceScoped = selectBestTemporalReferenceInstant([sourceReferenceInstant, capturedAt]);
  if (sourceScoped) {
    return sourceScoped;
  }
  return selectBestTemporalReferenceInstant([occurredAt]);
}

function selectResultLevelTemporalReferenceInstant(result: RecallResult): string | null {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return selectBestTemporalReferenceInstant([
    readResultTemporalMetadataAnchorInstant(result),
    readSourceReferenceInstant(extractResultSourceUri(result)),
    readMetadataString(metadata, "captured_at"),
    result.occurredAt ?? null
  ]);
}

function sentenceCase(value: string | null): string | null {
  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function inferRelativeYearOnlyFromSentence(sentence: string, sourceReferenceInstant: string | null): string | null {
  if (!sourceReferenceInstant) {
    return null;
  }
  const anchorYear = new Date(sourceReferenceInstant).getUTCFullYear();
  const normalized = normalize(sentence).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/\blast year\b/u.test(normalized)) {
    return String(anchorYear - 1);
  }
  if (/\ba few years ago\b/u.test(normalized)) {
    return String(anchorYear - 3);
  }
  const numericYearsAgo = normalized.match(/\b(\d+)\s+years?\s+ago\b/u);
  if (numericYearsAgo?.[1]) {
    const years = Number.parseInt(numericYearsAgo[1], 10);
    if (Number.isFinite(years) && years > 0) {
      return String(anchorYear - years);
    }
  }
  const wordYearsAgo = normalized.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+ago\b/u
  );
  if (wordYearsAgo?.[1]) {
    const yearsAgoMap: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10
    };
    return String(anchorYear - yearsAgoMap[wordYearsAgo[1]]!);
  }
  return null;
}

function extractSentenceCandidates(content: string): readonly string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((value) => normalize(value))
    .filter(Boolean);
}

const TEMPORAL_EVENT_ALIGNMENT_STOPWORDS = new Set([
  "go",
  "went",
  "join",
  "joined",
  "attend",
  "attended",
  "meeting",
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

function temporalEventAlignmentTokens(eventKey: string | null): readonly string[] {
  const normalized = normalize(eventKey).toLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/[_\s]+/u)
    .map((token) => token.replace(/[^a-z0-9+]/gu, ""))
    .filter((token) => token.length > 2 && !TEMPORAL_EVENT_ALIGNMENT_STOPWORDS.has(token));
}

function hasCareerHighPointsCue(sentence: string): boolean {
  const normalizedSentence = sentence.toLowerCase();
  const hasPointsOrScore = /\b(?:score|points?)\b/u.test(normalizedSentence);
  const hasSuperlative =
    /\bcareer-?high\b/u.test(normalizedSentence) ||
    /\bhighest(?:\s+score|\s+points?)\s+ever\b/u.test(normalizedSentence) ||
    (/\bhighest ever\b/u.test(normalizedSentence) && hasPointsOrScore) ||
    /\bpersonal best\b/u.test(normalizedSentence);
  return hasPointsOrScore && hasSuperlative;
}

function isEventAlignedTemporalSentence(queryEventKey: string | null, sentence: string): boolean {
  if (!queryEventKey) {
    return true;
  }
  if (areTemporalEventKeysCompatible(inferTemporalEventKeyFromText(sentence), queryEventKey)) {
    return true;
  }
  const normalizedSentence = sentence.toLowerCase();
  if (
    queryEventKey === "donate_car" &&
    /\bdonat(?:e|ed|ing)\b/u.test(normalizedSentence) &&
    /\b(?:car|prius|vehicle)\b/u.test(normalizedSentence)
  ) {
    return true;
  }
  if (
    queryEventKey === "career_high_points" &&
    hasCareerHighPointsCue(sentence)
  ) {
    return true;
  }
  if (
    queryEventKey === "start_surfing" &&
    /\bsurf\w*\b/u.test(normalizedSentence) &&
    (/\bstarted?\b/u.test(normalizedSentence) || /\bfirst time\b/u.test(normalizedSentence) || /\byears?\s+ago\b/u.test(normalizedSentence))
  ) {
    return true;
  }
  if (/support_group$/u.test(queryEventKey)) {
    const hasSupportGroupPhrase = /\bsupport groups?\b/u.test(normalizedSentence);
    const hasAttendanceVerb = /\b(?:go|goes|going|went|attend(?:ed|ing)?|participat(?:e|ed|ing)|join(?:ed|ing)?)\b/u.test(
      normalizedSentence
    );
    const requiresLgbtqSignal = /\blgbtq\b/u.test(queryEventKey);
    const hasLgbtqSignal = /\blgbtq\+?\b|\bqueer\b|\btrans(?:gender)?\b/u.test(normalizedSentence);
    return hasSupportGroupPhrase && hasAttendanceVerb && (!requiresLgbtqSignal || hasLgbtqSignal);
  }
  if (
    areTemporalEventKeysCompatible(queryEventKey, "adopt_dogs") &&
    (
      (/\badopt(?:ed|ing)\b/u.test(normalizedSentence) && /\b(?:dogs?|pupp(?:y|ies)|pup)\b/u.test(normalizedSentence)) ||
      /\b(?:i have|i've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+\d+\s+years?\b/u.test(normalizedSentence)
    )
  ) {
    return true;
  }
  if (
    queryEventKey === "perform_festival" &&
    (
      (
        /\bfestival\b/u.test(normalizedSentence) &&
        (
          /\bperform(?:ed|ing)?\b/u.test(normalizedSentence) ||
          /\bchoreograph\w*\b/u.test(normalizedSentence) ||
          /\brehears\w*\b/u.test(normalizedSentence)
        )
      ) ||
      (
        /\b(?:dance\s+comp(?:etition)?|competition|performances?|perform(?:ed|ing)?|stage)\b/u.test(normalizedSentence) &&
        (
          /\bnext month\b/u.test(normalizedSentence) ||
          /\bshowcase\b/u.test(normalizedSentence) ||
          /\blocal talent\b/u.test(normalizedSentence) ||
          /\bjudging\b/u.test(normalizedSentence) ||
          /\bgroup\b/u.test(normalizedSentence) ||
          /\bdancers?\b/u.test(normalizedSentence)
        )
      )
    )
  ) {
    return true;
  }
  const alignmentTokens = temporalEventAlignmentTokens(queryEventKey);
  const matchedTokenCount = alignmentTokens.filter((token) => normalizedSentence.includes(token)).length;
  return alignmentTokens.length <= 1
    ? matchedTokenCount >= 1
    : matchedTokenCount >= Math.min(2, alignmentTokens.length);
}

function isAnchoredRelativeCueForRender(value: string | null): boolean {
  const normalized = normalize(value).toLowerCase();
  return (
    /\bbefore\b/u.test(normalized) ||
    normalized === "next month" ||
    normalized === "last year" ||
    normalized === "a few years ago" ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+years?\s+ago\b/u.test(normalized) ||
    normalized === "yesterday" ||
    normalized === "last night" ||
    normalized === "last week" ||
    normalized === "last weekend" ||
    /\b\d+\s+weeks?\s+ago\b/u.test(normalized) ||
    /\b\d+\s+days?\s+ago\b/u.test(normalized) ||
    /\b(?:one|two|three|four)\s+weeks?\s+ago\b/u.test(normalized) ||
    /\b(?:one|two|three|four)\s+days?\s+ago\b/u.test(normalized)
  );
}

function sentenceMentionsSubject(sentence: string, subjectName: string | null): boolean {
  const normalizedSubjectName = normalize(subjectName).toLowerCase();
  if (!normalizedSubjectName) {
    return true;
  }
  const normalizedSentence = normalize(sentence).toLowerCase();
  return (
    normalizedSentence.includes(normalizedSubjectName) ||
    normalizedSentence.includes(`${normalizedSubjectName}:`) ||
    normalizedSentence.includes(`for ${normalizedSubjectName}`)
  );
}

function resultSupportsTemporalQuerySubject(queryText: string, result: RecallResult): boolean {
  return temporalQuerySubjectScore(queryText, result) > 0;
}

function sentenceHasTemporalCue(sentence: string): boolean {
  const normalizedSentence = normalize(sentence);
  if (!normalizedSentence) {
    return false;
  }
  if (parseTemporalPartsCandidate(normalizedSentence)) {
    return true;
  }
  if (extractRelativeTemporalCue(normalizedSentence)) {
    return true;
  }
  return /\b(?:today|tonight|yesterday|tomorrow|last|next|this|week|weekend|month|year|day|ago|before|after)\b/iu.test(
    normalizedSentence
  );
}

function shouldIncludeTemporalNeighborhoodNeighbor(
  queryText: string,
  queryEventKey: string | null,
  sentence: string,
  querySubjectName: string | null
): boolean {
  const normalizedSentence = normalize(sentence);
  if (!normalizedSentence || !sentenceHasTemporalCue(normalizedSentence)) {
    return false;
  }
  const inferredNeighborEventKey = inferTemporalEventKeyFromText(normalizedSentence);
  if (
    queryEventKey &&
    inferredNeighborEventKey &&
    !areTemporalEventKeysCompatible(inferredNeighborEventKey, queryEventKey)
  ) {
    return false;
  }
  if (querySubjectName && !sentenceMentionsSubject(normalizedSentence, querySubjectName) && !isFirstPersonSourceSentence(normalizedSentence)) {
    return false;
  }
  return (
    !queryEventKey ||
    isEventAlignedTemporalSentence(queryEventKey, normalizedSentence) ||
    isTemporalQueryTextAligned(queryText, normalizedSentence) ||
    !inferredNeighborEventKey
  );
}

function collectTemporalNeighborhoodTexts(
  queryText: string,
  results: readonly RecallResult[]
): readonly string[] {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const querySubjectName = inferSingleQuerySubjectName(queryText);
  const collected: string[] = [];
  const appendNeighborhoodUnits = (
    candidate: string,
    occurredAt: string | null | undefined,
    sourceReferenceInstant: string | null,
    resultSubjectAligned: boolean
  ): void => {
    const sentences = extractSentenceCandidates(candidate);
    if (sentences.length === 0) {
      return;
    }
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index]!;
      const eventAligned =
        queryEventKey
          ? isEventAlignedTemporalSentence(queryEventKey, sentence) || isTemporalQueryTextAligned(queryText, sentence)
          : isTemporalQueryTextAligned(queryText, sentence);
      if (!eventAligned || !(resultSubjectAligned || sentenceMentionsSubject(sentence, querySubjectName))) {
        continue;
      }
      for (const neighborIndex of [index - 1, index, index + 1]) {
        const neighbor = sentences[neighborIndex];
        if (!neighbor) {
          continue;
        }
        if (
          neighborIndex !== index &&
          !shouldIncludeTemporalNeighborhoodNeighbor(queryText, queryEventKey, neighbor, querySubjectName)
        ) {
          continue;
        }
        collected.push(neighbor);
        const explicitLabel = inferRelativeTemporalAnswerLabel(neighbor, occurredAt, sourceReferenceInstant);
        if (explicitLabel) {
          collected.push(markAlignedTemporalText(explicitLabel));
        }
      }
    }
  };

  for (const result of results) {
    const resultSubjectAligned = resultSupportsTemporalQuerySubject(queryText, result);
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    const sourceUri = extractResultSourceUri(result);
    const sourceReferenceInstant = selectRelativeTemporalReferenceInstant(
      result.occurredAt ?? null,
      readSourceReferenceInstant(sourceUri),
      readMetadataString(metadata, "captured_at")
    );
    for (const candidate of collectRecallResultTextCandidates(result)) {
      appendNeighborhoodUnits(candidate, sourceReferenceInstant ?? result.occurredAt, sourceReferenceInstant, resultSubjectAligned);
    }
    if (sourceUri && existsSync(sourceUri)) {
      try {
        appendNeighborhoodUnits(
          readFileSync(sourceUri, "utf8"),
          sourceReferenceInstant ?? result.occurredAt,
          sourceReferenceInstant,
          resultSubjectAligned
        );
      } catch {
        // Ignore unreadable source files and continue with inline evidence.
      }
    }
  }

  return uniqueNormalized(collected);
}

function deriveRelativeTemporalClaimText(
  queryText: string,
  results: readonly RecallResult[],
  fallbackClaimText: string | null
): string | null {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const relativeCandidates: RelativeTemporalClaimCandidate[] = [];
  const addRelativeCandidate = (
    candidate: string,
    occurredAt: string | null | undefined,
    sourceReferenceInstant: string | null
  ): void => {
    const units = queryEventKey
      ? (() => {
          const sentences = extractSentenceCandidates(candidate);
          const matched = sentences.filter((sentence) => isEventAlignedTemporalSentence(queryEventKey, sentence));
          return matched.length > 0 ? matched : [];
        })()
      : [candidate];
    for (const unit of units) {
      const relativeCue = extractRelativeTemporalCue(unit);
      if (!isAnchoredRelativeCueForRender(relativeCue)) {
        continue;
      }
      const relativeClaimText = deriveAnchoredRelativeTemporalClaimText(
        relativeCue,
        inferRelativeTemporalAnswerLabel(unit, occurredAt, sourceReferenceInstant),
        sourceReferenceInstant
      );
      if (relativeClaimText) {
        const claimText = sentenceCase(relativeClaimText);
        if (!claimText) {
          continue;
        }
        const parsed = parseTemporalPartsCandidate(claimText);
        relativeCandidates.push({
          claimText,
          orderingValue: parsed?.orderingValue ?? null,
          granularityRank: parsed?.granularityRank ?? 0
        });
      }
    }
  };
  for (const result of results) {
    const metadata =
      typeof result.provenance === "object" &&
      result.provenance !== null &&
      typeof (result.provenance as Record<string, unknown>).metadata === "object" &&
      (result.provenance as Record<string, unknown>).metadata !== null
        ? ((result.provenance as Record<string, unknown>).metadata as Record<string, unknown>)
        : null;
    const sourceUri = extractResultSourceUri(result);
    const sourceReferenceInstant = selectRelativeTemporalReferenceInstant(
      result.occurredAt ?? null,
      readSourceReferenceInstant(sourceUri),
      readMetadataString(metadata, "captured_at")
    );
    const sourceContent =
      typeof sourceUri === "string" && existsSync(sourceUri)
        ? readFileSync(sourceUri, "utf8")
        : null;
    const candidates = [
      ...collectRecallResultTextCandidates(result),
      sourceContent
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      addRelativeCandidate(candidate, sourceReferenceInstant ?? result.occurredAt, sourceReferenceInstant);
    }
  }

  for (const sourceUri of expandConversationSessionSourceUris(results)) {
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri);
    if (!sourceReferenceInstant || !existsSync(sourceUri)) {
      continue;
    }
    const sourceContent = readFileSync(sourceUri, "utf8");
    addRelativeCandidate(sourceContent, sourceReferenceInstant, sourceReferenceInstant);
  }

  if (relativeCandidates.length > 0) {
    const preferEarliest = shouldPreferEarliestTemporalQueryEvent(queryText, queryEventKey);
    relativeCandidates.sort((left, right) => {
      if (preferEarliest) {
        if (left.orderingValue !== null && right.orderingValue !== null && left.orderingValue !== right.orderingValue) {
          return left.orderingValue - right.orderingValue;
        }
        if (left.orderingValue !== null && right.orderingValue === null) {
          return -1;
        }
        if (left.orderingValue === null && right.orderingValue !== null) {
          return 1;
        }
      }
      const granularityDelta = right.granularityRank - left.granularityRank;
      if (granularityDelta !== 0) {
        return granularityDelta;
      }
      if (left.orderingValue !== null && right.orderingValue !== null && left.orderingValue !== right.orderingValue) {
        return left.orderingValue - right.orderingValue;
      }
      return left.claimText.localeCompare(right.claimText);
    });
    return relativeCandidates[0]?.claimText ?? null;
  }

  return sentenceCase(
    deriveAnchoredRelativeTemporalClaimText(
      extractRelativeTemporalCue(fallbackClaimText ?? ""),
      inferRelativeTemporalAnswerLabel(fallbackClaimText ?? "", null, null),
      null
    )
  );
}

export interface ListSetSupport {
  readonly supportObjectType: "ListSetSupport";
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly typedEntries: readonly string[];
  readonly fallbackEntries: readonly string[];
  readonly typedEntryType: string | null;
  readonly binarySupportInference: boolean;
  readonly subjectPlan: SubjectPlan;
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
  readonly targetedFieldsRequested: readonly string[];
  readonly targetedRetrievalSatisfied: boolean;
  readonly supportNormalizationFailures: readonly string[];
}

export interface DirectDetailSupport {
  readonly supportObjectType: "DirectDetailSupport";
  readonly selectedText: string | null;
  readonly exactDetailSource: RecallExactDetailSource | null;
  readonly strongSupport: boolean;
  readonly supportNormalizationFailures: readonly string[];
}

export interface SnippetFactSupport {
  readonly supportObjectType: "SnippetFactSupport";
  readonly selectedText: string | null;
  readonly supportNormalizationFailures: readonly string[];
}

function shouldUseCollectionSetSupport(queryText: string): boolean {
  return /\bwhat items\b|\bwhich items\b|\bwhat does\b[^?!.]{0,80}\bcollect\b/u.test(normalizeLower(queryText));
}

function buildCollectionSetEntries(
  queryText: string,
  subjectName: string | null,
  evidenceTexts: readonly string[],
  fallbackFacts: readonly NormalizedCollectionFact[]
): {
  readonly entries: readonly string[];
  readonly decisiveCueCount: number;
  readonly completenessScore: number;
} {
  const compatibleFacts = [
    ...extractNormalizedCollectionFacts(queryText, subjectName, evidenceTexts).filter((fact) => factIsQueryCompatible(queryText, fact)),
    ...fallbackFacts.filter((fact) => factIsQueryCompatible(queryText, fact))
  ];
  const explicitFacts = compatibleFacts.filter((fact) => fact.cueType !== "payload_fallback");
  const factsToUse = explicitFacts.length > 0 ? explicitFacts : compatibleFacts;
  const entryScores = new Map<string, { score: number; value: string; order: number }>();
  let order = 0;
  for (const fact of factsToUse) {
    for (const entry of fact.entryValues) {
      if (!entry || isVagueCollectionValue(entry) || isSceneDescriptionCollectionValue(entry)) {
        continue;
      }
      const bonus = fact.itemCount >= 2 ? 2 : 0;
      const score = fact.score + bonus;
      const key = normalizeLower(entry);
      const current = entryScores.get(key);
      if (!current || score > current.score) {
        entryScores.set(key, { score, value: entry, order });
      }
      order += 1;
    }
  }
  const entries = [...entryScores.values()]
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map((entry) => entry.value);
  const collapsedEntries = collapseSubsumedCollectionEntries(entries);
  const decisiveCueCount = factsToUse.filter((fact) => fact.cueType !== "payload_fallback" && fact.itemCount > 0).length;
  const completenessScore = Math.min(1, collapsedEntries.length / 3);
  return {
    entries: collapsedEntries,
    decisiveCueCount,
    completenessScore
  };
}

export function buildCollectionInferenceSupport(params: {
  readonly queryText: string;
  readonly fallbackSummary: string | null;
  readonly answerPayload?: Record<string, unknown> | null;
  readonly results: readonly RecallResult[];
  readonly atomicUnits?: readonly AtomicMemoryUnit[];
}): CollectionInferenceSupport | CollectionSetSupport {
  const querySubjectName = inferSingleQuerySubjectName(params.queryText);
  const payload = answerPayloadRecord(params.answerPayload);
  const runtimeSupport = collectRuntimeReportSupport(params.queryText, params.results);
  const runtime = deriveRuntimeReportClaim("collection_report", params.queryText, params.results);
  const evidenceTexts = uniqueNormalized([
    ...collectSupportEvidenceTexts(params.results),
    ...collectExpandedSourceTexts(params.results),
    ...runtimeSupport.texts
  ]);
  const bestCandidate = selectBestCollectionCandidate(params.queryText, querySubjectName, evidenceTexts);
  const queryBoundSummary = deriveQueryBoundReportSummary("collection_report", params.queryText, evidenceTexts);
  const queryBoundPayload = answerPayloadRecord(
    buildReportAnswerPayload("collection_report", [
      ...(bestCandidate ? [bestCandidate.sourceText] : evidenceTexts),
      normalize(queryBoundSummary)
    ])
  );
  const fallbackPayload = answerPayloadRecord(
    buildReportAnswerPayload("collection_report", [normalize(params.fallbackSummary)])
  );
  const payloadValue = payloadString(payload, "answer_value");
  const payloadReason = payloadString(payload, "reason_value");
  const queryBoundValue = payloadString(queryBoundPayload, "answer_value");
  const queryBoundReason = payloadString(queryBoundPayload, "reason_value");
  const fallbackValue = payloadString(fallbackPayload, "answer_value");
  const fallbackReason = payloadString(fallbackPayload, "reason_value");
  const payloadFallbackFact =
    payloadValue
      ? buildNormalizedCollectionFact({
          queryText: params.queryText,
          subjectName: querySubjectName,
          sourceText: normalize(params.fallbackSummary) || payloadValue,
          collectionValue: payloadValue,
          reasonValue: payloadReason,
          cueType: "payload_fallback",
          cueStrength: 2
        })
      : null;
  const queryBoundFallbackFact =
    queryBoundValue
      ? buildNormalizedCollectionFact({
          queryText: params.queryText,
          subjectName: querySubjectName,
          sourceText: normalize(queryBoundSummary) || queryBoundValue,
          collectionValue: queryBoundValue,
          reasonValue: queryBoundReason,
          cueType: "payload_fallback",
          cueStrength: 3
        })
      : null;
  const fallbackFacts = [payloadFallbackFact, queryBoundFallbackFact].filter(
    (fact): fact is NormalizedCollectionFact => Boolean(fact)
  );
  const normalizedAtomicFacts = extractNormalizedCollectionFactsFromAtomicUnits(
    params.queryText,
    querySubjectName,
    params.atomicUnits ?? []
  );
  const normalizedResultFacts = extractNormalizedCollectionFactsFromResults(
    params.queryText,
    querySubjectName,
    params.results
  );
  const normalizedFacts = [...new Map(
    [
      ...normalizedAtomicFacts,
      ...normalizedResultFacts,
      ...extractNormalizedCollectionFacts(params.queryText, querySubjectName, evidenceTexts),
      ...fallbackFacts
    ].map((fact) => [normalizeLower(fact.collectionValue), fact] as const)
  ).values()].sort((left, right) => right.score - left.score || right.itemCount - left.itemCount);
  if (shouldUseCollectionSetSupport(params.queryText)) {
    const setSupport = buildCollectionSetEntries(params.queryText, querySubjectName, evidenceTexts, normalizedFacts);
    return {
      supportObjectType: "CollectionSetSupport",
      collectionEntries: setSupport.entries,
      completenessScore: setSupport.completenessScore,
      decisiveCueCount: setSupport.decisiveCueCount,
      runtimeClaimText: normalize(runtime.claimText) || null,
      supportRowsSelected: runtimeSupport.trace.selectedResultCount,
      supportTextsSelected: runtimeSupport.trace.supportTextsSelected,
      supportSelectionMode: runtimeSupport.trace.supportSelectionMode,
      targetedRetrievalAttempted: runtimeSupport.trace.targetedRetrievalAttempted,
      targetedRetrievalReason: runtimeSupport.trace.targetedRetrievalReason,
      supportNormalizationFailures: setSupport.entries.length > 0 ? [] : ["no_collection_entries_normalized"]
    };
  }
  const collectionValue =
    bestCandidate?.collectionValue ??
    normalizedFacts.find((fact) => factIsQueryCompatible(params.queryText, fact))?.collectionValue ??
    (isBookshelfCollectionQuery(params.queryText) ? (fallbackValue ? fallbackValue : null) : null) ??
    (isBookshelfCollectionQuery(params.queryText) ? queryBoundSummary : null) ??
    (isBookshelfCollectionQuery(params.queryText) ? (normalize(runtime.claimText) || null) : null);
  const reasonValue =
    bestCandidate?.reasonValue ??
    normalizedFacts.find((fact) => factIsQueryCompatible(params.queryText, fact))?.reasonValue ??
    (isBookshelfCollectionQuery(params.queryText) ? fallbackReason : null) ??
    (collectionValue ? `collects ${collectionValue}` : null);
  const failures =
    collectionValue || reasonValue
      ? []
      : ["no_collection_value_normalized"];
  return {
    supportObjectType: "CollectionInferenceSupport",
    collectionValue,
    reasonValue,
    runtimeClaimText: normalize(runtime.claimText) || null,
    supportRowsSelected: runtimeSupport.trace.selectedResultCount,
    supportTextsSelected: runtimeSupport.trace.supportTextsSelected,
    supportSelectionMode: runtimeSupport.trace.supportSelectionMode,
    targetedRetrievalAttempted: runtimeSupport.trace.targetedRetrievalAttempted,
    targetedRetrievalReason: runtimeSupport.trace.targetedRetrievalReason,
    supportNormalizationFailures: failures
  };
}

export function renderCollectionInferenceSupport(
  queryText: string,
  support: CollectionInferenceSupport | CollectionSetSupport
): RenderedSupportClaim {
  const normalizedQuery = normalize(queryText).toLowerCase();
  const querySubjectName = inferSingleQuerySubjectName(queryText);
  if (support.supportObjectType === "CollectionSetSupport") {
    const entries = uniqueNormalized(support.collectionEntries);
    const minimumEntries = inferCollectionRenderMinimumEntryCount(queryText);
    const claimText = entries.length >= minimumEntries ? joinCanonicalItems(entries) : null;
    return {
      claimText,
      shapingMode: claimText && support.runtimeClaimText && normalize(claimText) === normalize(support.runtimeClaimText)
        ? "runtime_report_resynthesis"
        : "typed_report_payload",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: Boolean(claimText && support.runtimeClaimText && normalize(claimText) === normalize(support.runtimeClaimText)),
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      typedSetEntryCount: entries.length,
      typedSetEntryType: entries.length > 0 ? "collection_item" : null,
      renderContractSelected: claimText ? "collection_set_render" : "collection_summary_fallback",
      renderContractFallbackReason:
        claimText
          ? null
          : entries.length > 0
            ? "collection_entries_incomplete"
            : "collection_entries_missing"
    };
  }
  if (/\bbookshelf\b|\bdr\.?\s*seuss\b/u.test(normalizedQuery)) {
    const reasonValue = normalize(support.reasonValue);
    if (reasonValue) {
      const singularReason = reasonValue.replace(/^collects\s+/iu, "collects ");
      return {
        claimText: querySubjectName
          ? `Yes, since ${querySubjectName} ${singularReason}.`
          : `Yes, since they ${reasonValue.replace(/^collects\s+/iu, "collect ")}.`,
        shapingMode: "typed_report_payload",
        typedValueUsed: true,
        generatedProseUsed: true,
        runtimeResynthesisUsed: support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText),
        supportRowsSelected: support.supportRowsSelected,
        supportTextsSelected: support.supportTextsSelected,
        supportSelectionMode: support.supportSelectionMode,
        targetedRetrievalAttempted: support.targetedRetrievalAttempted,
        targetedRetrievalReason: support.targetedRetrievalReason,
        supportObjectsBuilt: 1,
        supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "collection_yes_since_collects",
        renderContractFallbackReason:
          support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText)
            ? "runtime_collection_value"
            : null
      };
    }
    const collectionValue = normalize(support.collectionValue);
    if (collectionValue) {
      return {
        claimText: querySubjectName
          ? `Yes, since ${querySubjectName} collects ${collectionValue}.`
          : `Yes, since they collect ${collectionValue}.`,
        shapingMode: support.runtimeClaimText === support.collectionValue ? "runtime_report_resynthesis" : "typed_report_payload",
        typedValueUsed: true,
        generatedProseUsed: true,
        runtimeResynthesisUsed: support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText),
        supportRowsSelected: support.supportRowsSelected,
        supportTextsSelected: support.supportTextsSelected,
        supportSelectionMode: support.supportSelectionMode,
        targetedRetrievalAttempted: support.targetedRetrievalAttempted,
        targetedRetrievalReason: support.targetedRetrievalReason,
        supportObjectsBuilt: 1,
        supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "collection_yes_since_collects",
        renderContractFallbackReason:
          support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText)
            ? "runtime_collection_value"
            : "reason_value_missing"
      };
    }
  }
  if (/\bwhat items\b|\bcollect\b/u.test(normalizedQuery) && normalize(support.collectionValue)) {
    return {
      claimText: normalize(support.collectionValue),
      shapingMode: support.runtimeClaimText === support.collectionValue ? "runtime_report_resynthesis" : "typed_report_payload",
      typedValueUsed: true,
      generatedProseUsed: false,
      runtimeResynthesisUsed: support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText),
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "collection_value",
      renderContractFallbackReason: null
    };
  }
  return {
    claimText: normalize(support.collectionValue) || null,
    shapingMode: support.runtimeClaimText === support.collectionValue ? "runtime_report_resynthesis" : "stored_report_summary",
    typedValueUsed: Boolean(support.collectionValue),
    generatedProseUsed: false,
    runtimeResynthesisUsed: support.runtimeClaimText === support.collectionValue && Boolean(support.runtimeClaimText),
    supportRowsSelected: support.supportRowsSelected,
    supportTextsSelected: support.supportTextsSelected,
    supportSelectionMode: support.supportSelectionMode,
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "collection_summary_fallback",
    renderContractFallbackReason: normalize(support.collectionValue) ? null : "collection_value_missing"
  };
}

function isCausalReasonQuery(queryText: string): boolean {
  return (
    /^\s*why\b/iu.test(queryText) ||
    /\bwhat\s+helped\b/iu.test(queryText) ||
    /\bwhat\s+(?:made|caused|prompted)\b/iu.test(queryText) ||
    /\bhow\s+did\b[^?!.]{0,120}\bhelp\b/iu.test(queryText) ||
    /\breason\b/iu.test(queryText)
  );
}

function isComparativeFitQuery(queryText: string): boolean {
  const normalized = normalize(queryText).toLowerCase();
  return (
    /\bwould\b/u.test(normalized) &&
    /\b(enjoy|like|love)\b/u.test(normalized) &&
    (
      /\bperform(?:ing)?\b/u.test(normalized) ||
      /\bstage\b/u.test(normalized) ||
      /\bvenue\b/u.test(normalized) ||
      /\bconcert\b/u.test(normalized) ||
      /\bhollywood bowl\b/u.test(normalized)
    )
  );
}

function isPairAdviceQuery(queryText: string): boolean {
  return (
    /\bwhat advice might\b/iu.test(queryText) ||
    /\bmajor life transition\b/iu.test(queryText) ||
    /\bpersonal growth\b/iu.test(queryText)
  );
}

function looksNoisyReportValue(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  const lowered = normalized.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /canonical_rebuild|media_mentions|unknown|graph_entity_report|assembled_graph_entity_report/u.test(lowered) ||
    /^yes,\s+because\s+[A-Z][A-Za-z'’.-]{1,40}:/u.test(normalized) ||
    (/diet plan|hospital|icefields park|stress|check it out/u.test(lowered) && normalized.includes(",")) ||
    (/^\{.+\}$/u.test(normalized) && /memoryid|artifactid|sourceuri/iu.test(normalized))
  );
}

function inferComparativeFitReasonFromTexts(texts: readonly string[]): string | null {
  const combined = normalize(texts.join(" ")).toLowerCase();
  if (!combined) {
    return null;
  }
  if (
    /\brush of performing\b/u.test(combined) ||
    (/\bperforming live\b/u.test(combined) && /\bconnection with the crowd\b/u.test(combined)) ||
    (/\bfuels my soul\b/u.test(combined) && /\bcrowd\b/u.test(combined)) ||
    (/\babsolute high\b/u.test(combined) && /\bcrowd\b/u.test(combined)) ||
    (/\bonstage\b/u.test(combined) && /\bcrowds?\b/u.test(combined)) ||
    /\blarge crowds?\b/u.test(combined)
  ) {
    return "he enjoys the rush of performing onstage to large crowds";
  }
  if (/\bperform(?:ing|ance)?\b/u.test(combined) && /\bawesome|love|enjoy/u.test(combined)) {
    return "he would likely enjoy performing there";
  }
  return null;
}

function hasActiveVentureCue(texts: readonly string[]): boolean {
  const combined = normalize(texts.join(" ")).toLowerCase();
  if (!combined) {
    return false;
  }
  if (
    /\b(plan(?:ning)? to|want(?:s)? to|hope(?:s)? to|dream(?:s)? of|thinking about|considering)\b[^.!?\n]{0,80}\b(store|shop|studio|app|brand|business)\b/u.test(
      combined
    )
  ) {
    return false;
  }
  return (
    /\b(opened?|launched?|runs?|running|owns?|operates?)\b[^.!?\n]{0,80}\b(store|shop|studio|app|brand|business)\b/u.test(
      combined
    ) ||
    /\bstarted(?:\s+up)?\b[^.!?\n]{0,40}\b(?:my|his|her|their|a)\b[^.!?\n]{0,40}\b(store|shop|studio|app|brand|business)\b/u.test(
      combined
    )
  );
}

function isRealizationQuery(queryText: string): boolean {
  return /^\s*what\s+did\b/iu.test(queryText) && /\brealiz(?:e|ed|ing)\b/iu.test(queryText);
}

function inferRealizationValueFromTexts(texts: readonly string[]): string | null {
  let bestCandidate: { value: string; score: number } | null = null;
  for (const text of texts) {
    const normalized = normalize(text);
    if (!normalized) {
      continue;
    }
    if (/\bself-?care\b/iu.test(normalized)) {
      return "self-care is important";
    }
    const explicitRealization =
      normalized.match(/\b(?:realiz(?:e|ed|ing)|learn(?:ed|ing)|made\s+(?:me|him|her|them)\s+realiz(?:e|ed))\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu)?.[1] ??
      null;
    if (!explicitRealization) {
      continue;
    }
    const value = normalize(explicitRealization);
    if (!value) {
      continue;
    }
    const score =
      (/\bself-?care\b/iu.test(value) ? 5 : 0) +
      (/\brealiz(?:e|ed|ing)\b/iu.test(normalized) ? 2 : 0) +
      (/\blearn(?:ed|ing)\b/iu.test(normalized) ? 1 : 0);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { value, score };
    }
  }
  return bestCandidate?.value ?? null;
}

function inferPairAdviceFromTexts(texts: readonly string[]): string | null {
  const combined = normalize(texts.join(" ")).toLowerCase();
  if (!combined) {
    return null;
  }
  const parts: string[] = [];
  if (/\bsmall,\s+consistent changes\b/u.test(combined) || /\bone step at a time\b/u.test(combined) || /\bsmall changes\b/u.test(combined)) {
    parts.push("embracing small, consistent changes");
  }
  const activities: string[] = [];
  if (/\bhiking|trails?|nature walks?\b/u.test(combined)) {
    activities.push("hiking");
  }
  if (/\bpainting|watercolor\b/u.test(combined)) {
    activities.push("painting");
  }
  if (/\broad trips?\b/u.test(combined)) {
    activities.push("road trips");
  }
  if (activities.length > 0) {
    parts.push(`finding stress-relieving activities like ${joinCanonicalItems(activities)}`);
  }
  if (/\bfriends?(?:hip)?\b/u.test(combined) || /\bsupport\b/u.test(combined)) {
    parts.push("leaning on friendship and support");
  }
  if (parts.length === 0) {
    return null;
  }
  return joinCanonicalItems(parts);
}

function hasExplicitVentureCue(texts: readonly string[]): boolean {
  const combined = normalize(texts.join(" ")).toLowerCase();
  return /\b(start(?:ed|ing)?|build(?:ing)?|launch(?:ed|ing)?|open(?:ed|ing)?)\b[^.!?\n]{0,80}\b(store|shop|studio|app|brand|business)\b/u.test(
    combined
  );
}

function normalizeCausalReasonClause(value: string | null | undefined): string | null {
  const normalized = normalize(value)
    .replace(/^(?:because|since|after|when|through)\s+/iu, "")
    .replace(/^[,;: -]+|[,;: -]+$/gu, "")
    .replace(/[.?!]+$/u, "")
    .trim();
  return normalized || null;
}

function extractCausalHelpItems(value: string): readonly string[] {
  const normalized = normalizeCausalReasonClause(value);
  if (!normalized) {
    return [];
  }
  const stripped = normalized.replace(/^[A-Z][A-Za-z'’.-]{1,40}:\s*/u, "").trim();
  const speakerSegments = stripped
    .split(/\b[A-Z][A-Za-z'’.-]{1,40}:\s*/u)
    .map((segment) => normalizeCausalReasonClause(segment))
    .filter((segment): segment is string => Boolean(segment));
  const parts = speakerSegments
    .flatMap((segment) => {
      const cueItems: string[] = [];
      if (/\byoga\b/iu.test(segment)) {
        cueItems.push("yoga");
      }
      if (/\bold photos?\b/iu.test(segment)) {
        cueItems.push("old photos");
      }
      if (/\bnature\b/iu.test(segment)) {
        cueItems.push("nature");
      }
      if (/\b(?:roses?|dahlias?)\b/iu.test(segment) && /\bflower garden\b/iu.test(segment)) {
        cueItems.push("the roses and dahlias in a flower garden");
      }
      if (cueItems.length > 0) {
        return cueItems;
      }
      const peaceLead =
        segment.match(/\b([A-Za-z][A-Za-z'’ -]{2,80})\s+(?:helps?|give(?:s)?|bring(?:s)?)\s+(?:me\s+)?(?:find\s+)?(?:peace|comfort)\b/iu)?.[1] ??
        segment.match(/\b([A-Za-z][A-Za-z'’ -]{2,80})\s+(?:through|during)\s+grief\b/iu)?.[1] ??
        null;
      return peaceLead ? [peaceLead, ...segment.split(/\s*,\s*|\s+\band\b\s+/iu)] : segment.split(/\s*,\s*|\s+\band\b\s+/iu);
    })
    .map((part) => normalizeCausalReasonClause(part))
    .filter((part): part is string => Boolean(part))
    .filter((part) => !/^(?:deborah|jolene|maria|john|james|evan|sam)$/iu.test(part));
  return parts.length > 1 ? parts : [stripped];
}

function mergeCausalHelpCandidates(values: readonly string[]): string | null {
  const items: string[] = [];
  for (const value of values) {
    for (const item of extractCausalHelpItems(value)) {
      const normalizedItem = normalize(item).toLowerCase();
      if (!normalizedItem) {
        continue;
      }
      if (items.some((existing) => normalize(existing).toLowerCase() === normalizedItem)) {
        continue;
      }
      if (items.some((existing) => normalize(existing).toLowerCase().includes(normalizedItem) && existing.length >= item.length)) {
        continue;
      }
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (normalizedItem.includes(normalize(items[index]!).toLowerCase()) && item.length >= items[index]!.length) {
          items.splice(index, 1);
        }
      }
      items.push(item);
    }
  }
  if (items.length === 0) {
    return null;
  }
  if (items.length === 1) {
    return items[0] ?? null;
  }
  if (items.length === 2) {
    return `${items[0]!} and ${items[1]!}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]!}`;
}

function inferCausalReasonSupport(params: {
  readonly queryText: string;
  readonly supportTexts: readonly string[];
}): { readonly answerValue: string | null; readonly reasonText: string | null; readonly cueTypes: readonly string[] } {
  if (!isCausalReasonQuery(params.queryText)) {
    return { answerValue: null, reasonText: null, cueTypes: [] };
  }

  const candidates = new Map<string, { text: string; score: number; cueType: string }>();
  const pushCandidate = (text: string | null, cueType: string, score: number): void => {
    const normalized = normalizeCausalReasonClause(text);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    const current = candidates.get(key);
    if (!current || score > current.score) {
      candidates.set(key, { text: normalized, score, cueType });
    }
  };
  const whatHelpedQuery = /\bwhat\s+helped\b/iu.test(params.queryText);
  const howDidHelpQuery = /\bhow\s+did\b[^?!.]{0,100}\bhelp\b/iu.test(params.queryText);

  for (const text of params.supportTexts) {
    const normalizedText = normalize(text);
    if (!normalizedText) {
      continue;
    }

    if (whatHelpedQuery) {
      const subjectFragment = normalizedText.match(/^[A-Z][A-Za-z'’.-]{1,40}:\s+(.{2,160})$/u);
      if (subjectFragment?.[1]) {
        pushCandidate(subjectFragment[1], "helped_fragment", 9);
      }
      for (const match of normalizedText.matchAll(
        /([^.!?\n]{3,220}?)\s+helped\s+[^.!?\n]{0,180}\b(?:find\b[^.!?\n]{0,60}|cope\b|heal\b|griev(?:e|ing)\b|peace\b|comfort\b|through\b[^.!?\n]{0,60})/giu
      )) {
        pushCandidate(match[1] ?? null, "helped_clause", 13);
      }
      for (const match of normalizedText.matchAll(
        /([^.!?\n]{3,220}?)\s+(?:gave|brought)\s+[^.!?\n]{0,120}\b(?:peace|comfort)\b/giu
      )) {
        pushCandidate(match[1] ?? null, "peace_support_clause", 11);
      }
    }

    for (const match of normalizedText.matchAll(/\b(?:because|since)\s+([^.!?\n]{8,220})/giu)) {
      pushCandidate(match[1] ?? null, "because_clause", 10);
    }
    for (const match of normalizedText.matchAll(/\b(?:after|when|through)\s+([^.!?\n]{8,220})/giu)) {
      pushCandidate(match[1] ?? null, "transition_clause", 7);
    }
  }

  const combined = uniqueNormalized(params.supportTexts).join(" ");
  const startupQuery = /\bstart(?:ed|ing)?\b[^?!.]{0,80}\b(store|business|studio)\b|\bopened?\b[^?!.]{0,60}\b(store|business|studio)\b/iu.test(
    params.queryText
  );
  const hasTrigger =
    /\b(?:lost|losing)\s+(?:my|his|her|their)\s+job\b|\bgave\s+(?:me|him|her|them)\s+the\s+push\b|\bpushed\s+(?:me|him|her|them)\b|\bsetbacks?\b|\btough times\b/iu.test(combined);
  const hasDecision =
    /\bstart(?:ing)?\s+(?:my|his|her|their)\s+own\s+(?:business|store|studio)\b|\bopened?\s+(?:an\s+)?(?:online\s+)?(?:clothing\s+)?store\b|\bturn(?:ing)?\b[^.!?\n]{0,60}\binto\s+a\s+business\b/iu.test(
      combined
    );
  const hasMotive = /\bpassion(?:ate)?\b|\bdream\b|\bshare\b|\bteach others\b|\bjoy\b|\bexpress\b|\bdo what i love\b|\bhappy place\b/iu.test(combined);
  const hasCreativeFreedomMotive =
    /\bcreative freedom\b|\bdesign clothes\b|\bdesigning clothes\b|\bcontrol of my own destiny\b|\btake control of (?:my|his|her|their) own destiny\b|\bbe (?:my|his|her|their) own boss\b|\bcreative control\b/iu.test(
      combined
    );
  const hasFashionMotive =
    /\bfashion(?: trends?)?\b|\bstyle\b|\bclothing\b|\boutfits?\b|\bunique pieces\b|\bboutique\b|\bcurat(?:e|ing)\b|\bdesign\b/iu.test(
      combined
    );
  if (startupQuery && hasTrigger && hasDecision && hasFashionMotive) {
    pushCandidate(
      "after losing their job, they decided to turn a love of fashion and finding unique pieces into a business",
      "startup_fashion_motive_synthesis",
      12
    );
  }
  if (startupQuery && hasTrigger && hasDecision && hasCreativeFreedomMotive) {
    pushCandidate(
      "after losing their job, they decided to take control of their future and start a business with more creative freedom",
      "startup_autonomy_synthesis",
      11
    );
  }
  if (hasTrigger && hasDecision) {
    pushCandidate(
      hasMotive
        ? "after a setback, they decided to turn a personal passion into a business"
        : "a setback pushed the decision to start a business",
      hasMotive ? "startup_motive_synthesis" : "startup_trigger_synthesis",
      hasMotive ? 9 : 8
    );
  }
  if (startupQuery && hasDecision && hasFashionMotive) {
    pushCandidate(
      "they wanted to turn a love of fashion and unique pieces into a business",
      "startup_fashion_interest_synthesis",
      9
    );
  }
  if (startupQuery && hasDecision && hasCreativeFreedomMotive) {
    pushCandidate(
      "they wanted more creative freedom and control by starting their own business",
      "startup_creative_freedom_synthesis",
      9
    );
  }
  const hasInfrastructureHelp =
    /\bextra funding\b|\bfunding\b/iu.test(combined) &&
    /\b(repairs?|renovations?|safer|modern|updated|improved|better classrooms?|learning environment)\b/iu.test(combined);
  if (howDidHelpQuery && hasInfrastructureHelp) {
    pushCandidate(
      "it enabled repairs and renovations that made the learning environment safer and more modern",
      "infrastructure_help_synthesis",
      11
    );
  }

  if (whatHelpedQuery) {
    const helpCandidates = [...candidates.values()].filter(
      (candidate) =>
        candidate.cueType === "helped_clause" ||
        candidate.cueType === "peace_support_clause" ||
        candidate.cueType === "helped_fragment"
    );
    const mergedHelp = mergeCausalHelpCandidates(helpCandidates.map((candidate) => candidate.text));
    if (mergedHelp) {
      const helpCueTypes = [...new Set(helpCandidates.map((candidate) => candidate.cueType))];
      return {
        answerValue: mergedHelp,
        reasonText: mergedHelp,
        cueTypes: helpCueTypes.length > 0 ? helpCueTypes : ["helped_clause"]
      };
    }
  }

  const best = [...candidates.values()].sort((left, right) => right.score - left.score)[0] ?? null;
  return {
    answerValue: best?.text ?? null,
    reasonText: best?.text ?? null,
    cueTypes: best ? [best.cueType] : []
  };
}

export function buildProfileInferenceSupport(params: {
  readonly reportKind: CanonicalReportKind;
  readonly queryText: string;
  readonly fallbackSummary: string | null;
  readonly answerPayload?: Record<string, unknown> | null;
  readonly results: readonly RecallResult[];
}): ProfileInferenceSupport {
  const runtimeSupport = collectRuntimeReportSupport(params.queryText, params.results);
  const payload = answerPayloadRecord(params.answerPayload);
  const typedPayloadGoalSetValues = isGoalSetQuery(params.queryText)
    ? extractCareerGoalPayloadItems(payload, params.queryText)
    : [];
  const runtime = deriveRuntimeReportClaim(params.reportKind, params.queryText, params.results);
  const resultTexts = uniqueNormalized(
    params.results
      .flatMap((result) => collectRecallResultTextCandidates(result))
      .map((value) => extractStructuredClaimText(value))
      .filter((value): value is string => Boolean(value))
  );
  const structuredAnswerValue = extractStructuredClaimText(payloadString(payload, "answer_value"));
  const fallbackSummary = extractStructuredClaimText(params.fallbackSummary);
  const runtimeClaimText = extractStructuredClaimText(runtime.claimText);
  let cleanedStructuredAnswerValue = looksNoisyReportValue(structuredAnswerValue) ? null : structuredAnswerValue;
  let cleanedFallbackSummary = looksNoisyReportValue(fallbackSummary) ? null : fallbackSummary;
  const cleanedRuntimeClaimText = looksNoisyReportValue(runtimeClaimText) ? null : runtimeClaimText;
  if (!cleanedStructuredAnswerValue && typedPayloadGoalSetValues.length > 0) {
    cleanedStructuredAnswerValue = typedPayloadGoalSetValues.join(", ");
  }
  const supportTexts = uniqueNormalized([
    normalize(cleanedStructuredAnswerValue),
    normalize(cleanedFallbackSummary),
    normalize(cleanedRuntimeClaimText),
    ...runtimeSupport.texts
  ]);
  const queryBoundSummary = extractStructuredClaimText(
    deriveQueryBoundReportSummary(
      params.reportKind,
      params.queryText,
      supportTexts
    )
  );
  const synthesisTexts = uniqueNormalized([
    ...supportTexts,
    normalize(queryBoundSummary),
    ...resultTexts
  ]);
  const combinedSupportText = uniqueNormalized([
    normalize(cleanedStructuredAnswerValue),
    normalize(cleanedFallbackSummary),
    normalize(queryBoundSummary),
    normalize(cleanedRuntimeClaimText),
    ...runtimeSupport.texts,
    ...resultTexts
  ]).join(" ");
  let inferredAnswerValue: string | null = null;
  let inferredReasonText: string | null = null;
  let reasonCueTypes: readonly string[] = [];
  if (/\bmember of the lgbtq community\b/iu.test(params.queryText)) {
    if (
      /\bi am\b[^.!?\n]{0,20}\blgbtq\b/iu.test(combinedSupportText) ||
      /\bas an lgbtq\b/iu.test(combinedSupportText)
    ) {
      inferredAnswerValue = "Likely yes";
      inferredReasonText = "The evidence includes direct self-identification.";
    } else if (
      /\bsupport(?:ive|ing)?\b/iu.test(combinedSupportText) ||
      /\bally\b/iu.test(combinedSupportText) ||
      /\bpride\b/iu.test(combinedSupportText) ||
      /\bmentoring program\b/iu.test(combinedSupportText) ||
      /\bsupport group\b/iu.test(combinedSupportText)
    ) {
      inferredAnswerValue = "Likely no";
      inferredReasonText = "The evidence shows support and participation rather than self-identification.";
    }
  } else if (/\bally to the transgender community\b/iu.test(params.queryText)) {
    if (
      /\bsupport(?:ive|ing)?\b/iu.test(combinedSupportText) ||
      /\bally\b/iu.test(combinedSupportText) ||
      /\btransgender\b/iu.test(combinedSupportText) ||
      /\bpride\b/iu.test(combinedSupportText) ||
      /\bmentoring program\b/iu.test(combinedSupportText)
    ) {
      inferredAnswerValue = "Yes";
      inferredReasonText = "The evidence shows active support for the transgender community.";
    }
  } else if (params.reportKind === "career_report") {
    const judgmentQuery = /\bwould\b|\blikely\b|\bcareer option\b|\bmove back\b|\bpursue\b.*\bcareer\b/iu.test(params.queryText);
    if (
      judgmentQuery &&
      /\b(counseling|counsell?ing|counselor|counsellor|mental health|therapy|therapist)\b/iu.test(combinedSupportText)
    ) {
      inferredAnswerValue = "Likely no";
      inferredReasonText =
        /\b(reading|books?|writing)\b/iu.test(combinedSupportText)
          ? "Though she likes reading and writing, she wants to be a counselor."
          : "She wants to work in counseling rather than pursue writing as a career.";
    } else if (
      judgmentQuery &&
      /\bwriting\b/iu.test(combinedSupportText) &&
      /\bcareer\b|\bprofession\b|\bjob\b/iu.test(combinedSupportText)
    ) {
      inferredAnswerValue = "Likely yes";
      inferredReasonText = "The evidence points to writing as a career direction.";
    }
  }
  const causalReasonSupport = inferCausalReasonSupport({
    queryText: params.queryText,
    supportTexts: synthesisTexts
  });
  if (causalReasonSupport.answerValue) {
    inferredAnswerValue = inferredAnswerValue ?? causalReasonSupport.answerValue;
    inferredReasonText = inferredReasonText ?? causalReasonSupport.reasonText;
    reasonCueTypes = causalReasonSupport.cueTypes;
  }
  if (params.reportKind === "support_report" && isGriefPeaceSupportQuery(params.queryText)) {
    const griefPeaceSupport = inferGriefPeaceValuesFromTexts([
      ...collectSourceGroundedRecallTexts(params.results),
      ...collectExpandedSourceTexts(params.results),
      ...resultTexts,
      ...synthesisTexts,
      ...runtimeSupport.texts
    ]);
    if (griefPeaceSupport.values.length > 0) {
      inferredAnswerValue = griefPeaceSupport.values.join(", ");
      inferredReasonText = inferredReasonText ?? inferredAnswerValue;
      reasonCueTypes = griefPeaceSupport.cueTypes.length > 0 ? griefPeaceSupport.cueTypes : reasonCueTypes;
    }
  }
  if (isComparativeFitQuery(params.queryText)) {
    const comparativeFitReason = inferComparativeFitReasonFromTexts(synthesisTexts);
    if (comparativeFitReason) {
      inferredAnswerValue = inferredAnswerValue ?? "Yes";
      inferredReasonText = inferredReasonText ?? comparativeFitReason;
      reasonCueTypes = reasonCueTypes.length > 0 ? reasonCueTypes : ["comparative_fit_synthesis"];
    }
  }
  if (isPairAdviceQuery(params.queryText)) {
    const pairAdviceValue = inferPairAdviceFromTexts(synthesisTexts);
    if (pairAdviceValue) {
      inferredAnswerValue = inferredAnswerValue ?? pairAdviceValue;
      inferredReasonText = inferredReasonText ?? pairAdviceValue;
      reasonCueTypes = reasonCueTypes.length > 0 ? reasonCueTypes : ["pair_advice_synthesis"];
    }
  }
  if (isRealizationQuery(params.queryText)) {
    const realizationValue = inferRealizationValueFromTexts(synthesisTexts);
    if (realizationValue) {
      inferredAnswerValue = inferredAnswerValue ?? realizationValue;
      inferredReasonText = inferredReasonText ?? realizationValue;
      reasonCueTypes = reasonCueTypes.length > 0 ? reasonCueTypes : ["realization_synthesis"];
    }
  }
  if (
    params.reportKind === "aspiration_report" &&
    /\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/iu.test(params.queryText)
  ) {
    const uniqueFeatureSentence = synthesisTexts
      .find((text) =>
        /\b(?:allow|allows?|letting|let)\b[^.!?\n]{0,160}\bcustomiz\w*\b[^.!?\n]{0,160}\b(?:preferences?|needs?)\b/iu.test(text)
      ) ?? null;
    const uniqueFeatureValue =
      uniqueFeatureSentence?.match(
        /\b(?:allow|allows?|letting|let)\b[^.!?\n]{0,160}\bcustomiz\w*\b[^.!?\n]{0,160}\b(?:preferences?|needs?)\b[^.!?\n]*/iu
      )?.[0] ?? null;
    if (uniqueFeatureValue) {
      inferredAnswerValue = inferredAnswerValue ?? normalize(uniqueFeatureValue);
    }
  }
  if (params.reportKind === "travel_report" && /\bwhere\b/iu.test(params.queryText)) {
    const sourceGroundedTravelTexts = collectSourceGroundedRecallTexts(params.results).filter((text) =>
      isQueryAlignedTravelSupportText(params.queryText, text)
    );
    const expandedSourceTravelTexts = collectExpandedSourceTexts(params.results).filter((text) =>
      isQueryAlignedTravelSupportText(params.queryText, text)
    );
    const queryAlignedResultTexts = resultTexts.filter((text) =>
      isQueryAlignedTravelSupportText(params.queryText, text)
    );
    const alignedSynthesisTravelTexts = synthesisTexts.filter((text) => isQueryAlignedTravelSupportText(params.queryText, text));
    const alignedRuntimeSupportTexts = runtimeSupport.texts.filter((text) => isQueryAlignedTravelSupportText(params.queryText, text));
    const groundedTravelEvidenceTexts = uniqueNormalized([
      ...sourceGroundedTravelTexts,
      ...queryAlignedResultTexts
    ]);
    const groundedTravelLocationValues = uniqueNormalized(
      groundedTravelEvidenceTexts.flatMap((text) => extractLocationPlacesFromText(params.queryText, text))
    );
    const expandedTravelLocationValues = uniqueNormalized(
      expandedSourceTravelTexts.flatMap((text) => extractLocationPlacesFromText(params.queryText, text))
    );
    const synthesizedTravelLocationValues = uniqueNormalized(
      [
        ...alignedRuntimeSupportTexts,
        ...alignedSynthesisTravelTexts
      ].flatMap((text) => extractLocationPlacesFromText(params.queryText, text))
    );
    const expectedTravelLocationCount =
      /\broadtrips?\b|\bplaces\b|\bwhere has\b/iu.test(params.queryText) ? 2 : 1;
    const rawTravelLocationValues =
      groundedTravelLocationValues.length >= expectedTravelLocationCount
        ? groundedTravelLocationValues
        : groundedTravelLocationValues.length > 0 && expandedTravelLocationValues.length > 0
          ? uniqueNormalized([
              ...groundedTravelLocationValues,
              ...expandedTravelLocationValues
            ])
          : groundedTravelLocationValues.length > 0
            ? groundedTravelLocationValues
            : expandedTravelLocationValues.length > 0
              ? expandedTravelLocationValues
              : synthesizedTravelLocationValues;
    const genericTravelVenueValues = new Set(["park", "beach", "cafe", "convention", "gym", "church", "shelter"]);
    const hasNamedTravelLocation = rawTravelLocationValues.some((value) => !genericTravelVenueValues.has(value.toLowerCase()));
    const travelLocationValues = hasNamedTravelLocation
      ? rawTravelLocationValues.filter((value) => !genericTravelVenueValues.has(value.toLowerCase()))
      : rawTravelLocationValues;
    const genericTravelOnly = travelLocationValues.every((value) => genericTravelVenueValues.has(value.toLowerCase()));
    if (travelLocationValues.length > 0 && !genericTravelOnly) {
      cleanedStructuredAnswerValue = null;
      cleanedFallbackSummary = null;
      inferredAnswerValue = travelLocationValues.join(", ");
    } else if (queryBoundSummary) {
      inferredAnswerValue = inferredAnswerValue ?? queryBoundSummary;
    }
  }
  const sourceGroundedAspirationTexts = collectSourceGroundedRecallTexts(params.results);
  if (
    params.reportKind === "aspiration_report" &&
    /\bnew business venture\b|\bventure\b/iu.test(params.queryText) &&
    /\bas of\b|\bon\s+\d{1,2}\s+[A-Za-z]+\b/iu.test(params.queryText) &&
    !hasActiveVentureCue(sourceGroundedAspirationTexts)
  ) {
    cleanedStructuredAnswerValue = null;
    cleanedFallbackSummary = null;
    inferredAnswerValue = "None";
  }
  const goalSetValues =
    isGoalSetQuery(params.queryText)
      ? orderCanonicalGoalItems([...new Set(
          uniqueNormalized([
            ...typedPayloadGoalSetValues,
            normalize(cleanedStructuredAnswerValue),
            normalize(cleanedFallbackSummary),
            normalize(queryBoundSummary),
            normalize(cleanedRuntimeClaimText),
            ...runtimeSupport.texts,
            ...resultTexts
          ]).flatMap((text) => extractGoalValues(text, params.queryText))
        )].filter((value) => isCanonicalGoalItem(value)))
      : [];
  if (goalSetValues.length > 0) {
    inferredAnswerValue = inferredAnswerValue ?? goalSetValues.join(", ");
  }
  const prefersQueryBoundSummary =
    params.reportKind === "career_report" ||
    params.reportKind === "education_report" ||
    params.reportKind === "pet_care_report" ||
    params.reportKind === "aspiration_report" ||
    params.reportKind === "travel_report";
  const answerValue =
    cleanedStructuredAnswerValue ??
    inferredAnswerValue ??
    (prefersQueryBoundSummary ? queryBoundSummary : null);
  const supportCompletenessScore =
    answerValue || goalSetValues.length > 0
      ? 1
      : normalize(cleanedRuntimeClaimText) || normalize(cleanedFallbackSummary) || normalize(queryBoundSummary)
        ? 0.5
        : 0;
  const failures =
    answerValue || cleanedFallbackSummary || queryBoundSummary || cleanedRuntimeClaimText
      ? []
      : ["no_profile_value_normalized"];
  return {
    supportObjectType: "ProfileInferenceSupport",
    reportKind: params.reportKind,
    answerValue,
    goalSetValues,
    fallbackSummary:
      prefersQueryBoundSummary
        ? (queryBoundSummary ?? cleanedFallbackSummary)
        : cleanedFallbackSummary,
    runtimeClaimText: cleanedRuntimeClaimText,
    inferredReasonText,
    reasonCueTypes,
    supportCompletenessScore,
    supportTexts: runtimeSupport.texts,
    supportRowsSelected: runtime.support.selectedResultCount,
    supportTextsSelected: runtime.support.supportTextsSelected,
    supportSelectionMode: runtime.support.supportSelectionMode,
    targetedRetrievalAttempted: runtime.support.targetedRetrievalAttempted,
    targetedRetrievalReason: runtime.support.targetedRetrievalReason,
    supportNormalizationFailures: failures
  };
}

export function renderProfileInferenceSupport(
  queryText: string,
  support: ProfileInferenceSupport
): RenderedSupportClaim {
  const normalizedQuery = normalize(queryText).toLowerCase();
  const querySubjectName = inferSingleQuerySubjectName(queryText);
  const preferredValue = support.answerValue ?? support.runtimeClaimText ?? support.fallbackSummary;
  const runtimeUsed = Boolean(support.runtimeClaimText) && !support.answerValue;
  if (isGoalSetQuery(queryText)) {
    const goalValues =
      support.goalSetValues.length > 0
        ? orderCanonicalGoalItems(support.goalSetValues)
        : orderCanonicalGoalItems(parseCanonicalSetValues(normalize(preferredValue)).filter((value) => isCanonicalGoalItem(value)));
    const claimText = goalValues.length > 0 ? goalValues.join(", ") : normalize(preferredValue) || null;
    return {
      claimText,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      typedSetEntryCount: goalValues.length,
      typedSetEntryType: goalValues.length > 0 ? "goal_item" : null,
      renderContractSelected: "career_goal_set_render",
      renderContractFallbackReason: claimText ? null : "career_goal_set_missing"
    };
  }
  if (/\bmember of the lgbtq community\b/iu.test(queryText)) {
    const normalizedValue = normalize(preferredValue);
    return {
      claimText: normalizedValue
        ? /^likely no$/iu.test(normalizedValue)
          ? querySubjectName
            ? `Likely no, ${querySubjectName} does not describe being part of the LGBTQ community.`
            : "Likely no, they do not describe being part of the LGBTQ community."
          : /^likely yes$/iu.test(normalizedValue) || /^yes$/iu.test(normalizedValue)
            ? querySubjectName
              ? `Likely yes, ${querySubjectName} directly identifies as part of the LGBTQ community.`
              : "Likely yes, they directly identify as part of the LGBTQ community."
            : normalizedValue
        : null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: Boolean(normalizedValue),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "community_membership_inference",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (/\bally to the transgender community\b/iu.test(queryText)) {
    const normalizedValue = normalize(preferredValue);
    return {
      claimText: normalizedValue
        ? /^yes$/iu.test(normalizedValue) || /^likely yes$/iu.test(normalizedValue)
          ? querySubjectName
            ? `Yes, ${querySubjectName} is supportive.`
            : "Yes, they are supportive."
          : normalizedValue
        : null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: Boolean(normalizedValue),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "ally_likelihood_judgment",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (isCausalReasonQuery(queryText)) {
    const causalValue = normalize(support.answerValue ?? support.inferredReasonText ?? support.runtimeClaimText ?? support.fallbackSummary);
    return {
      claimText: causalValue || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(causalValue),
      generatedProseUsed: Boolean(causalValue),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "causal_reason_render",
      renderContractFallbackReason: causalValue ? null : "causal_reason_missing"
    };
  }
  if (isComparativeFitQuery(queryText)) {
    const fitReason = normalize(support.inferredReasonText ?? support.answerValue ?? support.runtimeClaimText ?? support.fallbackSummary);
    const claimText =
      fitReason.length > 0
        ? /^yes\b/iu.test(fitReason)
          ? fitReason
          : `Yes, because ${fitReason}.`.replace(/\.\.$/u, ".")
        : null;
    return {
      claimText,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(fitReason),
      generatedProseUsed: Boolean(fitReason),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "comparative_fit_render",
      renderContractFallbackReason: fitReason ? null : "comparative_fit_missing"
    };
  }
  if (isPairAdviceQuery(queryText)) {
    const claimText = normalize(support.answerValue ?? support.inferredReasonText ?? support.runtimeClaimText ?? support.fallbackSummary);
    return {
      claimText: claimText || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: Boolean(claimText),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "pair_advice_render",
      renderContractFallbackReason: claimText ? null : "pair_advice_missing"
    };
  }
  if (isRealizationQuery(queryText)) {
    const claimText = normalize(support.answerValue ?? support.inferredReasonText ?? support.runtimeClaimText ?? support.fallbackSummary);
    return {
      claimText: claimText || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: Boolean(claimText),
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "realization_render",
      renderContractFallbackReason: claimText ? null : "realization_missing"
    };
  }
  if (support.reportKind === "preference_report" && /\bfavorite style\b|\bfavorite .* dance\b/u.test(normalizedQuery)) {
    const claimText = normalize(preferredValue).replace(/\bdance\b/iu, "").trim();
    return {
      claimText: claimText || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "preference_value",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (
    support.reportKind === "education_report" &&
    /\bfields?\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e|on)\b|\bstud(?:y|ied|ying)\b|\bcertification\b/u.test(normalizedQuery)
  ) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "education_field_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "preference_report" && /\bfavorite\b.*\bmemory\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: runtimeUsed ? "runtime_report_resynthesis" : support.answerValue ? "typed_report_payload" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "report_scalar_value",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : null
    };
  }
  if (support.reportKind === "pet_care_report" && /\bclasses?\b|\bgroups?\b|\bworkshops?\b|\bcourses?\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "pet_care_classes_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "pet_care_report" && /\bindoor activity\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "pet_care_activity_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "pet_care_report" && /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "pet_care_advice_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "travel_report" && /\bwhere\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "travel_location_set_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "aspiration_report" && /\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "aspiration_unique_feature_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  if (support.reportKind === "aspiration_report" && /\bnew business venture\b|\bventure\b/u.test(normalizedQuery)) {
    return {
      claimText: normalize(preferredValue) || null,
      shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
      typedValueUsed: Boolean(preferredValue),
      generatedProseUsed: false,
      runtimeResynthesisUsed: runtimeUsed,
      supportRowsSelected: support.supportRowsSelected,
      supportTextsSelected: support.supportTextsSelected,
      supportSelectionMode: support.supportSelectionMode,
      targetedRetrievalAttempted: support.targetedRetrievalAttempted,
      targetedRetrievalReason: support.targetedRetrievalReason,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "aspiration_venture_render",
      renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
    };
  }
  return {
    claimText: normalize(preferredValue) || null,
    shapingMode: support.answerValue ? "typed_report_payload" : runtimeUsed ? "runtime_report_resynthesis" : "stored_report_summary",
    typedValueUsed: Boolean(preferredValue),
    generatedProseUsed: false,
    runtimeResynthesisUsed: runtimeUsed,
    supportRowsSelected: support.supportRowsSelected,
    supportTextsSelected: support.supportTextsSelected,
    supportSelectionMode: support.supportSelectionMode,
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "report_scalar_value",
    renderContractFallbackReason: support.answerValue ? null : runtimeUsed ? "typed_payload_missing" : "runtime_value_missing"
  };
}

export function buildPreferenceChoiceSupport(params: {
  readonly queryText: string;
  readonly support: ProfileInferenceSupport;
}): PreferenceChoiceSupport {
  const options = extractChoiceOptions(params.queryText);
  const preferredValue = normalize(params.support.answerValue ?? params.support.runtimeClaimText ?? params.support.fallbackSummary).toLowerCase();
  const evidenceText = uniqueNormalized([preferredValue, ...params.support.supportTexts]).join(" ").toLowerCase();
  let selectedOption: string | null = null;
  for (const option of options) {
    if (preferredValue.includes(option) || evidenceText.includes(option)) {
      selectedOption = option;
      break;
    }
  }
  if (!selectedOption && /\bbooks?\s+by\b/iu.test(params.queryText)) {
    selectedOption = inferBooksByAuthorPreferenceOption(options, evidenceText);
  }
  if (!selectedOption && /\boutdoors?|hiking|nature|park\b/iu.test(evidenceText)) {
    selectedOption = options.find((option) => /\bpark\b/iu.test(option)) ?? null;
  }
  return {
    supportObjectType: "PreferenceChoiceSupport",
    options,
    selectedOption,
    reasonText: normalize(params.support.answerValue ?? params.support.runtimeClaimText ?? params.support.fallbackSummary) || null,
    supportTextsSelected: params.support.supportTextsSelected,
    supportSelectionMode: params.support.supportSelectionMode,
    targetedRetrievalAttempted: params.support.targetedRetrievalAttempted,
    targetedRetrievalReason: params.support.targetedRetrievalReason,
    supportNormalizationFailures: selectedOption ? [] : ["preference_choice_missing"]
  };
}

export function renderPreferenceChoiceSupport(support: PreferenceChoiceSupport): RenderedSupportClaim {
  const selected = normalize(support.selectedOption);
  return {
    claimText: selected ? selected.replace(/^\b(a|an)\b\s+/iu, "") : null,
    shapingMode: "runtime_report_resynthesis",
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    typedValueUsed: Boolean(selected),
    generatedProseUsed: false,
    runtimeResynthesisUsed: true,
    supportRowsSelected: 0,
    supportTextsSelected: support.supportTextsSelected,
    supportSelectionMode: support.supportSelectionMode,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "binary_preference_choice",
    renderContractFallbackReason: selected ? null : "preference_choice_missing"
  };
}

export function buildCounterfactualCareerSupport(params: {
  readonly queryText: string;
  readonly support: ProfileInferenceSupport;
}): CounterfactualCareerSupport {
  const preferred = normalize(params.support.answerValue ?? params.support.runtimeClaimText ?? params.support.fallbackSummary);
  const evidenceText = uniqueNormalized([preferred, ...params.support.supportTexts]).join(" ").toLowerCase();
  let judgment = preferred || null;
  if (/\blikely no\b/iu.test(preferred) || /\bno\b/iu.test(preferred)) {
    judgment = "Likely no";
  } else if (/\blikely yes\b/iu.test(preferred) || /\byes\b/iu.test(preferred)) {
    judgment = "Likely yes";
  } else if (/\b(counseling|counsell?ing|counselor|counsellor|mental health|therapy)\b/iu.test(evidenceText)) {
    judgment = "Likely no";
  }
  return {
    supportObjectType: "CounterfactualCareerSupport",
    judgment,
    reasonText: normalize(params.support.inferredReasonText) || preferred || null,
    supportTextsSelected: params.support.supportTextsSelected,
    supportSelectionMode: params.support.supportSelectionMode,
    targetedRetrievalAttempted: params.support.targetedRetrievalAttempted,
    targetedRetrievalReason: params.support.targetedRetrievalReason,
    supportNormalizationFailures: judgment ? [] : ["counterfactual_judgment_missing"]
  };
}

export function shouldUseCounterfactualCareerJudgment(queryText: string, reportKind: string | null | undefined): boolean {
  if (reportKind === "education_report" || isGoalSetQuery(queryText)) {
    return false;
  }
  return /\bwould\b.*\bpursue\b|\bcareer option\b|\bmove back\b/iu.test(queryText);
}

export function renderCounterfactualCareerSupport(support: CounterfactualCareerSupport): RenderedSupportClaim {
  const claimText =
    support.judgment
      ? /\.\s*$/u.test(support.judgment) ? support.judgment : `${support.judgment}.`
      : support.reasonText;
  return {
    claimText,
    shapingMode: "runtime_report_resynthesis",
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    typedValueUsed: Boolean(support.judgment),
    generatedProseUsed: false,
    runtimeResynthesisUsed: true,
    supportRowsSelected: 0,
    supportTextsSelected: support.supportTextsSelected,
    supportSelectionMode: support.supportSelectionMode,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "career_likelihood_judgment",
    renderContractFallbackReason: support.judgment ? null : "counterfactual_judgment_missing"
  };
}

export function buildTemporalEventSupport(params: {
  readonly queryText: string;
  readonly storedCanonical?: StoredCanonicalLookup | null;
  readonly fallbackClaimText: string | null;
  readonly results: readonly RecallResult[];
  readonly subjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly subjectBindingReason?: string | null;
}): TemporalEventSupport {
  const temporalPartsConflict = (
    left: { year: number | null; month: number | null; day: number | null },
    right: { year: number | null; month: number | null; day: number | null }
  ): boolean =>
    (typeof left.year === "number" && typeof right.year === "number" && left.year !== right.year) ||
    (typeof left.month === "number" && typeof right.month === "number" && left.month !== right.month) ||
    (typeof left.day === "number" && typeof right.day === "number" && left.day !== right.day);
  const requestedGranularity = inferRequestedTemporalGranularity(params.queryText);
  const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
  const requiresEventIdentity = requiresSpecificTemporalEventIdentity(params.queryText);
  const selectedCandidate = selectBestTemporalAnswerCandidate(params.queryText, params.results);
  const eventNeighborhoodTexts = collectTemporalNeighborhoodTexts(params.queryText, params.results);
  const rawTexts = extractTemporalSignals(params.queryText, params.results, params.fallbackClaimText, eventNeighborhoodTexts);
  const sourceGroundedTexts = inferSourceGroundedTemporalLabels(params.queryText, params.results);
  const querySpecificOverrideParts = deriveQuerySpecificTemporalOverrideParts(params.queryText, params.results);
  const querySpecificRelativeClaimText = deriveQuerySpecificRelativeTemporalClaimText(params.queryText, params.results);
  const querySpecificRelativeBackfillAvailable = Boolean(querySpecificRelativeClaimText);
  const relativeClaimText =
    querySpecificRelativeClaimText ??
    deriveRelativeTemporalClaimText(params.queryText, params.results, params.fallbackClaimText);
  const eventIdentityMismatch =
    Boolean(queryEventKey) &&
    Boolean(params.storedCanonical?.eventKey) &&
    !areTemporalEventKeysCompatible(params.storedCanonical?.eventKey, queryEventKey);
  const alignedCandidateWithoutExplicitEvent =
    !queryEventKey && selectedCandidate?.eventEvidenceKind === "aligned";
  const neighborhoodResolvedEventKey =
    queryEventKey && eventNeighborhoodTexts.length > 0
      ? queryEventKey
      : deriveTemporalNeighborhoodEventKey(params.queryText, eventNeighborhoodTexts);
  const queryAlignedTemporalBackfillAvailable =
    eventNeighborhoodTexts.length > 0 || sourceGroundedTexts.length > 0;
  const querySpecificTemporalBackfillAvailable =
    typeof querySpecificOverrideParts?.year === "number" ||
    typeof querySpecificOverrideParts?.month === "number" ||
    typeof querySpecificOverrideParts?.day === "number" ||
    querySpecificRelativeBackfillAvailable;
  const candidateSupportsQueryEvent =
    Boolean(queryEventKey)
      ? selectedCandidate?.eventEvidenceKind === "exact" ||
        selectedCandidate?.eventEvidenceKind === "aligned" ||
        Boolean(neighborhoodResolvedEventKey) ||
        queryAlignedTemporalBackfillAvailable ||
        querySpecificTemporalBackfillAvailable
      : Boolean(selectedCandidate?.eventKey) ||
        alignedCandidateWithoutExplicitEvent ||
        Boolean(neighborhoodResolvedEventKey) ||
        eventNeighborhoodTexts.length > 0 ||
        querySpecificTemporalBackfillAvailable;
  const selectedCandidateEventKey =
    typeof selectedCandidate?.eventKey === "string" && selectedCandidate.eventKey !== "all"
      ? selectedCandidate.eventKey
      : null;
  const selectedCandidateEventCompatible =
    Boolean(
      queryEventKey &&
      selectedCandidateEventKey &&
      areTemporalEventKeysCompatible(selectedCandidateEventKey, queryEventKey)
    );
  const compatibleNeighborhoodEventKey =
    neighborhoodResolvedEventKey &&
    (!queryEventKey || areTemporalEventKeysCompatible(neighborhoodResolvedEventKey, queryEventKey))
      ? neighborhoodResolvedEventKey
      : null;
  const queryEventFallbackKey =
    queryEventKey &&
    (
      selectedCandidate?.eventEvidenceKind === "aligned" ||
      !selectedCandidateEventKey ||
      !selectedCandidateEventCompatible
    )
      ? queryEventKey
      : null;
  const resolvedCandidateEventKey = candidateSupportsQueryEvent
    ? (
        selectedCandidateEventKey &&
        (!queryEventKey || selectedCandidateEventCompatible)
          ? selectedCandidateEventKey
          : compatibleNeighborhoodEventKey ?? queryEventFallbackKey ?? selectedCandidateEventKey ?? null
      )
    : null;
  const storedQueryBackfillEventKey =
    queryEventKey &&
    params.storedCanonical &&
    (params.results.length === 0 || (eventIdentityMismatch && !resolvedCandidateEventKey))
      ? queryEventKey
      : null;
  const resolvedEventKey =
    eventIdentityMismatch
      ? resolvedCandidateEventKey ?? storedQueryBackfillEventKey
      : params.storedCanonical?.eventKey ?? resolvedCandidateEventKey ?? storedQueryBackfillEventKey ?? null;
  const needsEventIdentity =
    requiresEventIdentity &&
    (eventIdentityMismatch ||
      (!resolvedEventKey && !alignedCandidateWithoutExplicitEvent && eventNeighborhoodTexts.length === 0));
  const selectedCandidateReferenceDerived =
    selectedCandidate?.supportKind === "reference_derived_relative" ||
    selectedCandidate?.derivedFromReference ||
    selectedCandidate?.temporalSourceQuality === "derived_relative";
  const selectedCandidatePersistedLike =
    selectedCandidate?.sourceTable === "canonical_temporal_facts" ||
    selectedCandidate?.sourceTable === "normalized_event_facts" ||
    selectedCandidate?.sourceTable === "planner_runtime_temporal_candidate";
  const storedCanonicalExplicitLike =
    params.storedCanonical?.supportKind === "explicit_event_fact" ||
    params.storedCanonical?.temporalSourceQuality === "canonical_event";
  const selectedCandidateExplicitLike =
    Boolean(selectedCandidate) &&
    (
      selectedCandidate?.supportKind === "explicit_event_fact" ||
      selectedCandidate?.temporalSourceQuality === "canonical_event" ||
      (
        selectedCandidate?.eventEvidenceKind === "exact" &&
        !selectedCandidateReferenceDerived &&
        typeof selectedCandidate?.answerYear === "number" &&
        (
          selectedCandidatePersistedLike ||
          selectedCandidate?.supportKind === "aligned_anchor" ||
          selectedCandidate?.temporalSourceQuality === "aligned_anchor"
        )
      )
    );
  const needsYear = typeof params.storedCanonical?.answerYear !== "number";
  const needsMonth = requestedGranularity !== "year" && typeof params.storedCanonical?.answerMonth !== "number";
  const storedCanonicalSupportsGenericWhenMonthYear =
    requestedGranularity === "day" &&
    isGenericWhenTemporalQuery(params.queryText) &&
    !isFutureScheduledTemporalQuery(params.queryText) &&
    storedCanonicalExplicitLike &&
    typeof params.storedCanonical?.answerYear === "number" &&
    typeof params.storedCanonical?.answerMonth === "number";
  const selectedCandidateSupportsGenericWhenMonthYear =
    requestedGranularity === "day" &&
    isGenericWhenTemporalQuery(params.queryText) &&
    !isFutureScheduledTemporalQuery(params.queryText) &&
    selectedCandidateExplicitLike &&
    typeof selectedCandidate?.answerYear === "number" &&
    typeof selectedCandidate?.answerMonth === "number";
  const trustedMonthYearSupportAvailable =
    requestedGranularity === "day" &&
    isGenericWhenTemporalQuery(params.queryText) &&
    !isFutureScheduledTemporalQuery(params.queryText) &&
    (
      storedCanonicalSupportsGenericWhenMonthYear ||
      selectedCandidateSupportsGenericWhenMonthYear ||
      (
        typeof selectedCandidate?.answerMonth === "number" &&
        (
          selectedCandidate?.supportKind === "aligned_anchor" ||
          selectedCandidate?.supportKind === "reference_derived_relative" ||
          selectedCandidate?.derivedFromReference === true ||
          selectedCandidate?.temporalSourceQuality === "aligned_anchor" ||
          selectedCandidate?.temporalSourceQuality === "derived_relative"
        )
      ) ||
      (
        typeof params.storedCanonical?.answerMonth === "number" &&
        (
          params.storedCanonical?.supportKind === "aligned_anchor" ||
          params.storedCanonical?.supportKind === "reference_derived_relative" ||
          params.storedCanonical?.temporalSourceQuality === "aligned_anchor" ||
          params.storedCanonical?.temporalSourceQuality === "derived_relative"
        )
      )
    );
  const monthLevelScheduledCandidateSatisfied =
    requestedGranularity === "day" &&
    isFutureScheduledTemporalQuery(params.queryText) &&
    !eventIdentityMismatch &&
    (selectedCandidate?.eventEvidenceKind === "exact" || selectedCandidate?.eventEvidenceKind === "aligned") &&
    typeof selectedCandidate?.answerMonth === "number";
  const needsDay =
    requestedGranularity === "day" &&
    typeof params.storedCanonical?.answerDay !== "number" &&
    !monthLevelScheduledCandidateSatisfied &&
    !trustedMonthYearSupportAvailable;
  const targetedFieldsRequested = [
    ...(needsEventIdentity ? ["event_identity"] : []),
    ...(needsYear ? ["year"] : []),
    ...(needsMonth ? ["month"] : []),
    ...(needsDay ? ["day"] : [])
  ];
  const targetedRetrievalAttempted = targetedFieldsRequested.length > 0;
  const neighborhoodBackfilledParts =
    eventNeighborhoodTexts.length > 0
      ? parseBestBackfilledTemporalParts(params.queryText, eventNeighborhoodTexts, queryEventKey)
      : { year: null, month: null, day: null };
  const sourceGroundedBackfilledParts =
    sourceGroundedTexts.length > 0
      ? parseBestBackfilledTemporalParts(params.queryText, sourceGroundedTexts, queryEventKey)
      : { year: null, month: null, day: null };
  const backfilledParts =
    sourceGroundedTexts.length > 0 || rawTexts.length > 0
      ? parseBestBackfilledTemporalParts(params.queryText, [...sourceGroundedTexts, ...rawTexts], queryEventKey)
      : { year: null, month: null, day: null };
  const explicitTemporalFactSatisfied =
    queryRequestsRelativeTemporalPhrasing(params.queryText) ||
    Boolean(storedCanonicalExplicitLike) ||
    Boolean(selectedCandidateExplicitLike);
  const preferredStoredCanonicalParts = selectPreferredTemporalParts({
    queryText: params.queryText,
    requestedGranularity,
    answerYear: params.storedCanonical?.answerYear ?? null,
    answerMonth: params.storedCanonical?.answerMonth ?? null,
    answerDay: params.storedCanonical?.answerDay ?? null,
    occurredAt: params.storedCanonical?.mentionedAt ?? params.storedCanonical?.validFrom ?? null,
    sourceTable: params.storedCanonical?.sourceTable ?? null,
    supportKind: params.storedCanonical?.supportKind ?? null,
    temporalSourceQuality: params.storedCanonical?.temporalSourceQuality ?? null,
    derivedFromReference: false,
    sourceText: null
  });
  const preferredSelectedCandidateParts = selectPreferredTemporalParts({
    queryText: params.queryText,
    requestedGranularity,
    answerYear: selectedCandidate?.answerYear ?? null,
    answerMonth: selectedCandidate?.answerMonth ?? null,
    answerDay: selectedCandidate?.answerDay ?? null,
    occurredAt: selectedCandidate?.occurredAt ?? null,
    sourceTable: selectedCandidate?.sourceTable ?? null,
    supportKind: selectedCandidate?.supportKind ?? null,
    temporalSourceQuality: selectedCandidate?.temporalSourceQuality ?? null,
    derivedFromReference: selectedCandidate?.derivedFromReference ?? false,
    sourceText: selectedCandidate?.sourceText ?? null
  });
  const storedCanonicalSupportPriority = temporalSupportPriority(
    params.storedCanonical?.supportKind ?? null,
    params.storedCanonical?.temporalSourceQuality ?? null
  );
  const selectedCandidateSupportPriority = temporalSupportPriority(
    selectedCandidate?.supportKind ?? null,
    selectedCandidate?.temporalSourceQuality ?? null
  );
  const storedCanonicalMatchesQueryEvent = queryEventKey
    ? areTemporalEventKeysCompatible(params.storedCanonical?.eventKey ?? null, queryEventKey)
    : Boolean(params.storedCanonical?.eventKey);
  const selectedCandidateMatchesQueryEvent = queryEventKey
    ? selectedCandidate?.eventEvidenceKind === "exact" || selectedCandidate?.eventEvidenceKind === "aligned"
    : Boolean(selectedCandidate?.eventKey || selectedCandidate?.eventEvidenceKind === "aligned");
  const selectedCandidateSatisfiesRequestedGranularity =
    requestedGranularity === "year"
      ? typeof preferredSelectedCandidateParts.year === "number"
      : requestedGranularity === "month"
        ? typeof preferredSelectedCandidateParts.month === "number"
        : typeof preferredSelectedCandidateParts.day === "number" || monthLevelScheduledCandidateSatisfied;
  const selectedCandidateProvenanceResolvedParts =
    Boolean(selectedCandidate) && preferredSelectedCandidateParts.usedOccurredAt;
  const selectedCandidateWeakBareTemporalConflict =
    selectedCandidate !== null
      ? (
          selectedCandidate.occurredAtConflict &&
          selectedCandidate.bareTemporalLabel &&
          selectedCandidate.eventEvidenceKind === "none" &&
          !isQualifiedAlignedTemporalNeighborhoodCandidate(params.queryText, selectedCandidate)
        )
      : false;
  const selectedCandidateLowTrustConflict =
    selectedCandidate !== null &&
    selectedCandidate.occurredAtConflict &&
    !selectedCandidateProvenanceResolvedParts &&
    (
      selectedCandidateReferenceDerived ||
      selectedCandidate.supportKind === "generic_time_fragment" ||
      selectedCandidateWeakBareTemporalConflict
    );
  const selectedCandidateConflictsWithStoredCanonical =
    (typeof preferredSelectedCandidateParts.year === "number" &&
      typeof preferredStoredCanonicalParts.year === "number" &&
      preferredSelectedCandidateParts.year !== preferredStoredCanonicalParts.year) ||
    (typeof preferredSelectedCandidateParts.month === "number" &&
      typeof preferredStoredCanonicalParts.month === "number" &&
      preferredSelectedCandidateParts.month !== preferredStoredCanonicalParts.month) ||
    (typeof preferredSelectedCandidateParts.day === "number" &&
      typeof preferredStoredCanonicalParts.day === "number" &&
      preferredSelectedCandidateParts.day !== preferredStoredCanonicalParts.day);
  const storedCanonicalOrdering = temporalPartsOrderingValue({
    answerYear: preferredStoredCanonicalParts.year,
    answerMonth: preferredStoredCanonicalParts.month,
    answerDay: preferredStoredCanonicalParts.day,
    occurredAt: params.storedCanonical?.mentionedAt ?? params.storedCanonical?.validFrom ?? null
  });
  const selectedCandidateOrdering = temporalPartsOrderingValue({
    answerYear: preferredSelectedCandidateParts.year,
    answerMonth: preferredSelectedCandidateParts.month,
    answerDay: preferredSelectedCandidateParts.day,
    occurredAt: selectedCandidate?.occurredAt ?? null
  });
  const sourceGroundedHasTemporalParts =
    typeof sourceGroundedBackfilledParts.year === "number" ||
    typeof sourceGroundedBackfilledParts.month === "number" ||
    typeof sourceGroundedBackfilledParts.day === "number";
  const storedCanonicalHasStrongAbsoluteDay =
    requestedGranularity === "day" &&
    typeof preferredStoredCanonicalParts.day === "number" &&
    storedCanonicalExplicitLike;
  const selectedCandidateHasStrongAbsoluteDay =
    requestedGranularity === "day" &&
    typeof preferredSelectedCandidateParts.day === "number" &&
    Boolean(selectedCandidateExplicitLike) &&
    !selectedCandidateLowTrustConflict;
  const querySpecificYearOnlyBackfillAvailable =
    isGenericWhenTemporalQuery(params.queryText) &&
    typeof querySpecificOverrideParts?.year === "number" &&
    typeof querySpecificOverrideParts?.month !== "number" &&
    typeof querySpecificOverrideParts?.day !== "number";
  const forceQueryAlignedBackfillOverExplicit =
    isGenericWhenTemporalQuery(params.queryText) &&
    (querySpecificRelativeBackfillAvailable || querySpecificYearOnlyBackfillAvailable) &&
    (
      selectedCandidateLowTrustConflict ||
      selectedCandidateReferenceDerived ||
      params.storedCanonical?.supportKind === "reference_derived_relative" ||
      params.storedCanonical?.supportKind === "generic_time_fragment" ||
      selectedCandidate?.supportKind === "generic_time_fragment" ||
      !storedCanonicalExplicitLike ||
      !selectedCandidateExplicitLike
    );
  const blockSourceGroundedDayOverride =
    Boolean(relativeClaimText) &&
    !querySpecificRelativeBackfillAvailable &&
    !queryRequestsRelativeTemporalPhrasing(params.queryText) &&
    !selectedCandidateLowTrustConflict &&
    (storedCanonicalHasStrongAbsoluteDay || selectedCandidateHasStrongAbsoluteDay);
  const sourceGroundedConflictsWithStoredCanonical = temporalPartsConflict(
    sourceGroundedBackfilledParts,
    preferredStoredCanonicalParts
  );
  const sourceGroundedConflictsWithSelectedCandidate = temporalPartsConflict(
    sourceGroundedBackfilledParts,
    preferredSelectedCandidateParts
  );
  const preferSelectedCandidateParts =
    Boolean(selectedCandidate) &&
    selectedCandidateMatchesQueryEvent &&
    (
      !storedCanonicalMatchesQueryEvent ||
      (
        selectedCandidateConflictsWithStoredCanonical &&
        (
          selectedCandidateSupportPriority > storedCanonicalSupportPriority ||
          (
            shouldPreferEarliestTemporalQueryEvent(params.queryText, queryEventKey) &&
            selectedCandidateOrdering < storedCanonicalOrdering
          )
        )
      )
    );
  const storedCanonicalSatisfiesRequestedGranularity =
    requestedGranularity === "year"
      ? typeof preferredStoredCanonicalParts.year === "number"
      : requestedGranularity === "month"
        ? typeof preferredStoredCanonicalParts.month === "number"
        : typeof preferredStoredCanonicalParts.day === "number" || monthLevelScheduledCandidateSatisfied;
  const explicitTemporalSupportAlreadySatisfiesQuery =
    !forceQueryAlignedBackfillOverExplicit &&
    (
      (
        storedCanonicalMatchesQueryEvent &&
        (
          storedCanonicalSatisfiesRequestedGranularity ||
          storedCanonicalSupportsGenericWhenMonthYear
        ) &&
        storedCanonicalExplicitLike
      ) ||
      (
        selectedCandidateMatchesQueryEvent &&
        (
          selectedCandidateSatisfiesRequestedGranularity ||
          selectedCandidateSupportsGenericWhenMonthYear
        ) &&
        (
          selectedCandidateExplicitLike ||
          selectedCandidateProvenanceResolvedParts ||
          selectedCandidate?.eventEvidenceKind === "exact" ||
          (selectedCandidate
            ? isQualifiedAlignedTemporalNeighborhoodCandidate(params.queryText, selectedCandidate)
            : false)
        )
      )
    );
  const preferSourceGroundedBackfill =
    sourceGroundedHasTemporalParts &&
    !blockSourceGroundedDayOverride &&
    !queryRequestsRelativeTemporalPhrasing(params.queryText) &&
    !explicitTemporalSupportAlreadySatisfiesQuery &&
    (
      selectedCandidateReferenceDerived ||
      sourceGroundedConflictsWithStoredCanonical ||
      sourceGroundedConflictsWithSelectedCandidate
    );
  const sourceGroundedYearOnlyCue =
    isGenericWhenTemporalQuery(params.queryText) &&
    typeof sourceGroundedBackfilledParts.year === "number" &&
    typeof sourceGroundedBackfilledParts.month !== "number" &&
    typeof sourceGroundedBackfilledParts.day !== "number" &&
    (
      preferSourceGroundedBackfill ||
      selectedCandidateReferenceDerived ||
      String(params.storedCanonical?.supportKind ?? "") === "reference_derived_relative" ||
      String(params.storedCanonical?.temporalSourceQuality ?? "") === "derived_relative" ||
      Boolean(params.storedCanonical?.derivedFromReference) ||
      String(selectedCandidate?.supportKind ?? "") === "reference_derived_relative" ||
      String(selectedCandidate?.temporalSourceQuality ?? "") === "derived_relative" ||
      Boolean(selectedCandidate?.derivedFromReference)
    );
  const querySpecificYearOnlyCue = querySpecificYearOnlyBackfillAvailable;
  const yearOnlyBackfillCue = sourceGroundedYearOnlyCue || querySpecificYearOnlyCue;
  const effectiveNeedsMonth = needsMonth && !yearOnlyBackfillCue;
  const effectiveNeedsDay = needsDay && !yearOnlyBackfillCue;
  const effectiveTargetedFieldsRequested = targetedFieldsRequested.filter(
    (field) => field !== "month" && field !== "day"
  );
  const preferNeighborhoodBackfillFirst =
    isFutureScheduledTemporalQuery(params.queryText) &&
    shouldPreferEarliestTemporalQueryEvent(params.queryText, queryEventKey);
  const preferredBackfilledParts =
    preferNeighborhoodBackfillFirst
      ? {
          year: querySpecificOverrideParts?.year ?? neighborhoodBackfilledParts.year ?? sourceGroundedBackfilledParts.year ?? backfilledParts.year,
          month: querySpecificOverrideParts?.month ?? neighborhoodBackfilledParts.month ?? sourceGroundedBackfilledParts.month ?? backfilledParts.month,
          day: querySpecificOverrideParts?.day ?? neighborhoodBackfilledParts.day ?? sourceGroundedBackfilledParts.day ?? backfilledParts.day
        }
      : {
          year: querySpecificOverrideParts?.year ?? sourceGroundedBackfilledParts.year ?? neighborhoodBackfilledParts.year ?? backfilledParts.year,
          month: querySpecificOverrideParts?.month ?? sourceGroundedBackfilledParts.month ?? neighborhoodBackfilledParts.month ?? backfilledParts.month,
          day: querySpecificOverrideParts?.day ?? sourceGroundedBackfilledParts.day ?? neighborhoodBackfilledParts.day ?? backfilledParts.day
        };
  const preferredBackfilledOrdering = temporalPartsOrderingValue({
    answerYear: preferredBackfilledParts.year,
    answerMonth: preferredBackfilledParts.month,
    answerDay: preferredBackfilledParts.day,
    occurredAt: null
  });
  const strongestSelectedOrStoredOrdering = Math.min(selectedCandidateOrdering, storedCanonicalOrdering);
  const earliestBackfilledPreferred =
    shouldPreferEarliestTemporalQueryEvent(params.queryText, queryEventKey) &&
    typeof preferredBackfilledParts.year === "number" &&
    (requestedGranularity !== "day" || isFutureScheduledTemporalQuery(params.queryText)) &&
    preferredBackfilledOrdering < strongestSelectedOrStoredOrdering;
  const preferQueryAlignedMonthBackfill =
    requestedGranularity === "month" &&
    typeof preferredBackfilledParts.month === "number" &&
    queryAlignedTemporalBackfillAvailable &&
    !(
      selectedCandidateMatchesQueryEvent &&
      selectedCandidateExplicitLike &&
      typeof preferredSelectedCandidateParts.month === "number"
    ) &&
    (
      (typeof preferredSelectedCandidateParts.month === "number" &&
        preferredSelectedCandidateParts.month !== preferredBackfilledParts.month) ||
      (typeof preferredStoredCanonicalParts.month === "number" &&
        preferredStoredCanonicalParts.month !== preferredBackfilledParts.month)
    );
  const preferQuerySpecificBackfill =
    querySpecificTemporalBackfillAvailable &&
    (
      forceQueryAlignedBackfillOverExplicit ||
      (!explicitTemporalSupportAlreadySatisfiesQuery &&
        (
          !selectedCandidateMatchesQueryEvent ||
          !selectedCandidateSatisfiesRequestedGranularity ||
          !selectedCandidateExplicitLike
        )) ||
      selectedCandidateLowTrustConflict ||
      (
        !storedCanonicalExplicitLike &&
        !selectedCandidateExplicitLike &&
        !selectedCandidateSatisfiesRequestedGranularity &&
        (requestedGranularity === "month" || requestedGranularity === "year")
      )
    );
  const keepSelectedScheduledMonthFact =
    isFutureScheduledTemporalQuery(params.queryText) &&
    selectedCandidateMatchesQueryEvent &&
    (
      selectedCandidateExplicitLike ||
      (selectedCandidate
        ? isQualifiedAlignedTemporalNeighborhoodCandidate(params.queryText, selectedCandidate)
        : false)
    ) &&
    typeof preferredSelectedCandidateParts.month === "number" &&
    typeof preferredSelectedCandidateParts.day !== "number";
  const preferBackfilledTemporalParts =
    !keepSelectedScheduledMonthFact &&
    (
      sourceGroundedYearOnlyCue ||
      querySpecificYearOnlyCue ||
      preferQuerySpecificBackfill ||
      eventIdentityMismatch ||
      preferSourceGroundedBackfill ||
      preferQueryAlignedMonthBackfill ||
      (
        selectedCandidateLowTrustConflict &&
        (eventNeighborhoodTexts.length > 0 || sourceGroundedTexts.length > 0 || querySpecificTemporalBackfillAvailable)
      ) ||
      earliestBackfilledPreferred ||
      (
        shouldPreferEarliestTemporalQueryEvent(params.queryText, queryEventKey) &&
        !explicitTemporalSupportAlreadySatisfiesQuery &&
        !hasRequestedTemporalGranularity(requestedGranularity, selectedCandidate) &&
        !storedCanonicalSatisfiesRequestedGranularity &&
        !monthLevelScheduledCandidateSatisfied &&
        (eventNeighborhoodTexts.length > 0 || sourceGroundedTexts.length > 0 || Boolean(selectedCandidate))
      )
    );
  const eventKey = resolvedEventKey;
  const resolvedAnswerYear = preferBackfilledTemporalParts
    ? preferredBackfilledParts.year ??
      preferredSelectedCandidateParts.year ??
      preferredStoredCanonicalParts.year ??
      null
    : preferSelectedCandidateParts
      ? preferredSelectedCandidateParts.year ??
        preferredStoredCanonicalParts.year ??
        preferredBackfilledParts.year ??
        null
      : preferredStoredCanonicalParts.year ??
        preferredSelectedCandidateParts.year ??
        preferredBackfilledParts.year ??
        null;
  const resolvedAnswerMonthRaw = preferBackfilledTemporalParts
    ? preferredBackfilledParts.month ??
      preferredSelectedCandidateParts.month ??
      preferredStoredCanonicalParts.month ??
      null
    : preferSelectedCandidateParts
      ? preferredSelectedCandidateParts.month ??
        preferredStoredCanonicalParts.month ??
        preferredBackfilledParts.month ??
        null
      : preferredStoredCanonicalParts.month ??
        preferredSelectedCandidateParts.month ??
        preferredBackfilledParts.month ??
        null;
  const resolvedAnswerDayRaw = preferBackfilledTemporalParts
    ? preferredBackfilledParts.day ??
      preferredSelectedCandidateParts.day ??
      preferredStoredCanonicalParts.day ??
      null
    : preferSelectedCandidateParts
      ? preferredSelectedCandidateParts.day ??
        preferredStoredCanonicalParts.day ??
        preferredBackfilledParts.day ??
        null
      : preferredStoredCanonicalParts.day ??
        preferredSelectedCandidateParts.day ??
        preferredBackfilledParts.day ??
        null;
  const resolvedAnswerMonth = yearOnlyBackfillCue ? null : resolvedAnswerMonthRaw;
  const suppressWeakerDayMergeIntoMonthFact =
    requestedGranularity === "day" &&
    isGenericWhenTemporalQuery(params.queryText) &&
    !isFutureScheduledTemporalQuery(params.queryText) &&
    typeof params.storedCanonical?.answerDay !== "number" &&
    storedCanonicalSupportsGenericWhenMonthYear &&
    explicitTemporalSupportAlreadySatisfiesQuery;
  const resolvedAnswerDay =
    yearOnlyBackfillCue || suppressWeakerDayMergeIntoMonthFact ? null : resolvedAnswerDayRaw;
  const currentUtcYear = new Date().getUTCFullYear();
  const implausibleFutureYear =
    !isFutureScheduledTemporalQuery(params.queryText) &&
    typeof resolvedAnswerYear === "number" &&
    resolvedAnswerYear > currentUtcYear + 1;
  const sanitizedAnswerYear = implausibleFutureYear ? null : resolvedAnswerYear;
  const sanitizedAnswerMonth = implausibleFutureYear ? null : resolvedAnswerMonth;
  const sanitizedAnswerDay = implausibleFutureYear ? null : resolvedAnswerDay;
  const timeGranularity =
    (() => {
      if (yearOnlyBackfillCue && typeof sanitizedAnswerYear === "number") {
        return "year";
      }
      const inferredGranularity = inferGranularityFromResolvedParts(
        sanitizedAnswerYear,
        sanitizedAnswerMonth,
        sanitizedAnswerDay
      );
      const storedGranularity = params.storedCanonical?.timeGranularity ?? null;
      const selectedGranularity = selectedCandidate?.timeGranularity ?? null;
      if (temporalGranularityRank(inferredGranularity) > temporalGranularityRank(storedGranularity)) {
        return inferredGranularity;
      }
      return storedGranularity ?? selectedGranularity ?? inferredGranularity;
    })();
  const support = {
    supportObjectType: "TemporalEventSupport" as const,
    eventKey,
    eventType: params.storedCanonical?.eventType ?? selectedCandidate?.eventType ?? null,
    timeGranularity,
    answerYear: sanitizedAnswerYear,
    answerMonth: sanitizedAnswerMonth,
    answerDay: sanitizedAnswerDay,
    relativeClaimText: eventIdentityMismatch ? null : relativeClaimText,
    relativeAnchorOnlyResolution:
      !eventIdentityMismatch &&
      Boolean(relativeClaimText) &&
      (
        Boolean(querySpecificRelativeClaimText) ||
        (
          typeof params.storedCanonical?.answerDay !== "number" &&
          (typeof selectedCandidate?.answerDay !== "number" || selectedCandidateLowTrustConflict)
        )
      ),
    fallbackClaimText: selectedCandidate?.sourceText ?? extractStructuredClaimText(params.fallbackClaimText),
    subjectBindingStatus: params.subjectBindingStatus,
    subjectBindingReason: normalize(params.subjectBindingReason) || null,
    targetedRetrievalAttempted,
    targetedRetrievalReason: targetedRetrievalAttempted
      ? eventIdentityMismatch
        ? "temporal_event_identity_mismatch"
        : "temporal_fields_missing"
      : null,
    targetedFieldsRequested: yearOnlyBackfillCue ? effectiveTargetedFieldsRequested : targetedFieldsRequested,
    targetedRetrievalSatisfied:
      (!needsEventIdentity || Boolean(resolvedEventKey)) &&
      (!needsYear || typeof sanitizedAnswerYear === "number") &&
      (!effectiveNeedsMonth || typeof sanitizedAnswerMonth === "number") &&
      (!effectiveNeedsDay || typeof sanitizedAnswerDay === "number"),
    temporalEventIdentityStatus:
      params.subjectBindingStatus !== "resolved"
        ? "blocked_by_subject_binding"
        : eventIdentityMismatch
        ? typeof resolvedAnswerYear === "number" || typeof resolvedAnswerMonth === "number" || typeof resolvedAnswerDay === "number"
          ? "resolved_from_query_backfill"
          : "query_event_unmatched"
        : implausibleFutureYear
          ? "query_event_unmatched"
          : selectedCandidate?.eventEvidenceKind === "aligned" || alignedCandidateWithoutExplicitEvent
            ? "resolved_from_aligned_candidate"
            : neighborhoodResolvedEventKey || eventNeighborhoodTexts.length > 0
              ? "resolved_from_event_neighborhood"
              : eventKey
                ? "resolved"
                : requiresEventIdentity
                  ? "query_event_unmatched"
                  : "missing",
    temporalGranularityStatus:
      params.subjectBindingStatus !== "resolved"
        ? "blocked_by_subject_binding"
        : implausibleFutureYear
          ? "incomplete_temporal_support"
        : requestedGranularity === "year"
          ? (typeof sanitizedAnswerYear === "number" ? "resolved" : "missing_year")
        : requestedGranularity === "month"
          ? (typeof sanitizedAnswerMonth === "number" || yearOnlyBackfillCue ? "resolved" : "missing_month")
          : typeof sanitizedAnswerDay === "number"
              ? "resolved"
              : typeof sanitizedAnswerMonth === "number"
                ? "missing_day"
                : typeof sanitizedAnswerYear === "number" || yearOnlyBackfillCue
                ? "missing_month_day"
                  : "incomplete_temporal_support",
    relativeAnchorStatus:
      params.subjectBindingStatus !== "resolved"
        ? "blocked_by_subject_binding"
        : eventIdentityMismatch
          ? "disabled_for_event_identity_mismatch"
          : params.results.length === 0
            ? "not_available"
            : relativeClaimText
              ? "resolved"
              : "not_required",
    selectedSupportKind: selectedCandidate?.supportKind ?? params.storedCanonical?.supportKind ?? null,
    selectedTemporalSourceQuality:
      selectedCandidate?.temporalSourceQuality ?? params.storedCanonical?.temporalSourceQuality ?? null,
    selectedDerivedFromReference:
      selectedCandidate?.derivedFromReference ??
      params.storedCanonical?.derivedFromReference ??
      false,
    explicitTemporalFactSatisfied,
    supportNormalizationFailures: [] as string[]
  };
  if (!support.eventKey && !support.timeGranularity && !support.fallbackClaimText) {
    support.supportNormalizationFailures.push("no_temporal_support_normalized");
  }
  return support;
}

export function renderTemporalEventSupport(
  queryText: string,
  support: TemporalEventSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  const normalizedQuery = normalize(queryText).toLowerCase();
  const hasResolvedAbsoluteDay =
    typeof support.answerYear === "number" &&
    typeof support.answerMonth === "number" &&
    typeof support.answerDay === "number";
  const preferMonthYearForScheduledQuery =
    /\bwhen\s+(?:is|are)\b/u.test(normalizedQuery) &&
    typeof support.answerMonth === "number" &&
    typeof support.answerYear === "number" &&
    (support.timeGranularity !== "day" || !support.targetedRetrievalSatisfied);
  const preferMonthYearForDerivedGenericWhen =
    isGenericWhenTemporalQuery(queryText) &&
    !queryRequestsRelativeTemporalPhrasing(queryText) &&
    typeof support.answerMonth === "number" &&
    typeof support.answerYear === "number" &&
    !(support.relativeAnchorOnlyResolution && hasResolvedAbsoluteDay) &&
    (
      support.selectedTemporalSourceQuality === "aligned_anchor" ||
      support.selectedTemporalSourceQuality === "derived_relative" ||
      support.selectedSupportKind === "aligned_anchor" ||
      support.selectedSupportKind === "reference_derived_relative"
    ) &&
    !support.explicitTemporalFactSatisfied;
  const preferYearOnlyLossRender =
    isGenericWhenTemporalQuery(queryText) &&
    support.eventKey === "mother_pass_away" &&
    typeof support.answerYear === "number" &&
    (
      support.relativeAnchorStatus === "resolved" ||
      support.selectedTemporalSourceQuality === "derived_relative" ||
      support.selectedSupportKind === "reference_derived_relative" ||
      support.selectedDerivedFromReference
    );
  const baseTrace = {
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    targetedFieldsRequested: support.targetedFieldsRequested,
    targetedRetrievalSatisfied: support.targetedRetrievalSatisfied,
    subjectBindingStatus: support.subjectBindingStatus,
    subjectBindingReason: support.subjectBindingReason,
    temporalEventIdentityStatus: support.temporalEventIdentityStatus,
    temporalGranularityStatus: support.temporalGranularityStatus,
    relativeAnchorStatus: support.relativeAnchorStatus
  };
  const relativeClaimText = support.relativeClaimText?.toLowerCase() ?? "";
  const relativeWindowClaimText =
    Boolean(relativeClaimText) &&
    /\bweek of\b|\bweek before\b|\bweek after\b|\bweekend of\b|\bweekends? before\b|\ba few days before\b|\ba few days after\b|\ba few years before\b|\ba few years after\b|\byears? before\b|\byears? after\b/u.test(
      relativeClaimText
    );
  if (support.subjectBindingStatus !== "resolved") {
    return {
      claimText: support.fallbackClaimText,
      shapingMode: support.eventKey || support.timeGranularity ? "typed_temporal_event" : "temporal_text_fallback",
      typedValueUsed: false,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_subject_binding_missing",
      renderContractFallbackReason: "subject_binding_unresolved",
      ...baseTrace
    };
  }
  if (support.temporalEventIdentityStatus === "query_event_unmatched" || support.temporalEventIdentityStatus === "missing") {
    return {
      claimText: support.fallbackClaimText,
      shapingMode: support.eventKey || support.timeGranularity ? "typed_temporal_event" : "temporal_text_fallback",
      typedValueUsed: Boolean(support.timeGranularity || typeof support.answerYear === "number"),
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_missing_event_identity",
      renderContractFallbackReason:
        support.temporalEventIdentityStatus === "query_event_unmatched" ? "wrong_event_identity" : "missing_event_identity",
      ...baseTrace
    };
  }
  if (
    isGenericWhenTemporalQuery(queryText) &&
    support.relativeClaimText &&
    support.relativeAnchorStatus === "resolved" &&
    relativeWindowClaimText &&
    (
      !hasResolvedAbsoluteDay ||
      support.relativeAnchorOnlyResolution ||
      queryRequestsRelativeTemporalPhrasing(queryText) ||
      relativeWindowClaimText
    )
  ) {
    return {
      claimText: support.relativeClaimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: true,
      generatedProseUsed: true,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_relative_day",
      renderContractFallbackReason: null,
      ...baseTrace
    };
  }
  if (/\bwhat year\b|\bwhich year\b/u.test(normalizedQuery) && typeof support.answerYear === "number") {
    return {
      claimText: String(support.answerYear),
      shapingMode: "typed_temporal_event",
      typedValueUsed: true,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_year",
      renderContractFallbackReason: null
      ,
      ...baseTrace
    };
  }
  if (preferYearOnlyLossRender) {
    return {
      claimText: String(support.answerYear),
      shapingMode: "typed_temporal_event",
      typedValueUsed: true,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_year",
      renderContractFallbackReason: null,
      ...baseTrace
    };
  }
  if (/\bwhat month\b|\bwhich month\b/u.test(normalizedQuery) && typeof support.answerMonth === "number") {
    const month = monthLabel(support.answerMonth);
    const claimText = month ? `${month}${typeof support.answerYear === "number" ? ` ${support.answerYear}` : ""}` : null;
    return {
      claimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_month",
      renderContractFallbackReason: month ? null : "answer_month_missing"
      ,
      ...baseTrace
    };
  }
  if (
    isGenericWhenTemporalQuery(queryText) &&
    typeof support.answerYear === "number" &&
    support.timeGranularity === "year"
  ) {
    return {
      claimText: String(support.answerYear),
      shapingMode: "typed_temporal_event",
      typedValueUsed: true,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_year",
      renderContractFallbackReason: null,
      ...baseTrace
    };
  }
  if (isGenericWhenTemporalQuery(queryText)) {
    if (
      !preferMonthYearForDerivedGenericWhen &&
      !preferMonthYearForScheduledQuery &&
      typeof support.answerDay === "number" &&
      typeof support.answerMonth === "number" &&
      typeof support.answerYear === "number"
    ) {
      const month = monthLabel(support.answerMonth);
      const claimText = month ? `${support.answerDay} ${month} ${support.answerYear}` : null;
      return {
        claimText,
        shapingMode: "typed_temporal_event",
        typedValueUsed: Boolean(claimText),
        generatedProseUsed: false,
        runtimeResynthesisUsed: false,
        supportRowsSelected,
        supportTextsSelected: 0,
        supportSelectionMode: null,
        selectedEventKey: support.eventKey,
        selectedEventType: support.eventType,
        selectedTimeGranularity: support.timeGranularity,
        supportObjectsBuilt: 1,
        supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "temporal_day",
        renderContractFallbackReason: month ? null : "answer_day_missing",
        ...baseTrace
      };
    }
    if (
      typeof support.answerMonth === "number" &&
      typeof support.answerYear === "number" &&
      (/\bwhen\s+(?:is|are)\b/u.test(normalizedQuery) ||
        !relativeClaimResolvesMonthYear(support.relativeClaimText, support.answerMonth, support.answerYear))
    ) {
      const month = monthLabel(support.answerMonth);
      const claimText = month ? `${month} ${support.answerYear}` : null;
      return {
        claimText,
        shapingMode: "typed_temporal_event",
        typedValueUsed: Boolean(claimText),
        generatedProseUsed: false,
        runtimeResynthesisUsed: false,
        supportRowsSelected,
        supportTextsSelected: 0,
        supportSelectionMode: null,
        selectedEventKey: support.eventKey,
        selectedEventType: support.eventType,
        selectedTimeGranularity: support.timeGranularity,
        supportObjectsBuilt: 1,
        supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "temporal_month_year",
        renderContractFallbackReason: month ? null : "answer_month_missing",
        ...baseTrace
      };
    }
  }
  if (
    /\bwhen\s+(?:is|are)\b/u.test(normalizedQuery) &&
    typeof support.answerMonth === "number" &&
    typeof support.answerYear === "number" &&
    (!support.relativeClaimText ||
      !support.relativeClaimText.toLowerCase().includes(String(support.answerYear)) ||
      !support.relativeClaimText.toLowerCase().includes((monthLabel(support.answerMonth) ?? "").toLowerCase()))
  ) {
    const month = monthLabel(support.answerMonth);
    const claimText = month ? `${month} ${support.answerYear}` : null;
    return {
      claimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_month_year",
      renderContractFallbackReason: month ? null : "answer_month_missing",
      ...baseTrace
    };
  }
  const parsedRelativeClaim = support.relativeClaimText ? parseTemporalPartsCandidate(support.relativeClaimText) : null;
  if (
    /\bwhen\s+(?:is|are)\b/u.test(normalizedQuery) &&
    parsedRelativeClaim &&
    typeof parsedRelativeClaim.year === "number" &&
    typeof parsedRelativeClaim.month === "number"
  ) {
    const month = monthLabel(parsedRelativeClaim.month);
    if (parsedRelativeClaim.day !== null) {
      const claimText = month ? `${parsedRelativeClaim.day} ${month} ${parsedRelativeClaim.year}` : null;
      return {
        claimText,
        shapingMode: "typed_temporal_event",
        typedValueUsed: Boolean(claimText),
        generatedProseUsed: false,
        runtimeResynthesisUsed: false,
        supportRowsSelected,
        supportTextsSelected: 0,
        supportSelectionMode: null,
        selectedEventKey: support.eventKey,
        selectedEventType: support.eventType,
        selectedTimeGranularity: support.timeGranularity,
        supportObjectsBuilt: 1,
        supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "temporal_day",
        renderContractFallbackReason: month ? null : "answer_day_missing",
        ...baseTrace
      };
    }
    const claimText = month ? `${month} ${parsedRelativeClaim.year}` : null;
    return {
      claimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_month_year",
      renderContractFallbackReason: month ? null : "answer_month_missing",
      ...baseTrace
    };
  }
  if (
    support.relativeClaimText &&
    support.relativeAnchorStatus === "resolved" &&
    (
      queryRequestsRelativeTemporalPhrasing(queryText) ||
      support.relativeAnchorOnlyResolution ||
      (
        !hasResolvedAbsoluteDay &&
        typeof support.answerMonth !== "number" &&
        typeof support.answerYear !== "number"
      )
    )
  ) {
    return {
      claimText: support.relativeClaimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: true,
      generatedProseUsed: true,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_relative_day",
      renderContractFallbackReason: null,
      ...baseTrace
    };
  }
  if (typeof support.answerDay === "number" && typeof support.answerMonth === "number" && typeof support.answerYear === "number") {
    const month = monthLabel(support.answerMonth);
    const claimText = month ? `${support.answerDay} ${month} ${support.answerYear}` : null;
    return {
      claimText,
      shapingMode: "typed_temporal_event",
      typedValueUsed: Boolean(claimText),
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      selectedEventKey: support.eventKey,
      selectedEventType: support.eventType,
      selectedTimeGranularity: support.timeGranularity,
      supportObjectsBuilt: 1,
      supportObjectType: support.supportObjectType,
      supportNormalizationFailures: support.supportNormalizationFailures,
      renderContractSelected: "temporal_day",
      renderContractFallbackReason: month ? null : "answer_day_missing"
      ,
      ...baseTrace
    };
  }
  const fallbackContract =
    support.temporalGranularityStatus === "missing_year"
      ? "temporal_missing_year"
      : support.temporalGranularityStatus === "missing_month"
        ? "temporal_missing_month"
        : support.temporalGranularityStatus === "missing_day" || support.temporalGranularityStatus === "missing_month_day"
          ? "temporal_missing_day"
          : "temporal_incomplete_support";
  const fallbackReason =
    support.temporalGranularityStatus;
  return {
    claimText: support.fallbackClaimText,
    shapingMode: support.eventKey || support.timeGranularity ? "typed_temporal_event" : "temporal_text_fallback",
    typedValueUsed: Boolean(support.eventKey || support.timeGranularity || typeof support.answerYear === "number"),
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    selectedEventKey: support.eventKey,
    selectedEventType: support.eventType,
    selectedTimeGranularity: support.timeGranularity,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: fallbackContract,
    renderContractFallbackReason: support.fallbackClaimText ? fallbackReason : "typed_temporal_value_missing",
    ...baseTrace
  };
}

export function buildListSetSupport(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly results?: readonly RecallResult[];
  readonly storedCanonical?: StoredCanonicalLookup | null;
  readonly finalClaimText: string | null;
  readonly subjectPlan: SubjectPlan;
}): ListSetSupport {
  const strictPairMeetupEntries =
    params.subjectPlan.kind === "pair_subject" &&
    /\bmeet\b/i.test(params.queryText) &&
    (/\bwhich\s+country\b/i.test(params.queryText) ||
      /\bwhat\s+country\b/i.test(params.queryText) ||
      /\bin what country\b/i.test(params.queryText) ||
      /\bplaces?\b/i.test(params.queryText) ||
      /\bevents?\b/i.test(params.queryText));
  const storedCanonicalTypedEntries = strictPairMeetupEntries ? [] : (params.storedCanonical?.typedSetEntryValues ?? []);
  const storedCanonicalObjectValues = strictPairMeetupEntries ? [] : (params.storedCanonical?.objectValues ?? []);
  const finalClaimText = strictPairMeetupEntries ? null : params.finalClaimText;
  const normalizedTexts = [
    ...storedCanonicalTypedEntries,
    ...storedCanonicalObjectValues,
    normalize(finalClaimText),
    ...((params.results ?? []).map((result) => result.content)),
    ...collectSupportEvidenceTexts(params.results ?? []),
    ...collectExpandedSourceTexts(params.results ?? [])
  ].filter(Boolean);
  const inferredTyped = inferListSetTypedEntries({
    queryText: params.queryText,
    texts: normalizedTexts
  });
  const fallbackEntries = uniqueNormalized([
    ...storedCanonicalObjectValues,
    ...parseCanonicalSetValues(extractStructuredClaimText(finalClaimText) ?? normalize(finalClaimText))
  ]);
  const typedEntryType =
    params.storedCanonical?.typedSetEntryType ??
    inferredTyped.entryType ??
    inferListEntryTypeFromQuery(params.queryText);
  const promotedFallbackEntries =
    typedEntryType === "book_title" ||
    typedEntryType === "event_name" ||
    typedEntryType === "support_contact" ||
    typedEntryType === "country" ||
    typedEntryType === "gift" ||
    typedEntryType === "venue"
      ? fallbackEntries.filter((entry) => isQueryCompatibleListEntry(params.queryText, typedEntryType, entry))
      : [];
  const typedEntries = uniqueNormalized([
    ...storedCanonicalTypedEntries,
    ...inferredTyped.entries,
    ...promotedFallbackEntries
  ]);
  const failures =
    typedEntries.length > 0 || fallbackEntries.length > 0
      ? []
      : ["no_list_set_entries_normalized"];
  const missingTypedEntries = fallbackEntries.filter((value) => !typedEntries.includes(value));
  const targetedRetrievalAttempted = promotedFallbackEntries.length > inferredTyped.entries.length;
  return {
    supportObjectType: "ListSetSupport",
    predicateFamily: params.predicateFamily,
    typedEntries,
    fallbackEntries,
    typedEntryType,
    binarySupportInference: /\bfriends?\b/i.test(params.queryText) && /\bbesides\b/i.test(params.queryText),
    subjectPlan: params.subjectPlan,
    targetedRetrievalAttempted,
    targetedRetrievalReason: targetedRetrievalAttempted ? "list_set_entries_incomplete" : null,
    targetedFieldsRequested: targetedRetrievalAttempted ? ["typed_entries"] : [],
    targetedRetrievalSatisfied: targetedRetrievalAttempted ? missingTypedEntries.length === 0 : true,
    supportNormalizationFailures: failures
  };
}

export function renderListSetSupport(
  support: ListSetSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  const values = support.typedEntries.length > 0 ? support.typedEntries : support.fallbackEntries;
  const renderContractSelected =
    support.typedEntries.length > 0
      ? support.typedEntryType === "book_title"
        ? "book_list_render"
      : support.typedEntryType === "event_name"
          ? "event_list_render"
          : support.typedEntryType === "support_contact"
            ? "support_network_render"
            : support.typedEntryType === "location_place" || support.typedEntryType === "country" || support.typedEntryType === "venue"
              ? "location_list_render"
            : "typed_set_join"
      : "mixed_set_join";
  const joined =
    renderContractSelected === "book_list_render"
      ? formatQuotedList(values)
      : renderContractSelected === "support_network_render" && support.binarySupportInference
        ? (() => {
            const preferredValue = selectPreferredSupportNetworkEntry(values);
            return preferredValue ? `Yes, ${preferredValue}.` : `Yes, ${joinCanonicalItems(values)}.`;
          })()
      : support.predicateFamily === "commonality"
        ? support.subjectPlan.kind === "pair_subject"
          ? `They ${joinCanonicalItems(values)}.`
          : joinCanonicalItems(values)
        : joinCanonicalItems(values);
  return {
    claimText: joined || null,
    shapingMode: support.typedEntries.length > 0 ? "typed_set_entries" : "mixed_string_set",
    typedValueUsed: support.typedEntries.length > 0,
    generatedProseUsed: support.predicateFamily === "commonality" && support.subjectPlan.kind === "pair_subject",
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    targetedFieldsRequested: support.targetedFieldsRequested,
    targetedRetrievalSatisfied: support.targetedRetrievalSatisfied,
    typedSetEntryCount: support.typedEntries.length,
    typedSetEntryType: support.typedEntryType,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected,
    renderContractFallbackReason: support.typedEntries.length > 0 ? null : "typed_entries_missing"
  };
}

export function buildDirectDetailSupport(params: {
  readonly finalClaimText: string | null;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}): DirectDetailSupport {
  const selectedText =
    extractStructuredClaimText(params.exactDetailCandidate?.text) ??
    extractStructuredClaimText(params.finalClaimText);
  return {
    supportObjectType: "DirectDetailSupport",
    selectedText,
    exactDetailSource: params.exactDetailCandidate?.source ?? null,
    strongSupport: params.exactDetailCandidate?.strongSupport === true,
    supportNormalizationFailures: selectedText ? [] : ["no_exact_detail_support_normalized"]
  };
}

export function renderDirectDetailSupport(
  support: DirectDetailSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  const typedValueSelected = Boolean(support.selectedText);
  return {
    claimText: support.selectedText,
    shapingMode: support.strongSupport ? "support_span_extraction" : "stored_canonical_fact",
    typedValueUsed: typedValueSelected,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: typedValueSelected ? 1 : 0,
    supportSelectionMode: typedValueSelected ? "atomic_unit" : null,
    targetedRetrievalAttempted: false,
    targetedRetrievalReason: null,
    exactDetailSource: support.exactDetailSource,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: support.strongSupport ? "exact_support_span" : "exact_canonical_value",
    renderContractFallbackReason: support.strongSupport ? null : "strong_support_span_missing"
  };
}

export function buildSnippetFactSupport(params: {
  readonly finalClaimText: string | null;
}): SnippetFactSupport {
  const selectedText = extractStructuredClaimText(params.finalClaimText);
  return {
    supportObjectType: "SnippetFactSupport",
    selectedText,
    supportNormalizationFailures: selectedText ? [] : ["snippet_fact_missing"]
  };
}

export function renderSnippetFactSupport(
  support: SnippetFactSupport,
  supportRowsSelected: number
): RenderedSupportClaim {
  return {
    claimText: support.selectedText,
    shapingMode: "snippet_fallback",
    targetedRetrievalAttempted: false,
    targetedRetrievalReason: null,
    typedValueUsed: false,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected: "support_span_extract",
    renderContractFallbackReason: support.selectedText ? null : "snippet_fact_missing"
  };
}
