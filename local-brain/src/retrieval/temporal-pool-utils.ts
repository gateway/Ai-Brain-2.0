import { areTemporalEventKeysCompatible, inferTemporalEventKeyFromText } from "../canonical-memory/service.js";
import type { RecallResult } from "../types.js";
import { collectRecallResultTextCandidates } from "./recall-content.js";
import {
  extractTemporalQueryObjectTokens,
  isTemporalQueryTextAligned,
  temporalQueryObjectAlignmentCount
} from "./temporal-query-alignment.js";

export type TemporalEventEvidenceKind = "exact" | "aligned" | "none";

export interface TemporalRecallShape {
  readonly eventKey: string | null;
  readonly eventType: string | null;
  readonly supportKind: "explicit_event_fact" | "aligned_anchor" | "reference_derived_relative" | "generic_time_fragment" | null;
  readonly bindingConfidence: number | null;
  readonly temporalSourceQuality: "canonical_event" | "aligned_anchor" | "derived_relative" | "generic" | null;
  readonly derivedFromReference: boolean;
  readonly candidatePool: string | null;
  readonly timeGranularity: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly sourceTable: string | null;
  readonly sourceText: string | null;
  readonly occurredAt: string | null;
  readonly eventEvidenceKind: TemporalEventEvidenceKind;
  readonly eventAligned: boolean;
  readonly candidateTexts: readonly string[];
}

export interface TemporalResultBundleSummary {
  readonly key: string;
  readonly memberCount: number;
  readonly eventEvidenceKind: TemporalEventEvidenceKind;
  readonly earliestOrderingValue: number;
  readonly bestGranularityRank: number;
  readonly bestSupportPriority: number;
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

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}

function readMetadataRecord(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && normalize(value) ? normalize(value) : null;
}

function readMetadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Number(value) : null;
}

function readAnswerPayload(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  return typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
    ? (metadata.answer_payload as Record<string, unknown>)
    : null;
}

function isMediaReferenceWithoutExplicitTemporalAnchor(
  metadata: Record<string, unknown> | null,
  sourceTable: string | null
): boolean {
  const sourceTableValue = normalizeLower(readMetadataString(metadata, "leaf_source_table") ?? sourceTable);
  const mediaKind = normalize(readMetadataString(metadata, "media_kind"));
  const mentionKind = normalize(readMetadataString(metadata, "mention_kind"));
  const hasMediaReference = sourceTableValue === "media_mentions" || Boolean(mediaKind) || Boolean(mentionKind);
  if (!hasMediaReference) {
    return false;
  }
  const explicitAnchorText = normalize(
    readMetadataString(metadata, "leaf_time_hint_text") ??
    readMetadataString(metadata, "anchor_text")
  );
  const anchorEventKey = normalize(readMetadataString(metadata, "anchor_event_key"));
  const anchorRelation = normalize(readMetadataString(metadata, "anchor_relation"));
  const eventAnchorStart = normalize(readMetadataString(metadata, "event_anchor_start"));
  const eventAnchorEnd = normalize(readMetadataString(metadata, "event_anchor_end"));
  return !(explicitAnchorText || anchorEventKey || anchorRelation || eventAnchorStart || eventAnchorEnd);
}

function temporalEventAlignmentTokens(eventKey: string | null): readonly string[] {
  const normalized = normalizeLower(eventKey);
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

function parseTemporalParts(texts: readonly string[]): {
  readonly year: number | null;
  readonly month: number | null;
  readonly day: number | null;
} {
  const monthMap: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12
  };

  for (const text of texts) {
    const normalized = normalize(text);
    if (!normalized) {
      continue;
    }
    const isoMatch = normalized.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/u);
    if (isoMatch) {
      return {
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]),
        day: Number(isoMatch[3])
      };
    }
    const naturalMatch = normalized.match(
      /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/iu
    );
    if (naturalMatch) {
      return {
        year: Number(naturalMatch[3]),
        month: monthMap[naturalMatch[2]!.toLowerCase()] ?? null,
        day: Number(naturalMatch[1])
      };
    }
    const monthYearMatch = normalized.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/iu
    );
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
  }
  return { year: null, month: null, day: null };
}

