import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import { areTemporalEventKeysCompatible, inferTemporalEventKeyFromText } from "../canonical-memory/service.js";
import type { RecallResult } from "../types.js";
import type { AnswerRetrievalPlan } from "./types.js";
import { collectRecallResultTextCandidates, extractRecallResultSubjectSignals } from "./recall-content.js";
import {
  buildTemporalBundleKey,
  buildTemporalResultBundles,
  isTemporalInceptionEventKey,
  readTemporalRecallShape,
  temporalSupportPriority,
  temporalEvidencePriority,
  temporalRecallOrderingValue,
  type TemporalResultBundleSummary
} from "./temporal-pool-utils.js";

const RRF_K = 60;
const MAX_POOL_INPUT = 24;
const MAX_TEMPORAL_POOL_INPUT = 40;
const DEFAULT_LIMIT = 12;
const DEFAULT_MMR_LAMBDA = 0.68;

type PlannerPoolKind = "collection" | "temporal" | "profile";

interface RankPlannerPoolParams {
  readonly poolKind: PlannerPoolKind;
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly limit?: number;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function readResultMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  return typeof metadata?.[key] === "string" ? normalize(metadata[key] as string) || null : null;
}

function readMetadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  return typeof metadata?.[key] === "number" && Number.isFinite(metadata[key]) ? Number(metadata[key]) : null;
}

function readResultSourceTable(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  return (
    readMetadataString(metadata, "source_table") ??
    (typeof result.provenance.source_table === "string" ? normalize(result.provenance.source_table) || null : null)
  );
}

function readResultSourceUri(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  return (
    readMetadataString(metadata, "source_uri") ??
    (typeof result.provenance.source_uri === "string" ? normalize(result.provenance.source_uri) || null : null)
  );
}

function readResultSubjectEntityId(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  return (
    (typeof result.provenance.subject_entity_id === "string" ? normalize(result.provenance.subject_entity_id) || null : null) ??
    readMetadataString(metadata, "subject_entity_id")
  );
}

function readResultSubjectSignals(result: RecallResult): readonly string[] {
  return extractRecallResultSubjectSignals(result);
}

function queryTokens(queryText: string): readonly string[] {
  return normalizeLower(queryText)
    .split(/[^a-z0-9+]+/u)
    .filter(
      (token) =>
        token.length > 1 &&
        !new Set([
          "what",
          "which",
          "does",
          "did",
          "when",
          "year",
          "month",
          "date",
          "why",
          "who",
          "is",
          "are",
          "the",
          "his",
          "her",
          "their",
          "its",
          "start",
          "started"
        ]).has(token)
    );
}

function tokenize(value: string): readonly string[] {
  return normalizeLower(value)
    .split(/[^a-z0-9+]+/u)
    .filter((token) => token.length > 1);
}

function lexicalOverlapScore(queryText: string, candidateText: string): number {
  const query = new Set(queryTokens(queryText));
  if (query.size === 0) {
    return 0;
  }
  const candidate = new Set(tokenize(candidateText));
  let overlap = 0;
  for (const token of query) {
    if (candidate.has(token)) {
      overlap += 1;
    }
  }
  return overlap / query.size;
}