function temporalRecallOccurredAtConflict(params: {
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly occurredAt: string | null | undefined;
}): boolean {
  const occurredAt = typeof params.occurredAt === "string" ? normalize(params.occurredAt) : "";
  if (!occurredAt) {
    return false;
  }
  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  const instant = new Date(parsed);
  return (
    (typeof params.answerYear === "number" && params.answerYear !== instant.getUTCFullYear()) ||
    (typeof params.answerMonth === "number" && params.answerMonth !== instant.getUTCMonth() + 1) ||
    (typeof params.answerDay === "number" && params.answerDay !== instant.getUTCDate())
  );
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

function hasGroundedTemporalCueText(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  if (!normalized) {
    return false;
  }
  const parts = parseTemporalParts([normalized]);
  return (
    typeof parts.year === "number" ||
    typeof parts.month === "number" ||
    typeof parts.day === "number" ||
    isRelativeTemporalCueText(normalized)
  );
}

function temporalGranularityRank(shape: TemporalRecallShape): number {
  if (typeof shape.answerDay === "number") {
    return 3;
  }
  if (typeof shape.answerMonth === "number") {
    return 2;
  }
  if (typeof shape.answerYear === "number") {
    return 1;
  }
  return 0;
}

export function temporalEvidencePriority(kind: TemporalEventEvidenceKind): number {
  return kind === "exact" ? 3 : kind === "aligned" ? 2 : 0;
}

export function temporalSupportPriority(
  kind: TemporalRecallShape["supportKind"],
  quality: TemporalRecallShape["temporalSourceQuality"]
): number {
  const kindPriority =
    kind === "explicit_event_fact" ? 4 :
    kind === "aligned_anchor" ? 3 :
    kind === "reference_derived_relative" ? 2 :
    kind === "generic_time_fragment" ? 1 : 0;
  const qualityBonus =
    quality === "canonical_event" ? 2 :
    quality === "aligned_anchor" ? 1 :
    quality === "derived_relative" ? -1 : -2;
  return kindPriority * 10 + qualityBonus;
}

export function isRelativeTemporalCueText(value: string | null | undefined): boolean {
  const normalized = normalizeLower(value);
  if (!normalized) {
    return false;
  }
  return (
    /\byesterday\b|\blast night\b|\btoday\b|\btonight\b/u.test(normalized) ||
    /\bnext month\b|\blast month\b|\bthis month\b|\bnext week\b|\blast week\b|\bthis week\b|\blast year\b/u.test(normalized) ||
    /\bweek of\b|\bweekend of\b|\ba few days before\b|\ba few days after\b|\ba few days ago\b|\ba few years ago\b/u.test(normalized) ||
    (/\bbefore\b|\bafter\b/u.test(normalized) && /\b(?:game|festival|show|trip|appointment|doctor|event)\b/u.test(normalized)) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:years?|weeks?|days?)\s+ago\b/u.test(normalized)
  );
}

function isCanonicalTemporalSourceTable(sourceTable: string | null | undefined): boolean {
  const normalized = normalizeLower(sourceTable);
  return normalized === "canonical_temporal_facts" || normalized === "normalized_event_facts";
}

function selectTemporalSourceText(
  queryText: string,
  candidateTexts: readonly string[],
  queryEventKey: string | null
): string | null {
  if (candidateTexts.length === 0) {
    return null;
  }
  const rankedTexts = [...candidateTexts].sort((left, right) => {
    const score = (value: string): number => {
      let total = 0;
      if (queryEventKey && isEventAlignedTemporalSentence(queryEventKey, value)) {
        total += 4;
      }
      if (isTemporalQueryTextAligned(queryText, value)) {
        total += 3;
      }
      if (/\b(20\d{2}|19\d{2})\b/u.test(value)) {
        total += 1;
      }
      total += Math.min(value.length, 240) / 240;
      return total;
    };
    return score(right) - score(left);
  });
  return rankedTexts[0] ?? null;
}

function deriveTemporalRecallSupportKind(params: {
  readonly sourceTable: string | null;
  readonly candidatePool: string | null;
  readonly eventKey: string | null;
  readonly eventEvidenceKind: TemporalEventEvidenceKind;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly metadataSupportKind: TemporalRecallShape["supportKind"];
  readonly derivedFromReference: boolean;
  readonly sourceText: string | null;
  readonly anchorEventKey: string | null;
  readonly anchorRelation: string | null;
}): NonNullable<TemporalRecallShape["supportKind"]> {
  if (params.metadataSupportKind) {
    return params.metadataSupportKind;
  }
  if (
    params.eventKey &&
    (
      params.eventEvidenceKind === "exact" ||
      params.candidatePool === "temporal_exact_facts" ||
      isCanonicalTemporalSourceTable(params.sourceTable)
    )
  ) {
    return "explicit_event_fact";
  }
  if (
    params.eventEvidenceKind === "aligned" ||
    params.candidatePool === "temporal_aligned_anchors" ||
    params.candidatePool === "temporal_event_neighbors" ||
    Boolean(params.anchorEventKey) ||
    Boolean(params.anchorRelation)
  ) {
    return "aligned_anchor";
  }
  if (params.derivedFromReference || isRelativeTemporalCueText(params.sourceText)) {
    return "reference_derived_relative";
  }
  if (
    isCanonicalTemporalSourceTable(params.sourceTable) &&
    (
      typeof params.answerYear === "number" ||
      typeof params.answerMonth === "number" ||
      typeof params.answerDay === "number"
    )
  ) {
    return params.eventKey ? "explicit_event_fact" : "aligned_anchor";
  }
  return "generic_time_fragment";
}

function deriveTemporalRecallBindingConfidence(params: {
  readonly supportKind: NonNullable<TemporalRecallShape["supportKind"]>;
  readonly bindingConfidence: number | null;
}): number {
  if (typeof params.bindingConfidence === "number" && Number.isFinite(params.bindingConfidence)) {
    return params.bindingConfidence;
  }
  switch (params.supportKind) {
    case "explicit_event_fact":
      return 0.9;
    case "aligned_anchor":
      return 0.7;
    case "reference_derived_relative":
      return 0.5;
    default:
      return 0.2;
  }
}

function deriveTemporalRecallSourceQuality(params: {
  readonly supportKind: NonNullable<TemporalRecallShape["supportKind"]>;
  readonly temporalSourceQuality: TemporalRecallShape["temporalSourceQuality"];
}): NonNullable<TemporalRecallShape["temporalSourceQuality"]> {
  if (params.temporalSourceQuality) {
    return params.temporalSourceQuality;
  }
  switch (params.supportKind) {
    case "explicit_event_fact":
      return "canonical_event";
    case "aligned_anchor":
      return "aligned_anchor";
    case "reference_derived_relative":
      return "derived_relative";
    default:
      return "generic";
  }
}

export function isTemporalInceptionEventKey(eventKey: string | null | undefined): boolean {
  return typeof eventKey === "string" && /^(start_|join_|launch_)/u.test(eventKey);
}