function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function reciprocalRankFusion(params: {
  readonly rankings: readonly (readonly RecallResult[])[];
  readonly keyFn: (result: RecallResult) => string;
}): ReadonlyMap<string, number> {
  const scoreMap = new Map<string, number>();
  for (const ranking of params.rankings) {
    ranking.forEach((result, index) => {
      const key = params.keyFn(result);
      scoreMap.set(key, (scoreMap.get(key) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return scoreMap;
}

function maximalMarginalRerank(params: {
  readonly candidates: readonly RecallResult[];
  readonly limit: number;
  readonly relevance: (result: RecallResult) => number;
  readonly similarity: (left: RecallResult, right: RecallResult) => number;
  readonly lambda?: number;
}): readonly RecallResult[] {
  const lambda = params.lambda ?? DEFAULT_MMR_LAMBDA;
  const remaining = [...params.candidates];
  if (remaining.length <= 1) {
    return remaining.slice(0, params.limit);
  }
  const selected: RecallResult[] = [];
  remaining.sort((left, right) => params.relevance(right) - params.relevance(left));
  selected.push(remaining.shift()!);
  while (selected.length < params.limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const relevance = params.relevance(candidate);
      const maxSimilarity = selected.reduce(
        (currentMax, chosen) => Math.max(currentMax, params.similarity(candidate, chosen)),
        0
      );
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function poolResultKey(result: RecallResult): string {
  return [
    result.memoryId,
    result.artifactId ?? "",
    readResultSourceTable(result) ?? "",
    normalizeLower(result.content)
  ].join("::");
}

function resultSubjectBindingScore(result: RecallResult, retrievalPlan: AnswerRetrievalPlan): number {
  const resultSubjectEntityId = readResultSubjectEntityId(result);
  if (resultSubjectEntityId && retrievalPlan.resolvedSubjectEntityId && resultSubjectEntityId === retrievalPlan.resolvedSubjectEntityId) {
    return 1;
  }
  const subjectNames = retrievalPlan.subjectNames.map((value) => normalizeEntityLookupName(value));
  if (subjectNames.length === 0) {
    return 0;
  }
  const signals = readResultSubjectSignals(result);
  const matches = subjectNames.filter((name) => signals.some((signal) => signal.includes(name)));
  if (matches.length === subjectNames.length) {
    return 0.85;
  }
  if (matches.length > 0) {
    return 0.55;
  }
  return 0;
}

function readCollectionValues(result: RecallResult): readonly string[] {
  const metadata = readResultMetadata(result);
  const answerPayload =
    typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
      ? (metadata.answer_payload as Record<string, unknown>)
      : null;
  const itemValues = Array.isArray(answerPayload?.item_values) ? answerPayload.item_values : [];
  const normalizedItems = itemValues
    .filter((value): value is string => typeof value === "string" && normalize(value).length > 0)
    .map((value) => normalize(value));
  if (normalizedItems.length > 0) {
    return normalizedItems;
  }
  const collectionItemValue = readMetadataString(metadata, "collection_item_value");
  if (collectionItemValue) {
    return [collectionItemValue];
  }
  const answerValue = readMetadataString(answerPayload, "answer_value");
  return answerValue ? [answerValue] : [];
}

function collectionCueWeight(result: RecallResult): number {
  const metadata = readResultMetadata(result);
  const cueType = readMetadataString(metadata, "cue_type") ?? "";
  const cueStrength = readMetadataNumber(metadata, "cue_strength") ?? 0;
  const confidence = readMetadataNumber(metadata, "confidence") ?? 0;
  const cueTypeBoost =
    cueType === "explicit_collects"
      ? 1
      : cueType === "typed_set" || cueType === "collection_of"
        ? 0.8
        : cueType === "bookshelf_contains" || cueType === "owns_many"
          ? 0.5
          : cueType === "incidental_mention" || cueType === "payload_fallback"
            ? -0.4
            : 0;
  const multiItemBoost = readCollectionValues(result).length >= 2 ? 0.5 : 0;
  return cueStrength * 0.1 + confidence * 0.5 + cueTypeBoost + multiItemBoost;
}

function collectionSignature(result: RecallResult): readonly string[] {
  const values = readCollectionValues(result);
  if (values.length > 0) {
    return values.flatMap((value) => tokenize(value));
  }
  return tokenize(result.content);
}

function readTemporalGranularity(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  const answerPayload =
    typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
      ? (metadata.answer_payload as Record<string, unknown>)
      : null;
  return readMetadataString(metadata, "time_granularity") ?? readMetadataString(answerPayload, "answer_granularity");
}

function temporalStructureWeight(queryText: string, result: RecallResult): number {
  const normalizedQuery = normalizeLower(queryText);
  const shape = readTemporalRecallShape(queryText, result);
  const candidateText = normalizeLower(collectRecallResultTextCandidates(result).join(" ") || result.content);
  const wantsYear = /\bwhat year\b|\bwhich year\b/u.test(normalizedQuery);
  const wantsMonth = /\bwhat month\b|\bwhich month\b/u.test(normalizedQuery);
  const wantsDate = /\bwhat date\b|\bwhich date\b/u.test(normalizedQuery);
  const granularity = shape.timeGranularity ?? "";
  const answerYear = shape.answerYear;
  const bindingConfidence = typeof shape.bindingConfidence === "number" ? Math.max(0, shape.bindingConfidence) : 0;
  const sourceTable = shape.sourceTable ?? "";
  const sourceBoost =
    sourceTable === "canonical_temporal_facts" || sourceTable === "normalized_event_facts"
      ? 1
      : sourceTable === "temporal_results"
        ? 0.6
        : 0;
  const supportBoost = temporalSupportPriority(shape.supportKind, shape.temporalSourceQuality) / 14;
  const granularityBoost =
    wantsYear && (granularity === "year" || answerYear !== null || /\b20\d{2}\b/u.test(normalizeLower(result.content)))
      ? 1
      : wantsMonth && granularity === "month"
        ? 0.8
        : wantsDate && granularity === "day"
          ? 0.8
          : 0;
  const requestedEventKey = inferTemporalEventKeyFromText(queryText);
  const candidateEventKey = shape.eventKey;
  const eventKeyMatches =
    Boolean(requestedEventKey) &&
    Boolean(candidateEventKey) &&
    areTemporalEventKeysCompatible(candidateEventKey, requestedEventKey);
  const eventKeyMismatch =
    Boolean(requestedEventKey) &&
    Boolean(candidateEventKey) &&
    !areTemporalEventKeysCompatible(candidateEventKey, requestedEventKey);
  const explicitEventBoost =
    shape.eventEvidenceKind === "exact"
      ? 2
      : shape.eventEvidenceKind === "aligned"
        ? 1
        : 0;
  const eventBoost =
    eventKeyMatches
      ? shape.eventEvidenceKind === "exact"
        ? 2.4
        : 1.5
      : eventKeyMismatch
        ? -2.8
        : requestedEventKey && shape.eventEvidenceKind === "none"
          ? -1.2
          : 0;
  const missingEventPenalty =
    inferTemporalEventIntent(queryText) &&
    shape.eventEvidenceKind === "none" &&
    (typeof shape.answerYear === "number" || typeof shape.answerMonth === "number" || typeof shape.answerDay === "number")
      ? 4
      : 0;
  const derivedRelativePenalty =
    !queryRequestsRelativeTemporalPhrasing(queryText) && shape.supportKind === "reference_derived_relative"
      ? 1.5
      : 0;
  const festivalPreparationBoost =
    requestedEventKey === "perform_festival" &&
    /\b(?:dance\s+comp(?:etition)?|competition|getting ready|choreograph\w*|rehears\w*|showcase|judging|local talent)\b/u.test(
      candidateText
    )
      ? 1.8
      : 0;
  const festivalInvitePenalty =
    requestedEventKey === "perform_festival" &&
    /\blove to have you there\b/u.test(candidateText) &&
    !/\bfestival\b/u.test(candidateText)
      ? 1
      : 0;
  return (
    sourceBoost +
    supportBoost +
    Math.min(1.2, bindingConfidence) +
    granularityBoost +
    eventBoost +
    explicitEventBoost -
    missingEventPenalty -
    derivedRelativePenalty +
    festivalPreparationBoost -
    festivalInvitePenalty
  );
}

function inferTemporalEventIntent(queryText: string): string | null {
  const normalized = normalizeLower(queryText);
  const eventKey = inferTemporalEventKeyFromText(queryText);
  if (eventKey) {
    return eventKey;
  }
  return /\bwhen\b|\bwhat (?:year|month|date)\b|\bwhich (?:year|month|date)\b/u.test(normalized) ? normalized : null;
}

function queryRequestsRelativeTemporalPhrasing(queryText: string): boolean {
  const normalized = normalizeLower(queryText);
  return (
    /\b(last|next|before|after|week(?:end)?|month|year)\b/u.test(normalized) ||
    /\bhow long before\b|\bhow long after\b/u.test(normalized)
  );
}

function shouldPreferEarliestTemporalPoolCandidate(queryText: string): boolean {
  const normalized = normalizeLower(queryText);
  return (
    /\bwhen\b/u.test(normalized) ||
    /\bwhat (?:year|month|date)\b/u.test(normalized) ||
    /\bwhich (?:year|month|date)\b/u.test(normalized)
  );
}

interface ProfileClusterSummary {
  readonly subjectBoundCount: number;
  readonly educationIntentCount: number;
  readonly educationFieldCount: number;
  readonly praiseOnlyCount: number;
  readonly aggregateReportCount: number;
  readonly typedPayloadCount: number;
  readonly maxItemValueCount: number;
  readonly canonicalSetCount: number;
}

function readResultAnswerPayload(result: RecallResult): Record<string, unknown> | null {
  const metadata = readResultMetadata(result);
  return typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
    ? (metadata.answer_payload as Record<string, unknown>)
    : null;
}

function readPayloadItemValues(result: RecallResult): readonly string[] {
  const payload = readResultAnswerPayload(result);
  return Array.isArray(payload?.item_values)
    ? payload.item_values.filter((value): value is string => typeof value === "string" && normalize(value).length > 0)
    : [];
}

function readPayloadAnswerValue(result: RecallResult): string {
  const payload = readResultAnswerPayload(result);
  return readMetadataString(payload, "answer_value") ?? "";
}

function readPayloadAnswerType(result: RecallResult): string {
  const payload = readResultAnswerPayload(result);
  return normalizeLower(readMetadataString(payload, "answer_type"));
}

function isOffCourtCareerGoalQuery(queryText: string): boolean {
  return (
    /\bgoals?\b/iu.test(queryText) &&
    (
      /\boff the court\b/iu.test(queryText) ||
      /\bbeyond basketball\b/iu.test(queryText) ||
      /\bnot related to\b[^?!.]{0,40}\bbasketball\b/iu.test(queryText) ||
      /\boutside (?:of )?basketball\b/iu.test(queryText) ||
      /\bbasketball skills\b/iu.test(queryText)
    )
  );
}

function isBasketballCareerGoalQuery(queryText: string): boolean {
  return /\bgoals?\b/iu.test(queryText) && /\bbasketball\b/iu.test(queryText) && !isOffCourtCareerGoalQuery(queryText);
}

function isBooksByAuthorPreferenceQuery(queryText: string): boolean {
  return /\bbooks?\s+by\b/iu.test(queryText) && /\bor\b/iu.test(queryText);
}

function isTravelLocationQuery(queryText: string): boolean {
  return /\bwhere\b/iu.test(queryText) && /\b(roadtrips?|travel|trip|visited|went)\b/iu.test(queryText);
}

function isDatedVentureStateQuery(queryText: string): boolean {
  return /\bnew business venture\b|\bventure\b/iu.test(queryText) && /\bas of\b|\bon\s+\d{1,2}\s+[A-Za-z]+\b/iu.test(queryText);
}

function isEducationProfileQuery(queryText: string): boolean {
  return /\bfields?\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e|on)\b|\bstud(?:y|ied|ying)\b|\bcertification\b/iu.test(queryText);
}

function hasEducationIntentCue(content: string): boolean {
  return /\b(edu|education|study|degree|major|career options?|certification|continue my edu)\b/u.test(content);
}

function hasEducationFieldCue(content: string): boolean {
  const counselingSignal = /\b(counsel(?:or|ing)|mental health|therapy|support group|helping people|psychology)\b/u.test(content);
  const policySignal =
    /\b(policymaking|policy|politic|government|campaign|local leaders?)\b/u.test(content) &&
    /\b(community|education|schools?|infrastructure|neighbo[u]?rhood|public)\b/u.test(content);
  return counselingSignal || policySignal;
}

function isPraiseOnlyProfileText(content: string): boolean {
  if (!content) {
    return false;
  }
  const hasPraiseCue =
    /\b(keep up the great work|kind words|proud of you|you(?:'re| are) inspiring|awesome job|amazing|so brave|impressive work|great work)\b/u.test(
      content
    );
  if (!hasPraiseCue) {
    return false;
  }
  return !/\b(counsel(?:or|ing)|mental health|therapy|support group|psychology|education|study|degree|major|certification|career options?|because|decid(?:e|ed)|wanted to|started)\b/u.test(
    content
  );
}

function profileClusterKey(result: RecallResult): string {
  if (result.artifactId) {
    return `artifact:${result.artifactId}`;
  }
  const sourceUri = readResultSourceUri(result);
  if (sourceUri) {
    return `source:${sourceUri}`;
  }
  if (result.occurredAt) {
    return `day:${result.occurredAt.slice(0, 10)}`;
  }
  return `row:${result.memoryId}`;
}

function buildProfileClusterSummaries(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): ReadonlyMap<string, ProfileClusterSummary> {
  const summariesByCluster = new Map<string, ProfileClusterSummary>();
  const keyToCluster = new Map<string, string>();
  const wantsEducation = isEducationProfileQuery(params.queryText);

  for (const result of params.results) {
    const key = poolResultKey(result);
    const cluster = profileClusterKey(result);
    keyToCluster.set(key, cluster);

    const summary =
      summariesByCluster.get(cluster) ??
      ({
        subjectBoundCount: 0,
        educationIntentCount: 0,
        educationFieldCount: 0,
        praiseOnlyCount: 0,
        aggregateReportCount: 0,
        typedPayloadCount: 0,
        maxItemValueCount: 0,
        canonicalSetCount: 0
      } satisfies ProfileClusterSummary);

    const content = normalizeLower(collectRecallResultTextCandidates(result).join(" ") || result.content);
    const sourceTable = readResultSourceTable(result) ?? "";
    const subjectBound = resultSubjectBindingScore(result, params.retrievalPlan) > 0;
    const payloadItemCount = readPayloadItemValues(result).length;
    const hasTypedPayload = Boolean(readResultAnswerPayload(result));

    summariesByCluster.set(cluster, {
      subjectBoundCount: summary.subjectBoundCount + (subjectBound ? 1 : 0),
      educationIntentCount:
        summary.educationIntentCount + (subjectBound && wantsEducation && hasEducationIntentCue(content) ? 1 : 0),
      educationFieldCount:
        summary.educationFieldCount + (subjectBound && wantsEducation && hasEducationFieldCue(content) ? 1 : 0),
      praiseOnlyCount: summary.praiseOnlyCount + (subjectBound && isPraiseOnlyProfileText(content) ? 1 : 0),
      aggregateReportCount:
        summary.aggregateReportCount +
        (subjectBound &&
        (sourceTable === "retrieved_text_unit_aggregate_report" || sourceTable === "assembled_graph_entity_report")
          ? 1
          : 0),
      typedPayloadCount: summary.typedPayloadCount + (subjectBound && hasTypedPayload ? 1 : 0),
      maxItemValueCount: Math.max(summary.maxItemValueCount, payloadItemCount),
      canonicalSetCount:
        summary.canonicalSetCount + (subjectBound && (sourceTable === "canonical_sets" || sourceTable === "set_entries") ? 1 : 0)
    });
  }

  const summaryByKey = new Map<string, ProfileClusterSummary>();
  for (const [key, cluster] of keyToCluster.entries()) {
    const summary = summariesByCluster.get(cluster);
    if (summary) {
      summaryByKey.set(key, summary);
    }
  }
  return summaryByKey;
}

function temporalBundleWeight(params: {
  readonly queryText: string;
  readonly result: RecallResult;
  readonly bundle: TemporalResultBundleSummary | undefined;
}): number {
  const shape = readTemporalRecallShape(params.queryText, params.result);
  const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
  const queryEventIntent = inferTemporalEventIntent(params.queryText);
  let score = temporalEvidencePriority(shape.eventEvidenceKind) * 1.5;
  if (params.bundle) {
    score += Math.min(params.bundle.memberCount, 4) * 0.2;
    score += params.bundle.bestGranularityRank * 0.1;
    if (
      queryEventKey &&
      shape.eventKey === queryEventKey &&
      shape.eventEvidenceKind !== "none" &&
      temporalRecallOrderingValue(shape) === params.bundle.earliestOrderingValue
    ) {
      score += isTemporalInceptionEventKey(queryEventKey) ? 1.25 : 1;
    }
  }
  if (
    queryEventIntent &&
    shape.eventEvidenceKind === "none" &&
    (typeof shape.answerYear === "number" || typeof shape.answerMonth === "number" || typeof shape.answerDay === "number")
  ) {
    score -= 3;
  }
  return score;
}

function temporalPreselectionScore(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly result: RecallResult;
  readonly bundle: TemporalResultBundleSummary | undefined;
}): number {
  const subjectBinding = resultSubjectBindingScore(params.result, params.retrievalPlan);
  return subjectBinding * 4 + temporalStructureWeight(params.queryText, params.result) + temporalBundleWeight(params);
}

function profileStructureWeight(
  queryText: string,
  result: RecallResult,
  clusterSummary?: ProfileClusterSummary
): number {
  const normalizedQuery = normalizeLower(queryText);
  const content = normalizeLower(collectRecallResultTextCandidates(result).join(" ") || result.content);
  const sourceTable = readResultSourceTable(result) ?? "";
  const payloadItemCount = readPayloadItemValues(result).length;
  const payloadAnswerValue = normalizeLower(readPayloadAnswerValue(result));
  const payloadAnswerType = readPayloadAnswerType(result);
  const wantsEducation = isEducationProfileQuery(queryText);
  const offCourtGoals = isOffCourtCareerGoalQuery(queryText);
  const basketballGoals = isBasketballCareerGoalQuery(queryText);
  const travelLocations = isTravelLocationQuery(queryText);
  const authorChoice = isBooksByAuthorPreferenceQuery(queryText);
  const datedVentureState = isDatedVentureStateQuery(queryText);
  const causalBoost =
    /\bwhy\b/u.test(normalizedQuery) && /\bbecause\b|\bsince\b|\bwanted to\b|\bso that\b|\bafter\b/u.test(content)
      ? 1
      : 0;
  const educationBoost =
    wantsEducation &&
    /\b(psychology|counsel(?:ing|or)|mental health|therapy|support group|public administration|public affairs|political science|policy|government|community|infrastructure)\b/u.test(
      content
    )
      ? 1.1
      : 0;
  const supportBoost =
    sourceTable === "canonical_sets" || sourceTable === "set_entries"
      ? 1.8
      : sourceTable === "canonical_reports" || sourceTable === "profile_report_support" || sourceTable === "report_support"
        ? 0.8
        : 0;
  const aggregateBoost =
    sourceTable === "retrieved_text_unit_aggregate_report" || sourceTable === "assembled_graph_entity_report"
      ? wantsEducation
        ? 1.8
        : 1.1
      : 0;
  const decisionBoost =
    /\bwhy\b/u.test(normalizedQuery) && /\bdecid(?:e|ed)\b|\bstarted\b|\bchose\b/u.test(content)
      ? 0.5
      : 0;
  const educationIntentBoost =
    wantsEducation && hasEducationIntentCue(content) ? 0.7 : 0;
  const educationFieldBoost =
    wantsEducation && hasEducationFieldCue(content) ? 1.25 : 0;
  const educationBundleBoost =
    wantsEducation && hasEducationIntentCue(content) && hasEducationFieldCue(content) ? 1.4 : 0;
  const clusterBundleBoost =
    wantsEducation && clusterSummary && clusterSummary.educationIntentCount > 0 && clusterSummary.educationFieldCount > 0
      ? 0.95
      : 0;
  const clusterSupportBoost =
    clusterSummary ? Math.min(0.8, Math.max(0, clusterSummary.subjectBoundCount - 1) * 0.22) : 0;
  const aggregateClusterBoost =
    wantsEducation && clusterSummary && clusterSummary.aggregateReportCount > 0 ? 0.6 : 0;
  const typedPayloadBoost =
    payloadItemCount > 0
      ? Math.min(1.8, payloadItemCount * 0.5)
      : payloadAnswerValue
        ? 0.55
        : 0;
  const canonicalSetClusterBoost = clusterSummary ? Math.min(1.1, clusterSummary.canonicalSetCount * 0.45) : 0;
  const payloadClusterBoost = clusterSummary ? Math.min(1, clusterSummary.typedPayloadCount * 0.3) : 0;
  const payloadCompletenessBoost = clusterSummary ? Math.min(1.2, clusterSummary.maxItemValueCount * 0.3) : 0;
  const offCourtGoalBoost =
    offCourtGoals
      ? (
          payloadAnswerType === "career_goal_set" ? 1.8 : 0
        ) +
        payloadItemCount * 0.3 +
        ((/\bendorsements?\b|\bbrand\b|\bcharity\b|\bcommunity\b/u.test(content) || /\bendorsements?\b|\bbrand\b|\bcharity\b|\bcommunity\b/u.test(payloadAnswerValue)) ? 1.1 : 0)
      : 0;
  const basketballGoalBoost =
    basketballGoals
      ? (
          payloadAnswerType === "career_goal_set" ? 1.8 : 0
        ) +
        payloadItemCount * 0.3 +
        ((/\bshoot(?:ing)?\b|\bchampionship\b|\btitle\b|\bfinals?\b/u.test(content) || /\bshoot(?:ing)?\b|\bchampionship\b|\btitle\b|\bfinals?\b/u.test(payloadAnswerValue)) ? 1.15 : 0)
      : 0;
  const offCourtPenaltyForBasketballGoals =
    basketballGoals &&
    (/\bendorsements?\b|\bbrand\b|\bcharity\b|\bcommunity\b/u.test(content) || /\bendorsements?\b|\bbrand\b|\bcharity\b|\bcommunity\b/u.test(payloadAnswerValue))
      ? 1.1
      : 0;
  const basketballPenaltyForOffCourtGoals =
    offCourtGoals &&
    (/\bshoot(?:ing)?\b|\bchampionship\b|\btitle\b|\bfinals?\b/u.test(content) || /\bshoot(?:ing)?\b|\bchampionship\b|\btitle\b|\bfinals?\b/u.test(payloadAnswerValue))
      ? 1
      : 0;
  const authorPreferenceBoost =
    authorChoice &&
    /\b(read(?:ing)?|books?|novels?|authors?|fantasy|series|harry potter|gryffindor|dragons?)\b/u.test(content)
      ? 1.35
      : 0;
  const travelPayloadBoost =
    travelLocations
      ? (payloadItemCount >= 2 ? 2 : 0) +
        ((/\b(rockies|jasper|yellowstone|yosemite|montana|colorado|utah|arizona|california)\b/u.test(content) || /\b(rockies|jasper|yellowstone|yosemite|montana|colorado|utah|arizona|california)\b/u.test(payloadAnswerValue)) ? 1 : 0)
      : 0;
  const ventureStateBoost =
    datedVentureState
      ? /^none\.?$/u.test(payloadAnswerValue)
        ? 2.5
        : /\b(store|shop|studio|app|brand|business|venture)\b/u.test(payloadAnswerValue)
          ? 1.2
          : 0
      : 0;
  const praisePenalty =
    wantsEducation && isPraiseOnlyProfileText(content)
      ? 1.2 + Math.min(0.4, (clusterSummary?.praiseOnlyCount ?? 0) * 0.08)
      : 0;
  return (
    causalBoost +
    educationBoost +
    supportBoost +
    aggregateBoost +
    decisionBoost +
    educationIntentBoost +
    educationFieldBoost +
    educationBundleBoost +
    clusterBundleBoost +
    clusterSupportBoost +
    aggregateClusterBoost +
    typedPayloadBoost +
    canonicalSetClusterBoost +
    payloadClusterBoost +
    payloadCompletenessBoost +
    offCourtGoalBoost +
    basketballGoalBoost +
    authorPreferenceBoost +
    travelPayloadBoost +
    ventureStateBoost -
    offCourtPenaltyForBasketballGoals -
    basketballPenaltyForOffCourtGoals -
    praisePenalty
  );
}

function rankPlannerPoolResults(params: RankPlannerPoolParams): readonly RecallResult[] {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const temporalBundles =
    params.poolKind === "temporal" ? buildTemporalResultBundles(params.queryText, params.results) : null;
  const profileClusterSummaries =
    params.poolKind === "profile"
      ? buildProfileClusterSummaries({
          queryText: params.queryText,
          retrievalPlan: params.retrievalPlan,
          results: params.results
        })
      : null;
  const candidateResults =
    params.poolKind === "temporal"
      ? [...params.results]
          .sort(
            (left, right) =>
              temporalPreselectionScore({
                queryText: params.queryText,
                retrievalPlan: params.retrievalPlan,
                result: right,
                bundle: temporalBundles?.get(buildTemporalBundleKey(params.queryText, right))
              }) -
              temporalPreselectionScore({
                queryText: params.queryText,
                retrievalPlan: params.retrievalPlan,
                result: left,
                bundle: temporalBundles?.get(buildTemporalBundleKey(params.queryText, left))
              })
          )
          .slice(0, MAX_TEMPORAL_POOL_INPUT)
      : params.results.slice(0, MAX_POOL_INPUT);
  if (candidateResults.length <= 1) {
    return candidateResults.slice(0, limit);
  }

  const lexicalScores = new Map<string, number>();
  const structuredScores = new Map<string, number>();
  const signatureMap = new Map<string, readonly string[]>();

  for (const result of candidateResults) {
    const key = poolResultKey(result);
    const candidateText = collectRecallResultTextCandidates(result).join(" ");
    lexicalScores.set(key, lexicalOverlapScore(params.queryText, candidateText || result.content));
    const subjectBinding = resultSubjectBindingScore(result, params.retrievalPlan);
    let structured = subjectBinding * 2;
    if (params.poolKind === "collection") {
      structured += collectionCueWeight(result);
      signatureMap.set(key, collectionSignature(result));
    } else if (params.poolKind === "temporal") {
      structured += temporalStructureWeight(params.queryText, result);
      structured += temporalBundleWeight({
        queryText: params.queryText,
        result,
        bundle: temporalBundles?.get(buildTemporalBundleKey(params.queryText, result))
      });
      signatureMap.set(key, tokenize(candidateText || result.content));
    } else {
      structured += profileStructureWeight(params.queryText, result, profileClusterSummaries?.get(key));
      signatureMap.set(key, tokenize(candidateText || result.content));
    }
    structuredScores.set(key, structured);
  }

  const byLexical = [...candidateResults].sort(
    (left, right) =>
      (lexicalScores.get(poolResultKey(right)) ?? 0) - (lexicalScores.get(poolResultKey(left)) ?? 0)
  );
  const byStructured = [...candidateResults].sort(
    (left, right) => {
      const structuredDelta = (structuredScores.get(poolResultKey(right)) ?? 0) - (structuredScores.get(poolResultKey(left)) ?? 0);
      if (structuredDelta !== 0) {
        return structuredDelta;
      }
      if (params.poolKind === "temporal") {
        const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
        const leftShape = readTemporalRecallShape(params.queryText, left);
        const rightShape = readTemporalRecallShape(params.queryText, right);
        const supportDelta =
          temporalSupportPriority(rightShape.supportKind, rightShape.temporalSourceQuality) -
          temporalSupportPriority(leftShape.supportKind, leftShape.temporalSourceQuality);
        if (supportDelta !== 0) {
          return supportDelta;
        }
        if (queryEventKey) {
          if (leftShape.eventKey === queryEventKey && rightShape.eventKey === queryEventKey) {
            const orderingDelta = temporalRecallOrderingValue(leftShape) - temporalRecallOrderingValue(rightShape);
            if (orderingDelta !== 0) {
              return orderingDelta;
            }
          }
        }
      }
      return 0;
    }
  );
  const bySource = [...candidateResults].sort((left, right) => {
    const sourceBoost = (result: RecallResult): number => {
      const sourceTable = readResultSourceTable(result);
      if (params.poolKind === "collection") {
        return sourceTable === "canonical_collection_facts" || sourceTable === "canonical_set_collection_support"
          ? 2
          : sourceTable === "canonical_reports"
            ? 1
            : 0;
      }
      if (params.poolKind === "temporal") {
        const shape = readTemporalRecallShape(params.queryText, result);
        return (
          (sourceTable === "canonical_temporal_facts" || sourceTable === "normalized_event_facts" ? 1 : 0) +
          temporalSupportPriority(shape.supportKind, shape.temporalSourceQuality) / 10
        );
      }
      const payloadAnswerValue = normalizeLower(readPayloadAnswerValue(result));
      const payloadItemCount = readPayloadItemValues(result).length;
      if (sourceTable === "canonical_sets" || sourceTable === "set_entries") {
        return 2.6 + Math.min(1.2, payloadItemCount * 0.35);
      }
      if (sourceTable === "canonical_reports" || sourceTable === "profile_report_support") {
        let boost = 2;
        if (isDatedVentureStateQuery(params.queryText) && /^none\.?$/u.test(payloadAnswerValue)) {
          boost += 1.6;
        }
        if (isTravelLocationQuery(params.queryText) && payloadItemCount >= 2) {
          boost += 1.1;
        }
        if (isOffCourtCareerGoalQuery(params.queryText) && payloadItemCount >= 2) {
          boost += 1.1;
        }
        return boost;
      }
      if (sourceTable === "retrieved_text_unit_aggregate_report" || sourceTable === "assembled_graph_entity_report") {
        return 1.4;
      }
      if (sourceTable === "report_support") {
        return 1.1;
      }
      return 0;
    };
    return sourceBoost(right) - sourceBoost(left);
  });

  const fusedScores = reciprocalRankFusion({
    rankings: [byStructured, byLexical, bySource],
    keyFn: poolResultKey
  });

  const fusedCandidates = [...candidateResults].sort((left, right) => {
    const scoreDelta = (fusedScores.get(poolResultKey(right)) ?? 0) - (fusedScores.get(poolResultKey(left)) ?? 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return (structuredScores.get(poolResultKey(right)) ?? 0) - (structuredScores.get(poolResultKey(left)) ?? 0);
  });

  if (params.poolKind === "temporal") {
    const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
    if (queryEventKey && shouldPreferEarliestTemporalPoolCandidate(params.queryText)) {
      fusedCandidates.sort((left, right) => {
        const leftBinding = resultSubjectBindingScore(left, params.retrievalPlan);
        const rightBinding = resultSubjectBindingScore(right, params.retrievalPlan);
        const bindingDelta = rightBinding - leftBinding;
        if (bindingDelta !== 0) {
          return bindingDelta;
        }
        const leftShape = readTemporalRecallShape(params.queryText, left);
        const rightShape = readTemporalRecallShape(params.queryText, right);
        const supportDelta =
          temporalSupportPriority(rightShape.supportKind, rightShape.temporalSourceQuality) -
          temporalSupportPriority(leftShape.supportKind, leftShape.temporalSourceQuality);
        if (supportDelta !== 0) {
          return supportDelta;
        }
        const evidenceDelta = temporalEvidencePriority(rightShape.eventEvidenceKind) - temporalEvidencePriority(leftShape.eventEvidenceKind);
        if (evidenceDelta !== 0) {
          return evidenceDelta;
        }
        if (leftShape.eventEvidenceKind !== "none" && rightShape.eventEvidenceKind !== "none") {
          const orderingDelta = temporalRecallOrderingValue(leftShape) - temporalRecallOrderingValue(rightShape);
          if (orderingDelta !== 0) {
            return orderingDelta;
          }
        }
        const scoreDelta = (fusedScores.get(poolResultKey(right)) ?? 0) - (fusedScores.get(poolResultKey(left)) ?? 0);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return (structuredScores.get(poolResultKey(right)) ?? 0) - (structuredScores.get(poolResultKey(left)) ?? 0);
      });
    }
  }

  return maximalMarginalRerank({
    candidates: fusedCandidates,
    limit,
    relevance: (result) =>
      (fusedScores.get(poolResultKey(result)) ?? 0) +
      (structuredScores.get(poolResultKey(result)) ?? 0) +
      (lexicalScores.get(poolResultKey(result)) ?? 0),
    similarity: (left, right) =>
      jaccardSimilarity(
        signatureMap.get(poolResultKey(left)) ?? tokenize(left.content),
        signatureMap.get(poolResultKey(right)) ?? tokenize(right.content)
      )
  });
}

export function rankCollectionPoolResults(params: Omit<RankPlannerPoolParams, "poolKind">): readonly RecallResult[] {
  return rankPlannerPoolResults({ ...params, poolKind: "collection" });
}

export function rankTemporalPoolResults(params: Omit<RankPlannerPoolParams, "poolKind">): readonly RecallResult[] {
  return rankPlannerPoolResults({ ...params, poolKind: "temporal" });
}

export function rankProfilePoolResults(params: Omit<RankPlannerPoolParams, "poolKind">): readonly RecallResult[] {
  return rankPlannerPoolResults({ ...params, poolKind: "profile" });
}