export function readTemporalRecallShape(queryText: string, result: RecallResult): TemporalRecallShape {
  const metadata = readMetadataRecord(result);
  const answerPayload = readAnswerPayload(metadata);
  const candidateTexts = uniqueNormalized(collectRecallResultTextCandidates(result));
  const contentText = normalize(result.content);
  const contentIsBareTemporalLabel = isBareTemporalSummaryText(contentText);
  const sourceGroundedTexts = candidateTexts.filter((value) => normalize(value) !== contentText);
  const sourceGroundedHasTemporalCue = sourceGroundedTexts.some((value) => hasGroundedTemporalCueText(value));
  const eventSurfaceText =
    readMetadataString(metadata, "event_surface_text") ??
    readMetadataString(answerPayload, "event_surface_text");
  const locationSurfaceText =
    readMetadataString(metadata, "location_surface_text") ??
    readMetadataString(answerPayload, "location_surface_text");
  const parsedParts = parseTemporalParts(candidateTexts);
  const rawEventKey =
    readMetadataString(metadata, "event_key") ??
    readMetadataString(answerPayload, "event_key") ??
    candidateTexts.map((value) => inferTemporalEventKeyFromText(value)).find(Boolean) ??
    null;
  const sourceTable =
    readMetadataString(metadata, "source_table") ??
    (typeof result.provenance.source_table === "string" ? normalize(result.provenance.source_table) : null);
  const mediaReferenceWithoutExplicitAnchor = isMediaReferenceWithoutExplicitTemporalAnchor(metadata, sourceTable);
  const rawAnswerYear = mediaReferenceWithoutExplicitAnchor
    ? null
    : readMetadataNumber(metadata, "answer_year") ?? readMetadataNumber(answerPayload, "answer_year") ?? parsedParts.year;
  const rawAnswerMonth = mediaReferenceWithoutExplicitAnchor
    ? null
    : readMetadataNumber(metadata, "answer_month") ?? readMetadataNumber(answerPayload, "answer_month") ?? parsedParts.month;
  const rawAnswerDay = mediaReferenceWithoutExplicitAnchor
    ? null
    : readMetadataNumber(metadata, "answer_day") ?? readMetadataNumber(answerPayload, "answer_day") ?? parsedParts.day;
  const occurredAt = typeof result.occurredAt === "string" ? normalize(result.occurredAt) : null;
  const ungroundedArtifactTemporalLabel =
    result.memoryType === "artifact_derivation" &&
    contentIsBareTemporalLabel &&
    temporalRecallOccurredAtConflict({
      answerYear: rawAnswerYear,
      answerMonth: rawAnswerMonth,
      answerDay: rawAnswerDay,
      occurredAt
    }) &&
    !sourceGroundedHasTemporalCue;
  const answerYear = ungroundedArtifactTemporalLabel ? null : rawAnswerYear;
  const answerMonth = ungroundedArtifactTemporalLabel ? null : rawAnswerMonth;
  const answerDay = ungroundedArtifactTemporalLabel ? null : rawAnswerDay;
  const timeGranularity =
    mediaReferenceWithoutExplicitAnchor
      ? null
      : ungroundedArtifactTemporalLabel
        ? null
        :
    readMetadataString(metadata, "time_granularity") ??
    readMetadataString(answerPayload, "answer_granularity") ??
    (typeof answerDay === "number"
      ? "day"
      : typeof answerMonth === "number"
        ? "month"
          : typeof answerYear === "number"
            ? "year"
            : null);
  const candidatePool = readMetadataString(metadata, "candidate_pool");
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const sourceText = selectTemporalSourceText(queryText, candidateTexts, queryEventKey);
  const metadataSupportKind = mediaReferenceWithoutExplicitAnchor
    ? "generic_time_fragment"
    : readMetadataString(metadata, "support_kind") as TemporalRecallShape["supportKind"] ?? null;
  const bindingConfidence = readMetadataNumber(metadata, "binding_confidence");
  const temporalSourceQuality = mediaReferenceWithoutExplicitAnchor
    ? "generic"
    : readMetadataString(metadata, "temporal_source_quality") as TemporalRecallShape["temporalSourceQuality"] ?? null;
  const derivedFromReference =
    mediaReferenceWithoutExplicitAnchor
      ? false
      : Boolean(metadata?.derived_from_reference) ||
        (
          candidateTexts.some((value) => isRelativeTemporalCueText(value)) &&
          temporalRecallOccurredAtConflict({
            answerYear,
            answerMonth,
            answerDay,
            occurredAt
          })
        );
  const eventKey = mediaReferenceWithoutExplicitAnchor ? null : rawEventKey;
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  const objectAlignmentSearchText = [
    candidateTexts.join(" "),
    eventSurfaceText,
    locationSurfaceText
  ]
    .map((value) => normalize(value))
    .filter(Boolean)
    .join(" ");
  const objectAlignmentCount = temporalQueryObjectAlignmentCount(queryText, objectAlignmentSearchText);
  const requiresObjectAlignment = queryObjectTokens.length > 0;
  const hasTemporalSignal =
    typeof answerYear === "number" ||
    typeof answerMonth === "number" ||
    typeof answerDay === "number" ||
    Boolean(result.occurredAt) ||
    Boolean(readMetadataString(metadata, "anchor_relation")) ||
    Boolean(readMetadataString(metadata, "anchor_event_key")) ||
    /temporal|canonical_temporal_facts|normalized_event_facts/u.test(normalizeLower(sourceTable));
  const persistedExactEventFact =
    Boolean(queryEventKey) &&
    areTemporalEventKeysCompatible(eventKey, queryEventKey) &&
    queryObjectTokens.length === 0 &&
    (
      metadataSupportKind === "explicit_event_fact" ||
      temporalSourceQuality === "canonical_event" ||
      (
        (sourceTable === "canonical_temporal_facts" || sourceTable === "normalized_event_facts") &&
        (bindingConfidence ?? 0) >= 0.8
      )
    );
  const eventEvidenceKind: TemporalEventEvidenceKind =
    queryEventKey
      ? areTemporalEventKeysCompatible(eventKey, queryEventKey)
        ? requiresObjectAlignment && objectAlignmentCount === 0 && !persistedExactEventFact
          ? candidateTexts.some((value) => isTemporalQueryTextAligned(queryText, value))
            ? "aligned"
            : "none"
          : "exact"
        : candidateTexts.some((value) => isEventAlignedTemporalSentence(queryEventKey, value))
          ? "aligned"
          : "none"
      : eventKey
        ? "exact"
        : hasTemporalSignal && candidateTexts.some((value) => isTemporalQueryTextAligned(queryText, value))
          ? "aligned"
          : "none";
  const supportKind = deriveTemporalRecallSupportKind({
    sourceTable,
    candidatePool,
    eventKey,
    eventEvidenceKind,
    answerYear,
    answerMonth,
    answerDay,
    metadataSupportKind,
    derivedFromReference,
    sourceText,
    anchorEventKey: readMetadataString(metadata, "anchor_event_key"),
    anchorRelation: readMetadataString(metadata, "anchor_relation")
  });
  const effectiveBindingConfidence = deriveTemporalRecallBindingConfidence({
    supportKind,
    bindingConfidence
  });
  const effectiveTemporalSourceQuality = deriveTemporalRecallSourceQuality({
    supportKind,
    temporalSourceQuality
  });

  return {
    eventKey,
    eventType: readMetadataString(metadata, "event_type") ?? readMetadataString(answerPayload, "event_type"),
    supportKind,
    bindingConfidence: effectiveBindingConfidence,
    temporalSourceQuality: effectiveTemporalSourceQuality,
    derivedFromReference,
    candidatePool,
    timeGranularity,
    answerYear,
    answerMonth,
    answerDay,
    sourceTable,
    sourceText,
    occurredAt,
    eventEvidenceKind,
    eventAligned: eventEvidenceKind !== "none",
    candidateTexts
  };
}

export function temporalRecallOrderingValue(shape: TemporalRecallShape): number {
  if (typeof shape.answerYear === "number") {
    return Date.UTC(shape.answerYear, (shape.answerMonth ?? 1) - 1, shape.answerDay ?? 1);
  }
  if (!shape.occurredAt) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(shape.occurredAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function buildTemporalBundleKey(queryText: string, result: RecallResult): string {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  const shape = readTemporalRecallShape(queryText, result);
  if (shape.eventEvidenceKind !== "none") {
    return `event:${shape.eventKey ?? queryEventKey ?? "aligned"}`;
  }
  if (shape.eventKey) {
    return `event:${shape.eventKey}`;
  }
  return [
    "generic",
    normalizeLower(shape.sourceTable) || "unknown",
    shape.answerYear ?? "na",
    shape.answerMonth ?? "na",
    shape.answerDay ?? "na",
    normalizeLower(shape.sourceText).slice(0, 48)
  ].join(":");
}

export function buildTemporalResultBundles(
  queryText: string,
  results: readonly RecallResult[]
): ReadonlyMap<string, TemporalResultBundleSummary> {
  const bundles = new Map<
    string,
    {
      memberCount: number;
      eventEvidenceKind: TemporalEventEvidenceKind;
      earliestOrderingValue: number;
      bestGranularityRank: number;
      bestSupportPriority: number;
    }
  >();

  for (const result of results) {
    const shape = readTemporalRecallShape(queryText, result);
    const key = buildTemporalBundleKey(queryText, result);
    const orderingValue = temporalRecallOrderingValue(shape);
    const granularityRank = temporalGranularityRank(shape);
    const supportPriority = temporalSupportPriority(shape.supportKind, shape.temporalSourceQuality);
    const current = bundles.get(key);
    if (!current) {
      bundles.set(key, {
        memberCount: 1,
        eventEvidenceKind: shape.eventEvidenceKind,
        earliestOrderingValue: orderingValue,
        bestGranularityRank: granularityRank,
        bestSupportPriority: supportPriority
      });
      continue;
    }
    bundles.set(key, {
      memberCount: current.memberCount + 1,
      eventEvidenceKind:
        temporalEvidencePriority(shape.eventEvidenceKind) > temporalEvidencePriority(current.eventEvidenceKind)
          ? shape.eventEvidenceKind
          : current.eventEvidenceKind,
      earliestOrderingValue: Math.min(current.earliestOrderingValue, orderingValue),
      bestGranularityRank: Math.max(current.bestGranularityRank, granularityRank),
      bestSupportPriority: Math.max(current.bestSupportPriority, supportPriority)
    });
  }

  return new Map(
    [...bundles.entries()].map(([key, value]) => [
      key,
      {
        key,
        memberCount: value.memberCount,
        eventEvidenceKind: value.eventEvidenceKind,
        earliestOrderingValue: value.earliestOrderingValue,
        bestGranularityRank: value.bestGranularityRank,
        bestSupportPriority: value.bestSupportPriority
      } satisfies TemporalResultBundleSummary
    ])
  );
}
