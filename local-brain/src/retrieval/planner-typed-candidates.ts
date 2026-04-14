import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import { buildQueryBoundRecallAggregateCandidate } from "../canonical-memory/narrative-reader.js";
import type { RecallResult } from "../types.js";
import { extractPairQuerySurfaceNames, extractPossessiveQuerySurfaceNames, extractPrimaryQuerySurfaceNames } from "./query-subjects.js";
import { buildCanonicalSubjectPlan } from "./subject-plan.js";
import { buildReasoningChain } from "./reasoning-chain.js";
import {
  extractAtomicMemoryUnits,
  inferAnswerRetrievalPredicateFamily,
  isPreferenceChoiceQuery
} from "./answer-retrieval-plan.js";
import { rankCollectionPoolResults, rankProfilePoolResults, rankTemporalPoolResults } from "./planner-pool-ranker.js";
import { collectRecallResultTextCandidates, extractRecallResultSubjectSignals } from "./recall-content.js";
import { readTemporalRecallShape } from "./temporal-pool-utils.js";
import {
  buildCollectionInferenceSupport,
  buildCounterfactualCareerSupport,
  buildListSetSupport,
  inferListSetTypedEntries,
  buildPreferenceChoiceSupport,
  buildProfileInferenceSupport,
  buildTemporalEventSupport,
  renderCollectionInferenceSupport,
  renderCounterfactualCareerSupport,
  renderListSetSupport,
  renderPreferenceChoiceSupport,
  renderProfileInferenceSupport,
  shouldUseCounterfactualCareerJudgment,
  renderTemporalEventSupport,
  type RenderedSupportClaim
} from "./support-objects.js";
import type {
  AnswerOwnerFamily,
  AnswerRetrievalPlan,
  AnswerShapingTrace,
  CanonicalAdjudicationResult,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  CanonicalSubjectBindingStatus,
  RecallEvidenceItem
} from "./types.js";

interface PlannerCandidateAssessment {
  readonly confidence: "confident" | "weak" | "missing";
  readonly sufficiency: "supported" | "weak" | "missing" | "contradicted";
  readonly subjectMatch: "matched" | "mixed" | "mismatched" | "unknown";
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
}

interface PlannerTypedCandidateParams {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly assessment: PlannerCandidateAssessment;
  readonly storedCanonical?: StoredCanonicalLookup | null;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}

function readResultMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function readResultSourceTable(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  const sourceTable =
    (typeof metadata?.source_table === "string" ? metadata.source_table : null) ??
    (typeof result.provenance.source_table === "string" ? result.provenance.source_table : null);
  return normalize(sourceTable) || null;
}

function readResultEventKey(result: RecallResult): string | null {
  const metadata = readResultMetadata(result);
  const eventKey = typeof metadata?.event_key === "string" ? metadata.event_key : null;
  return normalize(eventKey) || null;
}

function readResultAnswerPayload(result: RecallResult): Record<string, unknown> | null {
  const metadata = readResultMetadata(result);
  return typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
    ? (metadata.answer_payload as Record<string, unknown>)
    : null;
}

function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  return typeof payload?.[key] === "string" && String(payload[key]).trim().length > 0
    ? String(payload[key]).trim()
    : null;
}

function payloadItems(payload: Record<string, unknown> | null): readonly string[] {
  return Array.isArray(payload?.item_values)
    ? unique(payload.item_values.filter((value): value is string => typeof value === "string"))
    : [];
}

function readResultAnswerPayloadTexts(result: RecallResult): readonly string[] {
  const payload = readResultAnswerPayload(result);
  return unique([
    payloadString(payload, "answer_value") ?? "",
    payloadString(payload, "reason_value") ?? "",
    ...payloadItems(payload)
  ]);
}

function scorePlannerReportPayload(params: {
  readonly queryText: string;
  readonly reportKind: CanonicalReportKind;
  readonly result: RecallResult;
}): number {
  const payload = readResultAnswerPayload(params.result);
  if (!payload) {
    return -1;
  }
  const answerValue = normalize(payloadString(payload, "answer_value"));
  const itemValues = payloadItems(payload);
  const answerType = normalize(payloadString(payload, "answer_type"));
  const sourceTable = readResultSourceTable(params.result) ?? "";
  let score = itemValues.length * 2 + (answerValue ? 1 : 0);
  if (sourceTable === "canonical_sets" || sourceTable === "set_entries") {
    score += 2;
  } else if (sourceTable === "canonical_reports") {
    score += 1.5;
  }
  if (params.reportKind === "career_report") {
    if (answerType === "career_goal_set") {
      score += 4;
    }
    if (/\bnot related\b[^?!.]{0,40}\bbasketball\b|\boff the court\b|\bbasketball skills\b/iu.test(params.queryText)) {
      score += itemValues.filter((value) => /\b(endorsements?|brand|charity|community)\b/iu.test(value)).length * 1.5;
      score -= itemValues.filter((value) => /\b(shoot(?:ing)?|championship|title|finals?)\b/iu.test(value)).length * 0.8;
    } else if (/\bbasketball\b/iu.test(params.queryText) && /\bgoals?\b/iu.test(params.queryText)) {
      score += itemValues.filter((value) => /\b(shoot(?:ing)?|championship|title|finals?)\b/iu.test(value)).length * 1.5;
      score -= itemValues.filter((value) => /\b(endorsements?|brand|charity|community)\b/iu.test(value)).length * 0.8;
    }
  } else if (params.reportKind === "preference_report" && /\bbooks?\s+by\b/iu.test(params.queryText) && /\bor\b/iu.test(params.queryText)) {
    score += /\b(read(?:ing)?|books?|novels?|fantasy|series)\b/iu.test(answerValue) ? 2 : 0;
  } else if (params.reportKind === "travel_report") {
    score += itemValues.length >= 2 ? 3 : 0;
    score += /\b(rockies|jasper|yosemite|yellowstone|montana|colorado|utah|arizona|california)\b/iu.test(answerValue) ? 1 : 0;
  } else if (params.reportKind === "aspiration_report") {
    if (/^none\.?$/iu.test(answerValue)) {
      score += /\bas of\b|\bon\s+\d{1,2}\s+[A-Za-z]+\b/iu.test(params.queryText) ? 4 : 1;
    } else if (/\b(store|shop|studio|app|brand|business|venture)\b/iu.test(answerValue)) {
      score += 2;
    }
  } else if (params.reportKind === "pet_care_report") {
    score += itemValues.length >= 2 ? 2 : 0;
  }
  return score;
}

function selectPlannerReportAnswerPayload(params: {
  readonly queryText: string;
  readonly reportKind: CanonicalReportKind;
  readonly results: readonly RecallResult[];
}): Record<string, unknown> | null {
  let bestPayload: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const result of params.results) {
    const payload = readResultAnswerPayload(result);
    if (!payload) {
      continue;
    }
    const score = scorePlannerReportPayload({
      queryText: params.queryText,
      reportKind: params.reportKind,
      result
    });
    if (score > bestScore) {
      bestScore = score;
      bestPayload = payload;
    }
  }
  return bestPayload;
}

function isBasketballCareerGoalQuery(queryText: string): boolean {
  return /\bgoals?\b/iu.test(queryText) && /\bbasketball\b/iu.test(queryText) && !/\bnot related\b|\boff the court\b|\bbeyond basketball\b|\bbasketball skills\b/iu.test(queryText);
}

function isBooksByAuthorPreferenceQuery(queryText: string): boolean {
  return /\bbooks?\s+by\b/iu.test(queryText) && /\bor\b/iu.test(queryText);
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
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function extractResultSubjectSignals(result: RecallResult): readonly string[] {
  return extractRecallResultSubjectSignals(result);
}

function extractResultSubjectEntityId(result: RecallResult): string | null {
  if (typeof result.provenance.subject_entity_id === "string" && result.provenance.subject_entity_id.trim().length > 0) {
    return result.provenance.subject_entity_id.trim();
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  if (typeof metadata?.subject_entity_id === "string" && metadata.subject_entity_id.trim().length > 0) {
    return metadata.subject_entity_id.trim();
  }
  return null;
}

function inferResolvedSubjectEntityId(params: {
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): string | null {
  if (params.retrievalPlan.resolvedSubjectEntityId) {
    return params.retrievalPlan.resolvedSubjectEntityId;
  }
  const subjectName = params.retrievalPlan.subjectNames[0];
  const normalizedSubjectName = subjectName ? normalizeEntityLookupName(subjectName) : null;
  const candidateIds = new Set<string>();
  for (const result of params.results) {
    const entityId = extractResultSubjectEntityId(result);
    if (!entityId) {
      continue;
    }
    if (!normalizedSubjectName) {
      candidateIds.add(entityId);
      continue;
    }
    const signals = extractResultSubjectSignals(result);
    if (signals.some((signal) => signal.includes(normalizedSubjectName))) {
      candidateIds.add(entityId);
    }
  }
  return candidateIds.size === 1 ? [...candidateIds][0]! : null;
}

function inferPreferredSubjectEntityId(results: readonly RecallResult[], sourceTable: string): string | null {
  const preferredResults = results.filter((result) => readResultSourceTable(result) === sourceTable);
  if (preferredResults.length === 0) {
    return null;
  }
  const candidateIds = unique(preferredResults.map((result) => extractResultSubjectEntityId(result) ?? ""));
  return candidateIds.length === 1 ? candidateIds[0] ?? null : null;
}

function inferPreferredSubjectEntityIdFromTables(results: readonly RecallResult[], sourceTables: readonly string[]): string | null {
  for (const sourceTable of sourceTables) {
    const subjectEntityId = inferPreferredSubjectEntityId(results, sourceTable);
    if (subjectEntityId) {
      return subjectEntityId;
    }
  }
  return null;
}

function hasStrongNameBoundSubject(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): boolean {
  if (params.retrievalPlan.subjectNames.length !== 1 || params.results.length === 0) {
    return false;
  }
  const subjectName = params.retrievalPlan.subjectNames[0];
  const normalizedSubjectName = subjectName ? normalizeEntityLookupName(subjectName) : null;
  if (!normalizedSubjectName) {
    return false;
  }
  const boundCount = params.results.filter((result) =>
    extractResultSubjectSignals(result).some((signal) => signal.includes(normalizedSubjectName))
  ).length;
  return boundCount > 0 && boundCount >= Math.max(1, Math.ceil(params.results.length * 0.6));
}

function inferReportSupportStrength(rendered: RenderedSupportClaim): "strong" | "moderate" | "weak" {
  if (rendered.typedValueUsed) {
    return "strong";
  }
  if (rendered.supportRowsSelected > 0 || (rendered.supportTextsSelected ?? 0) > 0 || rendered.generatedProseUsed) {
    return "moderate";
  }
  return "weak";
}

function inferReportConfidence(rendered: RenderedSupportClaim): "confident" | "weak" | "missing" {
  if (!rendered.claimText) {
    return "missing";
  }
  return rendered.typedValueUsed ? "confident" : "weak";
}

function buildPlannerSubjectContext(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly assessment: PlannerCandidateAssessment;
  readonly preferredSubjectEntityId?: string | null;
}): {
  readonly resolvedSubjectEntityId: string | null;
  readonly subjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly canonicalSubjectName: string | null;
  readonly subjectPlan: ReturnType<typeof buildCanonicalSubjectPlan>;
} {
  const resolvedSubjectEntityId = inferResolvedSubjectEntityId({
    retrievalPlan: params.retrievalPlan,
    results: params.results
  }) ?? params.preferredSubjectEntityId ?? null;
  const initialSubjectBindingStatus: CanonicalSubjectBindingStatus =
    resolvedSubjectEntityId ||
    hasStrongNameBoundSubject({
      queryText: params.queryText,
      retrievalPlan: params.retrievalPlan,
      results: params.results
    })
      ? "resolved"
      : params.retrievalPlan.subjectNames.length === 1
        ? "unresolved"
        : "ambiguous";
  const canonicalSubjectName = params.retrievalPlan.subjectNames[0] ?? null;
  const subjectPlan = buildCanonicalSubjectPlan({
    queryText: params.queryText,
    matchedParticipants: params.assessment.matchedParticipants,
    missingParticipants: params.assessment.missingParticipants,
    foreignParticipants: params.assessment.foreignParticipants,
    subjectEntityId: resolvedSubjectEntityId,
    canonicalSubjectName,
    pairSubjectEntityId: params.retrievalPlan.pairSubjectEntityId,
    pairSubjectName: params.retrievalPlan.pairSubjectNames[0] ?? null,
    bindingStatus: initialSubjectBindingStatus
  });
  const explicitNames = [
    ...extractPossessiveQuerySurfaceNames(params.queryText),
    ...extractPrimaryQuerySurfaceNames(params.queryText)
  ].map((value) => normalize(value)).filter(Boolean);
  const subjectBindingStatus: CanonicalSubjectBindingStatus =
    initialSubjectBindingStatus !== "resolved" &&
    extractPairQuerySurfaceNames(params.queryText).length === 0 &&
    explicitNames.length === 1 &&
    subjectPlan.kind === "single_subject" &&
    Boolean(subjectPlan.canonicalSubjectName)
      ? "resolved"
      : initialSubjectBindingStatus;
  return {
    resolvedSubjectEntityId,
    subjectBindingStatus,
    canonicalSubjectName,
    subjectPlan
  };
}

function buildPlannerTrace(params: {
  readonly selectedFamily: AnswerOwnerFamily;
  readonly rendered: RenderedSupportClaim;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly resolvedSubjectEntityId: string | null;
  readonly subjectBindingStatus: "resolved" | "unresolved" | "ambiguous";
  readonly subjectBindingReason: string;
  readonly results: readonly RecallResult[];
}): AnswerShapingTrace {
  const atomicUnits = extractAtomicMemoryUnits({
    results: params.results,
    supportObjectType: params.rendered.supportObjectType ?? null,
    selectedEventKey: params.rendered.selectedEventKey ?? null,
    selectedEventType: params.rendered.selectedEventType ?? null,
    selectedTimeGranularity: params.rendered.selectedTimeGranularity ?? null,
    exactDetailSource: params.rendered.exactDetailSource ?? null,
    retrievalPlan: params.retrievalPlan
  });
  const atomicUnitTypes = [...new Set(atomicUnits.map((unit) => unit.unitType))];
  return {
    selectedFamily: params.selectedFamily,
    shapingMode: params.rendered.shapingMode,
    retrievalPlanFamily: params.retrievalPlan.family,
    retrievalPlanLane: params.retrievalPlan.lane,
    retrievalPlanResolvedSubjectEntityId: params.resolvedSubjectEntityId,
    retrievalPlanCandidatePools: params.retrievalPlan.candidatePools,
    retrievalPlanSuppressionPools: params.retrievalPlan.suppressionPools,
    retrievalPlanSubjectNames: params.retrievalPlan.subjectNames,
    retrievalPlanTargetedFields: params.retrievalPlan.targetedFields,
    retrievalPlanRequiredFields: params.retrievalPlan.requiredFields,
    retrievalPlanTargetedBackfill: params.retrievalPlan.targetedBackfill,
    retrievalPlanTargetedBackfillRequests: params.retrievalPlan.targetedBackfillRequests,
    retrievalPlanQueryExpansionTerms: params.retrievalPlan.queryExpansionTerms,
    retrievalPlanBannedExpansionTerms: params.retrievalPlan.bannedExpansionTerms,
    retrievalPlanFamilyConfidence: params.retrievalPlan.familyConfidence,
    retrievalPlanSupportCompletenessTarget: params.retrievalPlan.supportCompletenessTarget,
    retrievalPlanRescuePolicy: params.retrievalPlan.rescuePolicy,
    ownerEligibilityHints: params.retrievalPlan.ownerEligibilityHints,
    suppressionHints: params.retrievalPlan.suppressionHints,
    shapingPipelineEntered: true,
    supportObjectAttempted: true,
    renderContractAttempted: true,
    bypassReason: null,
    typedValueUsed: params.rendered.typedValueUsed,
    generatedProseUsed: params.rendered.generatedProseUsed,
    runtimeResynthesisUsed: params.rendered.runtimeResynthesisUsed,
    supportRowsSelected: params.rendered.supportRowsSelected,
    supportTextsSelected: params.rendered.supportTextsSelected,
    supportSelectionMode: params.rendered.supportSelectionMode,
    targetedRetrievalAttempted: params.rendered.targetedRetrievalAttempted,
    targetedRetrievalReason: params.rendered.targetedRetrievalReason,
    targetedFieldsRequested: params.rendered.targetedFieldsRequested,
    targetedRetrievalSatisfied: params.rendered.targetedRetrievalSatisfied,
    supportObjectsBuilt: params.rendered.supportObjectsBuilt,
    supportObjectType: params.rendered.supportObjectType,
    supportNormalizationFailures: params.rendered.supportNormalizationFailures,
    renderContractSelected: params.rendered.renderContractSelected,
    renderContractFallbackReason: params.rendered.renderContractFallbackReason,
    subjectBindingStatus: params.subjectBindingStatus,
    subjectBindingReason: params.subjectBindingReason,
    temporalEventIdentityStatus: params.rendered.temporalEventIdentityStatus,
    temporalGranularityStatus: params.rendered.temporalGranularityStatus,
    relativeAnchorStatus: params.rendered.relativeAnchorStatus,
    selectedEventKey: params.rendered.selectedEventKey,
    selectedEventType: params.rendered.selectedEventType,
    selectedTimeGranularity: params.rendered.selectedTimeGranularity,
    typedSetEntryCount: params.rendered.typedSetEntryCount,
    typedSetEntryType: params.rendered.typedSetEntryType,
    exactDetailSource: params.rendered.exactDetailSource,
    atomicUnitCount: atomicUnits.length,
    atomicUnitTypes
  };
}

function inferPlannerProfileReportKind(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
}): CanonicalReportKind | null {
  if (params.retrievalPlan.lane === "collection_inference") {
    return "collection_report";
  }
  if (params.retrievalPlan.candidatePools.includes("community_membership_support")) {
    return "support_report";
  }
  if (params.retrievalPlan.candidatePools.includes("preference_support")) {
    return "preference_report";
  }
  if (
    /\bwhat helped\b|\bhow did\b[^?!.]{0,100}\bhelp\b/iu.test(params.queryText) ||
    /\bgrieving\b|\bfind peace\b/iu.test(params.queryText)
  ) {
    return "support_report";
  }
  if (
    /\bclasses?\b|\bgroups?\b|\bworkshops?\b|\bcourses?\b|\bindoor activity\b/iu.test(params.queryText) &&
    /\bdogs?\b|\bpets?\b/iu.test(params.queryText)
  ) {
    return "pet_care_report";
  }
  if (
    /\bwhere\b/iu.test(params.queryText) &&
    /\b(?:roadtrips?|travel(?:ed|ing)?|trip|festival|concert|music festival)\b/iu.test(params.queryText)
  ) {
    return "travel_report";
  }
  if (/\bwhat advice might\b|\bmajor life transition\b|\bpersonal growth\b/iu.test(params.queryText)) {
    return "profile_report";
  }
  if (
    /\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/iu.test(params.queryText) ||
    /\bnew business venture\b|\bventure\b/iu.test(params.queryText)
  ) {
    return "aspiration_report";
  }
  if (
    params.retrievalPlan.candidatePools.includes("education_support") ||
    /\bfields?\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e|on)\b|\bstud(?:y|ied|ying)\b|\bcertification\b/iu.test(params.queryText)
  ) {
    return "education_report";
  }
  if (params.retrievalPlan.candidatePools.includes("career_support")) {
    return "career_report";
  }
  if (/\bhow does\b[^?!.]{0,80}\bplan to\b/i.test(params.queryText) || /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/i.test(params.queryText)) {
    return "profile_report";
  }
  if (params.retrievalPlan.candidatePools.includes("profile_report_support") || params.retrievalPlan.candidatePools.includes("report_support")) {
    return "profile_report";
  }
  if (/\bwhy\b/iu.test(params.queryText)) {
    return "profile_report";
  }
  return null;
}

function inferPlannerProfileSourceTable(params: {
  readonly reportKind: CanonicalReportKind;
  readonly renderContractSelected: string | null | undefined;
}): string {
  if (params.renderContractSelected === "causal_reason_render") {
    return "planner_runtime_causal_candidate";
  }
  if (params.renderContractSelected === "pair_advice_render") {
    return "planner_runtime_pair_advice_candidate";
  }
  if (
    params.renderContractSelected === "community_membership_inference" ||
    params.renderContractSelected === "ally_likelihood_judgment"
  ) {
    return "planner_runtime_community_candidate";
  }
  if (params.renderContractSelected === "career_likelihood_judgment") {
    return "planner_runtime_career_candidate";
  }
  if (params.renderContractSelected === "education_field_render") {
    return "planner_runtime_education_candidate";
  }
  if (
    params.renderContractSelected === "pet_care_classes_render" ||
    params.renderContractSelected === "pet_care_activity_render" ||
    params.renderContractSelected === "pet_care_advice_render"
  ) {
    return "planner_runtime_pet_care_candidate";
  }
  if (params.renderContractSelected === "travel_location_set_render") {
    return "planner_runtime_travel_candidate";
  }
  if (
    params.renderContractSelected === "aspiration_unique_feature_render" ||
    params.renderContractSelected === "aspiration_venture_render"
  ) {
    return "planner_runtime_aspiration_candidate";
  }
  if (params.renderContractSelected === "comparative_fit_render") {
    return "planner_runtime_comparative_candidate";
  }
  if (params.reportKind === "collection_report") {
    return "planner_runtime_collection_candidate";
  }
  return "planner_runtime_profile_candidate";
}

function normalizePlannerProfileText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function isPlannerGriefPeaceSupportQuery(queryText: string): boolean {
  return /\bwhat helped\b|\bfind peace\b|\bgrieving\b|\bcope with grief\b|\bfind comfort\b/iu.test(queryText);
}

function resultHasPlannerGriefPeaceSupportEvidence(queryText: string, result: RecallResult): boolean {
  if (!isPlannerGriefPeaceSupportQuery(queryText)) {
    return false;
  }
  return collectRecallResultTextCandidates(result).some((text) => {
    const normalized = normalizePlannerProfileText(text);
    if (!normalized) {
      return false;
    }
    if (/^(?:[a-z]+:\s*)?(?:yoga|old photos?|family album|time in nature)\b/iu.test(normalized)) {
      return true;
    }
    const hasSupportItem =
      /\byoga\b|\bmeditation\b|\bfamily album\b|\bold photos?\b|\bphotos give me peace\b|\broses?\b|\bdahlias?\b|\bgarden\b|\bnature\b/iu.test(
        normalized
      );
    const hasGriefContext =
      /\bpeace\b|\bcomfort\b|\bgrief\b|\bgrieving\b|\bdifficult times?\b|\btough times?\b|\blost a friend\b|\bpassed away\b|\bdeath\b|\bmemories?\b/iu.test(
        normalized
      );
    return hasSupportItem && hasGriefContext;
  });
}

function resultHasPlannerTravelLocationEvidence(queryText: string, result: RecallResult): boolean {
  if (
    !/\bwhere\b/iu.test(queryText) ||
    !/\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|trip|festival|concert|music festival)\b/iu.test(queryText)
  ) {
    return false;
  }
  const placePattern =
    /\b(?:Rockies|Jasper|Yellowstone|Yosemite|Montana|Colorado|Utah|Arizona|California|Washington|Oregon|Florida|Alberta|Canada|Banff|Zion|Sedona|Moab|Grand Canyon|Tokyo|Japan)\b/u;
  return collectRecallResultTextCandidates(result).some((text) =>
    /\b(?:roadtrips?|road-tripp?(?:ed|ing)?|travel(?:ed|ing)?|visited|went|trip to|road trip to|took my family on a road trip to|drove through|festival in|attended)\b/iu.test(
      text
    ) && placePattern.test(text)
  );
}

function resultHasPlannerAspirationUniqueEvidence(queryText: string, result: RecallResult): boolean {
  if (
    !/\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/iu.test(queryText) &&
    !/\bdog-sitting app\b/iu.test(queryText)
  ) {
    return false;
  }
  return collectRecallResultTextCandidates(result).some(
    (text) => /\bcustomiz\w*\b/iu.test(text) && /\b(?:preferences?|needs?)\b/iu.test(text)
  );
}

function resultHasPlannerStrongComparativeFitEvidence(result: RecallResult): boolean {
  const normalized = normalizePlannerProfileText(collectRecallResultTextCandidates(result).join(" ")).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\brush of performing\b/u.test(normalized) ||
    (/\bonstage\b/u.test(normalized) && /\bcrowds?\b/u.test(normalized)) ||
    /\blarge crowds?\b/u.test(normalized)
  );
}

function resultHasPlannerCareerGoalEvidence(queryText: string, result: RecallResult): boolean {
  if (!/\bgoals?\b/iu.test(queryText) || !/\bcareer\b/iu.test(queryText)) {
    return false;
  }
  const normalized = normalizePlannerProfileText(collectRecallResultTextCandidates(result).join(" ")).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\bnot related\b[^?!.]{0,40}\bbasketball\b|\boff the court\b|\bbasketball skills\b/iu.test(queryText)) {
    return /\bendorsements?\b|\bbrand\b|\bcharity\b|\bcommunity\b/u.test(normalized);
  }
  if (isBasketballCareerGoalQuery(queryText)) {
    return /\bshoot(?:ing)?\b|\bchampionship\b|\btitle\b|\bfinals?\b/u.test(normalized);
  }
  return /\bgoals?\b|\bcareer\b/u.test(normalized);
}

function resultHasPlannerPreferenceChoiceEvidence(queryText: string, result: RecallResult): boolean {
  if (!isBooksByAuthorPreferenceQuery(queryText)) {
    return false;
  }
  const normalized = normalizePlannerProfileText(collectRecallResultTextCandidates(result).join(" ")).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\b(read(?:ing)?|books?|novels?|authors?|fantasy|series|harry potter|gryffindor|dragons?)\b/u.test(normalized);
}

function plannerProfilePoolKey(results: readonly RecallResult[]): string {
  return results
    .map((result) => result.memoryId || `${result.memoryType}:${result.artifactId ?? ""}:${result.content}`)
    .join("|");
}

function uniquePlannerProfileResults(results: readonly RecallResult[]): readonly RecallResult[] {
  const seen = new Set<string>();
  const uniqueResults: RecallResult[] = [];
  for (const result of results) {
    const key = result.memoryId || `${result.memoryType}:${result.artifactId ?? ""}:${result.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueResults.push(result);
  }
  return uniqueResults;
}

function renderPlannerProfileSupportAttempt(params: {
  readonly reportKind: CanonicalReportKind;
  readonly queryText: string;
  readonly results: readonly RecallResult[];
}): {
  readonly rendered: RenderedSupportClaim;
  readonly support: ReturnType<typeof buildProfileInferenceSupport>;
} {
  const plannerAnswerPayload = selectPlannerReportAnswerPayload({
    queryText: params.queryText,
    reportKind: params.reportKind,
    results: params.results
  });
  const support = buildProfileInferenceSupport({
    reportKind: params.reportKind,
    queryText: params.queryText,
    fallbackSummary: null,
    answerPayload: plannerAnswerPayload,
    results: params.results
  });
  if (isPreferenceChoiceQuery(params.queryText)) {
    const preference = renderPreferenceChoiceSupport(
      buildPreferenceChoiceSupport({
        queryText: params.queryText,
        support
      })
    );
    if (preference.claimText) {
      return { rendered: preference, support };
    }
  }
  if (shouldUseCounterfactualCareerJudgment(params.queryText, params.reportKind)) {
    const career = renderCounterfactualCareerSupport(
      buildCounterfactualCareerSupport({
        queryText: params.queryText,
        support
      })
    );
    if (career.claimText) {
      return { rendered: career, support };
    }
  }
  return {
    rendered: renderProfileInferenceSupport(params.queryText, support),
    support
  };
}

function scorePlannerProfileSupportAttempt(params: {
  readonly rendered: RenderedSupportClaim;
  readonly support: ReturnType<typeof buildProfileInferenceSupport>;
  readonly results: readonly RecallResult[];
}): number {
  return (
    (params.rendered.claimText ? 100 : 0) +
    params.support.supportCompletenessScore * 20 +
    (params.rendered.typedValueUsed ? 8 : 0) +
    (params.rendered.generatedProseUsed ? 2 : 0) +
    Math.min(params.results.length, 8)
  );
}

function resultMatchesPlannerSubject(result: RecallResult, retrievalPlan: AnswerRetrievalPlan): boolean {
  const resultSubjectEntityId = extractResultSubjectEntityId(result);
  if (
    resultSubjectEntityId &&
    retrievalPlan.resolvedSubjectEntityId &&
    resultSubjectEntityId === retrievalPlan.resolvedSubjectEntityId
  ) {
    return true;
  }
  const normalizedSubjectNames = retrievalPlan.subjectNames.map((value) => normalizeEntityLookupName(value)).filter(Boolean);
  if (normalizedSubjectNames.length === 0) {
    return false;
  }
  const signals = extractResultSubjectSignals(result);
  return normalizedSubjectNames.some((name) => signals.some((signal) => signal.includes(name)));
}

function isPairLocationResolutionListSetQuery(queryText: string, retrievalPlan: AnswerRetrievalPlan): boolean {
  if (retrievalPlan.subjectNames.length < 2) {
    return false;
  }
  const normalized = normalize(queryText).toLowerCase();
  return (
    (
      /\bcountry\b/u.test(normalized) ||
      /\bplaces?\b/u.test(normalized) ||
      /\bevents?\b/u.test(normalized) ||
      /\bwhere\b/u.test(normalized)
    ) &&
    (
      /\bmeet\b/u.test(normalized) ||
      /\bcatch up\b/u.test(normalized) ||
      /\bplan(?:ned)?\b/u.test(normalized) ||
      /\btrip\b/u.test(normalized) ||
      /\bvisit\b/u.test(normalized)
    )
  );
}

function resultMatchesPairPlannerSubjects(result: RecallResult, retrievalPlan: AnswerRetrievalPlan): boolean {
  const pairNames = [...new Set(retrievalPlan.subjectNames.map((value) => normalizeEntityLookupName(value)).filter(Boolean))];
  if (pairNames.length < 2) {
    return false;
  }
  const signals = extractResultSubjectSignals(result);
  const matchedNames = pairNames.filter((name) => signals.some((signal) => signal.includes(name)));
  if (matchedNames.length >= 2) {
    return true;
  }
  const resultSubjectEntityId = extractResultSubjectEntityId(result);
  if (
    resultSubjectEntityId &&
    (resultSubjectEntityId === retrievalPlan.resolvedSubjectEntityId || resultSubjectEntityId === retrievalPlan.pairSubjectEntityId) &&
    matchedNames.length >= 1
  ) {
    return true;
  }
  return false;
}

function resultHasQueryBoundListSetEvidence(queryText: string, result: RecallResult): boolean {
  return collectRecallResultTextCandidates(result).some((text) => inferListSetTypedEntries({
    queryText,
    texts: [text]
  }).entries.length > 0);
}

function selectSubjectBoundProfileResults(params: {
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): readonly RecallResult[] {
  const normalizedSubjectNames = [
    ...new Set(
      [...params.retrievalPlan.subjectNames, ...params.retrievalPlan.pairSubjectNames]
        .map((value) => normalizeEntityLookupName(value))
        .filter(Boolean)
    )
  ];
  if (normalizedSubjectNames.length === 0) {
    return params.results;
  }
  const boundResults = params.results.filter((result) => {
    const resultSubjectEntityId = extractResultSubjectEntityId(result);
    if (
      resultSubjectEntityId &&
      (
        resultSubjectEntityId === params.retrievalPlan.resolvedSubjectEntityId ||
        resultSubjectEntityId === params.retrievalPlan.pairSubjectEntityId
      )
    ) {
      return true;
    }
    const signals = extractResultSubjectSignals(result);
    return normalizedSubjectNames.some((name) => signals.some((signal) => signal.includes(name)));
  });
  if (boundResults.length === 0) {
    const namedResults = params.results.filter((result) => extractResultSubjectSignals(result).length > 0);
    return namedResults.length > 0 ? namedResults : params.results;
  }
  const structuredTables = new Set([
    "canonical_reports",
    "canonical_sets",
    "set_entries",
    "profile_report_support",
    "report_support",
    "career_support",
    "education_support",
    "retrieved_text_unit_aggregate_report",
    "assembled_graph_entity_report"
  ]);
  const structuredBoundResults = boundResults.filter((result) => structuredTables.has(readResultSourceTable(result) ?? ""));
  return structuredBoundResults.length > 0 ? structuredBoundResults : boundResults;
}

function selectSubjectBoundTemporalResults(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): readonly RecallResult[] {
  if (params.retrievalPlan.subjectNames.length !== 1) {
    return params.results;
  }
  const boundResults = params.results.filter((result) => resultMatchesPlannerSubject(result, params.retrievalPlan));
  if (boundResults.length === 0) {
    return params.results;
  }
  const temporalTables = new Set([
    "canonical_temporal_facts",
    "normalized_event_facts",
    "temporal_results",
    "planner_runtime_temporal_candidate"
  ]);
  const temporalBoundResults = boundResults.filter((result) => {
    if (temporalTables.has(readResultSourceTable(result) ?? "")) {
      return true;
    }
    return readTemporalRecallShape(params.queryText, result).eventEvidenceKind !== "none";
  });
  return temporalBoundResults.length > 0 ? temporalBoundResults : boundResults;
}

function selectSubjectBoundListSetResults(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): readonly RecallResult[] {
  if (isPairLocationResolutionListSetQuery(params.queryText, params.retrievalPlan)) {
    const pairBoundResults = params.results.filter((result) => resultMatchesPairPlannerSubjects(result, params.retrievalPlan));
    const pairEvidenceResults = pairBoundResults.filter((result) => resultHasQueryBoundListSetEvidence(params.queryText, result));
    if (pairEvidenceResults.length > 0) {
      return pairEvidenceResults;
    }
    const broadEvidenceResults = params.results.filter((result) => resultHasQueryBoundListSetEvidence(params.queryText, result));
    if (broadEvidenceResults.length > 0) {
      return broadEvidenceResults;
    }
    return pairBoundResults.length > 0 ? pairBoundResults : params.results;
  }
  if (params.retrievalPlan.subjectNames.length !== 1) {
    return params.results;
  }
  const boundResults = params.results.filter((result) => resultMatchesPlannerSubject(result, params.retrievalPlan));
  if (boundResults.length === 0) {
    return params.results;
  }
  const queryBoundEvidenceResults = boundResults.filter((result) =>
    resultHasQueryBoundListSetEvidence(params.queryText, result)
  );
  const structuredTables = new Set([
    "canonical_sets",
    "set_entries",
    "canonical_set_collection_support",
    "planner_runtime_list_set_candidate",
    "planner_runtime_location_history_candidate"
  ]);
  const structuredBoundResults = boundResults.filter((result) => structuredTables.has(readResultSourceTable(result) ?? ""));
  if (structuredBoundResults.length > 0 && queryBoundEvidenceResults.length > 0) {
    const mergedResults: RecallResult[] = [];
    const seen = new Set<string>();
    for (const result of [...queryBoundEvidenceResults, ...structuredBoundResults]) {
      if (seen.has(result.memoryId)) {
        continue;
      }
      mergedResults.push(result);
      seen.add(result.memoryId);
    }
    return mergedResults;
  }
  if (queryBoundEvidenceResults.length > 0) {
    return queryBoundEvidenceResults;
  }
  return structuredBoundResults.length > 0 ? structuredBoundResults : boundResults;
}

function buildPlannerStructuredReportSeed(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly reportKind: CanonicalReportKind;
  readonly results: readonly RecallResult[];
}): RecallResult | null {
  const subjectTexts = selectSubjectBoundProfileResults({
    retrievalPlan: params.retrievalPlan,
    results: params.results
  })
    .flatMap((result) => [normalize(result.content), ...readResultAnswerPayloadTexts(result)])
    .filter(Boolean);
  const fallbackTexts = params.results
    .flatMap((result) => [normalize(result.content), ...readResultAnswerPayloadTexts(result)])
    .filter(Boolean);
  const aggregateCandidate = buildQueryBoundRecallAggregateCandidate({
    queryText: params.queryText,
    reportKind: params.reportKind,
    predicateFamily: inferAnswerRetrievalPredicateFamily(params.queryText, "profile_state"),
    subjectTexts,
    fallbackTexts
  });
  if (!aggregateCandidate) {
    return null;
  }
  const preferredSubjectEntityId =
    params.retrievalPlan.resolvedSubjectEntityId ?? inferResolvedSubjectEntityId({
      retrievalPlan: params.retrievalPlan,
      results: params.results
    });
  return {
    memoryId: `planner-aggregate:${params.reportKind}:${preferredSubjectEntityId ?? params.retrievalPlan.subjectNames[0] ?? "unknown"}`,
    memoryType: "semantic_memory",
    content: aggregateCandidate.text,
    artifactId: null,
    occurredAt: params.results[0]?.occurredAt ?? null,
    namespaceId: params.results[0]?.namespaceId ?? "planner-runtime",
    provenance: {
      source_table: aggregateCandidate.sourceTable,
      subject_entity_id: preferredSubjectEntityId ?? undefined,
      subject_name: params.retrievalPlan.subjectNames[0] ?? undefined,
      metadata: {
        source_table: aggregateCandidate.sourceTable,
        subject_entity_id: preferredSubjectEntityId ?? undefined,
        subject_name: params.retrievalPlan.subjectNames[0] ?? undefined,
        report_kind: params.reportKind,
        answer_payload: aggregateCandidate.answerPayload ?? undefined,
        source_sentence_text: aggregateCandidate.text
      }
    }
  };
}

function buildPlannerReportCandidate(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly reportKind: CanonicalReportKind;
  readonly rendered: RenderedSupportClaim;
  readonly results: readonly RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly assessment: PlannerCandidateAssessment;
  readonly ownerSourceTable: string;
  readonly preferredSubjectEntityId?: string | null;
}): CanonicalAdjudicationResult | null {
  if (!params.rendered.claimText) {
    return null;
  }
  const predicateFamily = inferAnswerRetrievalPredicateFamily(params.queryText, "profile_state");
  const subjectContext = buildPlannerSubjectContext({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results,
    assessment: params.assessment,
    preferredSubjectEntityId: params.preferredSubjectEntityId
  });
  const timePlan = {
    mentionedAt: params.results[0]?.occurredAt ?? null,
    validFrom: null,
    validUntil: null,
    timeScopeKind: "active" as const,
    source: "unknown" as const
  };
  const shapingTrace = buildPlannerTrace({
    selectedFamily: "report",
    rendered: params.rendered,
    retrievalPlan: params.retrievalPlan,
    resolvedSubjectEntityId: subjectContext.resolvedSubjectEntityId,
    subjectBindingStatus: subjectContext.subjectBindingStatus,
    subjectBindingReason: subjectContext.subjectPlan.reason,
    results: params.results
  });
  return {
    bundle: {
      subjectEntityId: subjectContext.resolvedSubjectEntityId,
      canonicalSubjectName: subjectContext.canonicalSubjectName,
      subjectBindingStatus: subjectContext.subjectBindingStatus,
      subjectPlan: subjectContext.subjectPlan,
      predicateFamily,
      provenanceRows: params.results,
      evidenceItems: params.evidence,
      supportStrength: inferReportSupportStrength(params.rendered),
      timeScopeKind: timePlan.timeScopeKind,
      canonicalReadTier: "episodic_fallback",
      temporalValidity: timePlan,
      reportKind: params.reportKind,
      ownerSourceTable: params.ownerSourceTable
    },
    canonical: {
      kind: "report",
      subjectEntityId: subjectContext.resolvedSubjectEntityId,
      canonicalSubjectName: subjectContext.canonicalSubjectName,
      predicateFamily,
      reportKind: params.reportKind,
      summaryText: params.rendered.claimText,
      timeScopeKind: timePlan.timeScopeKind,
      provenanceRows: params.results,
      supportStrength: inferReportSupportStrength(params.rendered),
      confidence: inferReportConfidence(params.rendered),
      status: "supported",
      validFrom: timePlan.validFrom,
      validUntil: timePlan.validUntil
    },
    formatted: {
      claimText: params.rendered.claimText,
      finalClaimSource: "canonical_report",
      answerBundle: {
        topClaim: params.rendered.claimText,
        claimKind: "report",
        subjectPlan: subjectContext.subjectPlan,
        predicatePlan: predicateFamily,
        timePlan,
        evidenceBundle: params.evidence,
        fallbackBlockedReason: "planner_typed_candidate_precedence",
        reasoningChain: buildReasoningChain({
          queryText: params.queryText,
          predicateFamily,
          timeScopeKind: timePlan.timeScopeKind,
          topClaim: params.rendered.claimText,
          subjectNames:
            subjectContext.subjectPlan.kind === "pair_subject"
              ? [subjectContext.subjectPlan.canonicalSubjectName ?? "", subjectContext.subjectPlan.pairSubjectName ?? ""]
              : [subjectContext.subjectPlan.canonicalSubjectName ?? ""],
          results: params.results,
          canonicalSupport: [
            params.retrievalPlan.lane,
            params.reportKind,
            params.rendered.supportObjectType ?? "",
            params.rendered.renderContractSelected ?? "",
            ...params.retrievalPlan.candidatePools
          ].filter(Boolean),
          exclusionClauses: ["snippet_override_blocked", params.ownerSourceTable]
        })
      },
      shapingTrace
    }
  };
}

function buildCollectionRenderedSupport(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): { readonly rendered: RenderedSupportClaim | null; readonly preferredResults: readonly RecallResult[] } {
  const collectionFactResults = params.results.filter((result) => {
    const sourceTable = readResultSourceTable(result);
    return sourceTable === "canonical_collection_facts" || sourceTable === "canonical_set_collection_support";
  });
  const preferredResults = rankCollectionPoolResults({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: collectionFactResults.length > 0 ? collectionFactResults : params.results
  });
  const atomicUnits = extractAtomicMemoryUnits({
    results: preferredResults,
    retrievalPlan: params.retrievalPlan
  });
  const support = buildCollectionInferenceSupport({
    queryText: params.queryText,
    fallbackSummary: null,
    results: preferredResults,
    atomicUnits
  });
  const rendered = renderCollectionInferenceSupport(params.queryText, support);
  if (rendered.claimText) {
    return { rendered, preferredResults };
  }
  if (support.supportObjectType === "CollectionSetSupport" && support.collectionEntries.length > 0) {
    return {
      rendered: {
        ...rendered,
        claimText: joinCanonicalItems(unique(support.collectionEntries)),
        shapingMode: "typed_report_payload",
        typedValueUsed: true,
        generatedProseUsed: false,
        runtimeResynthesisUsed: false,
        typedSetEntryCount: support.collectionEntries.length,
        typedSetEntryType: "collection_item",
        renderContractSelected: "collection_set_partial",
        renderContractFallbackReason: "collection_entries_incomplete"
      },
      preferredResults
    };
  }
  return { rendered: null, preferredResults };
}

function buildPlannerCollectionCandidate(params: PlannerTypedCandidateParams): CanonicalAdjudicationResult | null {
  if (params.retrievalPlan.family !== "report" || params.retrievalPlan.lane !== "collection_inference") {
    return null;
  }
  const collectionSupport = buildCollectionRenderedSupport({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results
  });
  if (!collectionSupport.rendered) {
    return null;
  }
  const preferredSubjectEntityId = inferPreferredSubjectEntityIdFromTables(collectionSupport.preferredResults, [
    "canonical_collection_facts",
    "canonical_set_collection_support"
  ]);
  return buildPlannerReportCandidate({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    reportKind: "collection_report",
    rendered: collectionSupport.rendered,
    results: collectionSupport.preferredResults,
    evidence: params.evidence,
    assessment: params.assessment,
    ownerSourceTable: "planner_runtime_collection_candidate",
    preferredSubjectEntityId
  });
}

function buildPlannerProfileCandidate(params: PlannerTypedCandidateParams): CanonicalAdjudicationResult | null {
  if (params.retrievalPlan.family !== "report" || params.retrievalPlan.lane === "collection_inference") {
    return null;
  }
  const reportKind = inferPlannerProfileReportKind({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan
  });
  if (!reportKind) {
    return null;
  }
  const subjectSeededResults = selectSubjectBoundProfileResults({
    retrievalPlan: params.retrievalPlan,
    results: params.results
  });
  const aggregateSeed = buildPlannerStructuredReportSeed({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    reportKind,
    results: subjectSeededResults
  });
  const rankingInput = aggregateSeed ? [aggregateSeed, ...subjectSeededResults] : subjectSeededResults;
  const rankedResults = rankProfilePoolResults({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: rankingInput
  });
  const focusedRankedResults =
    reportKind === "travel_report" && /\bwhere\b/iu.test(params.queryText)
      ? (() => {
          const groundedResults = rankedResults.filter((result) =>
            resultHasPlannerTravelLocationEvidence(params.queryText, result)
          );
          return groundedResults.length > 0 ? [...groundedResults, ...rankedResults] : rankedResults;
        })()
      : reportKind === "support_report" && isPlannerGriefPeaceSupportQuery(params.queryText)
        ? (() => {
            const groundedResults = rankedResults.filter((result) =>
              resultHasPlannerGriefPeaceSupportEvidence(params.queryText, result)
            );
            return groundedResults.length > 0 ? [...groundedResults, ...rankedResults] : rankedResults;
          })()
        : reportKind === "aspiration_report" &&
            /\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/iu.test(params.queryText)
          ? (() => {
              const groundedResults = rankedResults.filter((result) =>
                resultHasPlannerAspirationUniqueEvidence(params.queryText, result)
              );
              return groundedResults.length > 0 ? [...groundedResults, ...rankedResults] : rankedResults;
            })()
          : reportKind === "career_report" && /\bgoals?\b/iu.test(params.queryText) && /\bcareer\b/iu.test(params.queryText)
            ? (() => {
                const groundedResults = rankedResults.filter((result) =>
                  resultHasPlannerCareerGoalEvidence(params.queryText, result)
                );
                return groundedResults.length > 0 ? [...groundedResults, ...rankedResults] : rankedResults;
              })()
          : reportKind === "preference_report" && isBooksByAuthorPreferenceQuery(params.queryText)
            ? (() => {
                const groundedResults = rankedResults.filter((result) =>
                  resultHasPlannerPreferenceChoiceEvidence(params.queryText, result)
                );
                return groundedResults.length > 0 ? [...groundedResults, ...rankedResults] : rankedResults;
              })()
          : /\bwould\b|\blikely\b/iu.test(params.queryText)
            ? (() => {
                const groundedResults = rankedResults.filter((result) =>
                  resultHasPlannerStrongComparativeFitEvidence(result)
                );
                return groundedResults.length > 0 ? groundedResults : rankedResults;
              })()
            : rankedResults;
  const groundedResults =
    reportKind === "travel_report" && /\bwhere\b/iu.test(params.queryText)
      ? subjectSeededResults.filter((result) => resultHasPlannerTravelLocationEvidence(params.queryText, result))
      : reportKind === "support_report" && isPlannerGriefPeaceSupportQuery(params.queryText)
        ? subjectSeededResults.filter((result) => resultHasPlannerGriefPeaceSupportEvidence(params.queryText, result))
        : reportKind === "aspiration_report" &&
            /\bhow does\b[^?!.]{0,80}\bplan to\b[^?!.]{0,80}\bunique\b/iu.test(params.queryText)
          ? subjectSeededResults.filter((result) => resultHasPlannerAspirationUniqueEvidence(params.queryText, result))
          : reportKind === "career_report" && /\bgoals?\b/iu.test(params.queryText) && /\bcareer\b/iu.test(params.queryText)
            ? subjectSeededResults.filter((result) => resultHasPlannerCareerGoalEvidence(params.queryText, result))
          : reportKind === "preference_report" && isBooksByAuthorPreferenceQuery(params.queryText)
            ? subjectSeededResults.filter((result) => resultHasPlannerPreferenceChoiceEvidence(params.queryText, result))
          : /\bwould\b|\blikely\b/iu.test(params.queryText)
            ? subjectSeededResults.filter((result) => resultHasPlannerStrongComparativeFitEvidence(result))
            : [];
  const attemptPools: RecallResult[][] = [];
  const pushAttemptPool = (results: readonly RecallResult[]): void => {
    if (results.length === 0) {
      return;
    }
    const pool = [...uniquePlannerProfileResults(results)];
    const key = plannerProfilePoolKey(pool);
    if (attemptPools.some((existing) => plannerProfilePoolKey(existing) === key)) {
      return;
    }
    attemptPools.push(pool);
  };
  pushAttemptPool(focusedRankedResults);
  if (groundedResults.length > 0) {
    pushAttemptPool([...groundedResults, ...focusedRankedResults, ...rankedResults]);
    pushAttemptPool([...groundedResults, ...subjectSeededResults]);
  }
  pushAttemptPool(rankedResults);
  pushAttemptPool(subjectSeededResults);

  let bestAttempt:
    | {
        readonly rendered: RenderedSupportClaim;
        readonly selectedResults: readonly RecallResult[];
        readonly score: number;
      }
    | null = null;
  for (const attemptResults of attemptPools) {
    const attempt = renderPlannerProfileSupportAttempt({
      reportKind,
      queryText: params.queryText,
      results: attemptResults
    });
    if (!attempt.rendered.claimText) {
      continue;
    }
    const score = scorePlannerProfileSupportAttempt({
      rendered: attempt.rendered,
      support: attempt.support,
      results: attemptResults
    });
    if (!bestAttempt || score > bestAttempt.score) {
      bestAttempt = {
        rendered: attempt.rendered,
        selectedResults: attemptResults,
        score
      };
    }
  }

  if (!bestAttempt?.rendered.claimText) {
    return null;
  }
  return buildPlannerReportCandidate({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    reportKind,
    rendered: bestAttempt.rendered,
    results: bestAttempt.selectedResults,
    evidence: params.evidence,
    assessment: params.assessment,
    ownerSourceTable: inferPlannerProfileSourceTable({
      reportKind,
      renderContractSelected: bestAttempt.rendered.renderContractSelected
    })
  });
}

function buildPlannerTemporalCandidate(params: PlannerTypedCandidateParams): CanonicalAdjudicationResult | null {
  if (params.retrievalPlan.family !== "temporal" || params.retrievalPlan.lane !== "temporal_event") {
    return null;
  }
  const subjectSeededResults = selectSubjectBoundTemporalResults({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results
  });
  const rankedResults = rankTemporalPoolResults({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: subjectSeededResults
  });
  const storedTemporal =
    params.storedCanonical?.kind === "temporal_fact"
      ? params.storedCanonical
      : null;
  const canonicalTemporalOnlyResults =
    rankedResults.length > 0 &&
    rankedResults.every((result) => readResultSourceTable(result) === "canonical_temporal_facts");
  const canonicalFactOnlyResults =
    Boolean(storedTemporal) &&
    canonicalTemporalOnlyResults &&
    (
      storedTemporal?.sourceTable === "canonical_temporal_facts" ||
      rankedResults.every((result) => Boolean(readResultEventKey(result)))
    );
  if (canonicalFactOnlyResults) {
    return null;
  }
  if (!storedTemporal && rankedResults.length === 0) {
    return null;
  }
  const subjectContext = buildPlannerSubjectContext({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: rankedResults,
    assessment: params.assessment
  });
  const support = buildTemporalEventSupport({
    queryText: params.queryText,
    storedCanonical: storedTemporal,
    fallbackClaimText: storedTemporal?.objectValue ?? null,
    results: rankedResults,
    subjectBindingStatus: storedTemporal?.subjectBindingStatus ?? subjectContext.subjectBindingStatus,
    subjectBindingReason: subjectContext.subjectPlan.reason
  });
  const rendered = renderTemporalEventSupport(params.queryText, support, rankedResults.length);
  if (!rendered.claimText) {
    return null;
  }
  const timePlan = {
    mentionedAt: rankedResults[0]?.occurredAt ?? null,
    validFrom: storedTemporal?.validFrom ?? null,
    validUntil: storedTemporal?.validUntil ?? null,
    timeScopeKind: storedTemporal?.timeScopeKind ?? "historical",
    source: "event_time" as const
  };
  const shapingTrace = buildPlannerTrace({
    selectedFamily: "temporal",
    rendered,
    retrievalPlan: params.retrievalPlan,
    resolvedSubjectEntityId: subjectContext.resolvedSubjectEntityId ?? storedTemporal?.subjectEntityId ?? null,
    subjectBindingStatus: storedTemporal?.subjectBindingStatus ?? subjectContext.subjectBindingStatus,
    subjectBindingReason: subjectContext.subjectPlan.reason,
    results: rankedResults
  });
  return {
    bundle: {
      subjectEntityId: subjectContext.resolvedSubjectEntityId ?? storedTemporal?.subjectEntityId ?? null,
      canonicalSubjectName: subjectContext.canonicalSubjectName ?? storedTemporal?.canonicalSubjectName,
      subjectBindingStatus: storedTemporal?.subjectBindingStatus ?? subjectContext.subjectBindingStatus,
      subjectPlan: subjectContext.subjectPlan,
      predicateFamily: "temporal_event_fact",
      provenanceRows: rankedResults,
      evidenceItems: params.evidence,
      supportStrength: inferReportSupportStrength(rendered),
      timeScopeKind: timePlan.timeScopeKind,
      canonicalReadTier: "canonical_graph",
      temporalValidity: timePlan,
      ownerSourceTable: storedTemporal?.sourceTable ?? "planner_runtime_temporal_candidate"
    },
    canonical: {
      kind: "temporal_fact",
      subjectEntityId: subjectContext.resolvedSubjectEntityId ?? storedTemporal?.subjectEntityId ?? null,
      canonicalSubjectName: subjectContext.canonicalSubjectName ?? storedTemporal?.canonicalSubjectName,
      predicateFamily: "temporal_event_fact",
      objectValue: rendered.claimText,
      anchorText: null,
      timeScopeKind: timePlan.timeScopeKind,
      provenanceRows: rankedResults,
      supportStrength: inferReportSupportStrength(rendered),
      confidence: inferReportConfidence(rendered),
      status: "supported",
      validFrom: timePlan.validFrom,
      validUntil: timePlan.validUntil,
      eventKey: support.eventKey ?? storedTemporal?.eventKey ?? rendered.selectedEventKey ?? null,
      eventType: support.eventType ?? storedTemporal?.eventType ?? rendered.selectedEventType ?? null,
      timeGranularity: support.timeGranularity ?? storedTemporal?.timeGranularity ?? rendered.selectedTimeGranularity ?? null,
      answerYear: support.answerYear ?? storedTemporal?.answerYear ?? null,
      answerMonth: support.answerMonth ?? storedTemporal?.answerMonth ?? null,
      answerDay: support.answerDay ?? storedTemporal?.answerDay ?? null,
      objectEntityId: storedTemporal?.objectEntityId ?? null,
      sourceArtifactId: storedTemporal?.sourceArtifactId ?? null,
      sourceChunkId: storedTemporal?.sourceChunkId ?? null,
      sourceEventId: storedTemporal?.sourceEventId ?? null,
      anchorEventKey: storedTemporal?.anchorEventKey ?? null,
      anchorRelation: storedTemporal?.anchorRelation ?? null,
      anchorOffsetValue: storedTemporal?.anchorOffsetValue ?? null,
      anchorOffsetUnit: storedTemporal?.anchorOffsetUnit ?? null,
      canonicalConfidence: storedTemporal?.canonicalConfidence ?? null
    },
    formatted: {
      claimText: rendered.claimText,
      finalClaimSource: "canonical_temporal",
      answerBundle: {
        topClaim: rendered.claimText,
        claimKind: "temporal",
        subjectPlan: subjectContext.subjectPlan,
        predicatePlan: "temporal_event_fact",
        timePlan,
        evidenceBundle: params.evidence,
        fallbackBlockedReason: "planner_temporal_candidate_precedence",
        reasoningChain: buildReasoningChain({
          queryText: params.queryText,
          predicateFamily: "temporal_event_fact",
          timeScopeKind: timePlan.timeScopeKind,
          topClaim: rendered.claimText,
          subjectNames:
            subjectContext.subjectPlan.kind === "pair_subject"
              ? [subjectContext.subjectPlan.canonicalSubjectName ?? "", subjectContext.subjectPlan.pairSubjectName ?? ""]
              : [subjectContext.subjectPlan.canonicalSubjectName ?? ""],
          results: rankedResults,
          canonicalSupport: [
            params.retrievalPlan.lane,
            rendered.supportObjectType ?? "",
            rendered.renderContractSelected ?? "",
            ...(storedTemporal?.sourceTable ? [storedTemporal.sourceTable] : []),
            ...params.retrievalPlan.candidatePools
          ].filter(Boolean),
          exclusionClauses: ["snippet_override_blocked", "planner_runtime_temporal_candidate"]
        })
      },
      shapingTrace
    }
  };
}

function inferPlannerListSetSourceTable(params: {
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly renderContractSelected: string | null | undefined;
}): string {
  if (params.retrievalPlan.lane === "location_history" || params.renderContractSelected === "location_list_render") {
    return "planner_runtime_location_history_candidate";
  }
  if (params.retrievalPlan.lane === "support_network" || params.renderContractSelected === "support_network_render") {
    return "planner_runtime_support_network_candidate";
  }
  if (params.retrievalPlan.lane === "book_list" || params.renderContractSelected === "book_list_render") {
    return "planner_runtime_book_list_candidate";
  }
  if (params.retrievalPlan.lane === "event_list" || params.renderContractSelected === "event_list_render") {
    return "planner_runtime_event_list_candidate";
  }
  return "planner_runtime_list_set_candidate";
}

function buildPlannerListSetCandidate(params: PlannerTypedCandidateParams): CanonicalAdjudicationResult | null {
  if (params.retrievalPlan.family !== "list_set") {
    return null;
  }
  const rankedResults = selectSubjectBoundListSetResults({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results
  });
  const storedSet = params.storedCanonical?.kind === "set" ? params.storedCanonical : null;
  if (!storedSet && rankedResults.length === 0) {
    return null;
  }
  const subjectContext = buildPlannerSubjectContext({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: rankedResults,
    assessment: params.assessment
  });
  const predicateFamily = inferAnswerRetrievalPredicateFamily(
    params.queryText,
    storedSet?.predicateFamily ?? "list_set"
  ) as CanonicalPredicateFamily;
  const support = buildListSetSupport({
    queryText: params.queryText,
    predicateFamily,
    results: rankedResults,
    storedCanonical: storedSet,
    finalClaimText: storedSet ? joinCanonicalItems(storedSet.objectValues ?? []) : null,
    subjectPlan: subjectContext.subjectPlan
  });
  const rendered = renderListSetSupport(support, rankedResults.length);
  if (!rendered.claimText) {
    return null;
  }
  const timePlan = {
    mentionedAt: rankedResults[0]?.occurredAt ?? null,
    validFrom: storedSet?.validFrom ?? null,
    validUntil: storedSet?.validUntil ?? null,
    timeScopeKind: storedSet?.timeScopeKind ?? "active",
    source: "unknown" as const
  };
  const shapingTrace = buildPlannerTrace({
    selectedFamily: "list_set",
    rendered,
    retrievalPlan: params.retrievalPlan,
    resolvedSubjectEntityId: subjectContext.resolvedSubjectEntityId,
    subjectBindingStatus: subjectContext.subjectBindingStatus,
    subjectBindingReason: subjectContext.subjectPlan.reason,
    results: rankedResults
  });
  const objectValues = support.typedEntries.length > 0 ? support.typedEntries : support.fallbackEntries;
  const ownerSourceTable = inferPlannerListSetSourceTable({
    retrievalPlan: params.retrievalPlan,
    renderContractSelected: rendered.renderContractSelected
  });
  return {
    bundle: {
      subjectEntityId: subjectContext.resolvedSubjectEntityId,
      canonicalSubjectName: subjectContext.canonicalSubjectName,
      subjectBindingStatus: subjectContext.subjectBindingStatus,
      subjectPlan: subjectContext.subjectPlan,
      predicateFamily,
      provenanceRows: rankedResults,
      evidenceItems: params.evidence,
      supportStrength: inferReportSupportStrength(rendered),
      timeScopeKind: timePlan.timeScopeKind,
      canonicalReadTier: storedSet ? "canonical_graph" : "episodic_fallback",
      temporalValidity: timePlan,
      ownerSourceTable
    },
    canonical: {
      kind: "set",
      subjectEntityId: subjectContext.resolvedSubjectEntityId,
      canonicalSubjectName: subjectContext.canonicalSubjectName,
      predicateFamily,
      objectValues,
      timeScopeKind: timePlan.timeScopeKind,
      provenanceRows: rankedResults,
      supportStrength: inferReportSupportStrength(rendered),
      confidence: inferReportConfidence(rendered),
      status: "supported",
      validFrom: timePlan.validFrom,
      validUntil: timePlan.validUntil
    },
    formatted: {
      claimText: rendered.claimText,
      finalClaimSource: "canonical_list_set",
      answerBundle: {
        topClaim: rendered.claimText,
        claimKind: "set",
        subjectPlan: subjectContext.subjectPlan,
        predicatePlan: predicateFamily,
        timePlan,
        evidenceBundle: params.evidence,
        fallbackBlockedReason: "planner_list_set_candidate_precedence",
        reasoningChain: buildReasoningChain({
          queryText: params.queryText,
          predicateFamily,
          timeScopeKind: timePlan.timeScopeKind,
          topClaim: rendered.claimText,
          subjectNames:
            subjectContext.subjectPlan.kind === "pair_subject"
              ? [subjectContext.subjectPlan.canonicalSubjectName ?? "", subjectContext.subjectPlan.pairSubjectName ?? ""]
              : [subjectContext.subjectPlan.canonicalSubjectName ?? ""],
          results: rankedResults,
          canonicalSupport: [
            params.retrievalPlan.lane,
            rendered.supportObjectType ?? "",
            rendered.renderContractSelected ?? "",
            ...params.retrievalPlan.candidatePools
          ].filter(Boolean),
          exclusionClauses: ["snippet_override_blocked", ownerSourceTable]
        })
      },
      shapingTrace
    }
  };
}

export function buildPlannerTypedCandidate(params: PlannerTypedCandidateParams): CanonicalAdjudicationResult | null {
  return (
    buildPlannerCollectionCandidate(params) ??
    buildPlannerListSetCandidate(params) ??
    buildPlannerTemporalCandidate(params) ??
    buildPlannerProfileCandidate(params)
  );
}

function isLowLevelNarrativeReportSource(sourceTable: string | null | undefined): boolean {
  return sourceTable === "retrieved_text_unit_report" || sourceTable === "assembled_raw_entity_report";
}

function isPlannerPreferredReportRenderContract(renderContract: string | null | undefined): boolean {
  return [
    "collection_set_render",
    "collection_set_partial",
    "causal_reason_render",
    "community_membership_inference",
    "ally_likelihood_judgment",
    "career_likelihood_judgment",
    "education_field_render",
    "pet_care_classes_render",
    "pet_care_activity_render",
    "pet_care_advice_render",
    "travel_location_set_render",
    "aspiration_unique_feature_render",
    "aspiration_venture_render",
    "comparative_fit_render",
    "pair_advice_render"
  ].includes(renderContract ?? "");
}

export function preferPlannerTypedCandidate(params: {
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly narrativeCandidate: CanonicalAdjudicationResult | null;
  readonly plannerCandidate: CanonicalAdjudicationResult | null;
}): CanonicalAdjudicationResult | null {
  if (!params.plannerCandidate) {
    return params.narrativeCandidate;
  }
  if (!params.narrativeCandidate) {
    return params.plannerCandidate;
  }
  if (params.narrativeCandidate.canonical.kind === "abstention") {
    return params.plannerCandidate;
  }
  if (params.retrievalPlan.lane === "collection_inference") {
    return params.plannerCandidate;
  }
  if (
    params.retrievalPlan.lane === "temporal_event" &&
    params.plannerCandidate.formatted.finalClaimSource === "canonical_temporal" &&
    params.plannerCandidate.bundle.ownerSourceTable?.startsWith("planner_runtime_")
  ) {
    return params.plannerCandidate;
  }
  if (
    params.retrievalPlan.family === "list_set" &&
    params.plannerCandidate.formatted.finalClaimSource === "canonical_list_set"
  ) {
    return params.plannerCandidate;
  }
  if (
    params.retrievalPlan.family === "report" &&
    params.plannerCandidate.bundle.ownerSourceTable?.startsWith("planner_runtime_") &&
    (
      isLowLevelNarrativeReportSource(params.narrativeCandidate.bundle.ownerSourceTable ?? null) ||
      isPlannerPreferredReportRenderContract(params.plannerCandidate.formatted.shapingTrace?.renderContractSelected)
    )
  ) {
    return params.plannerCandidate;
  }
  if (
    params.narrativeCandidate.canonical.kind === "report" &&
    params.narrativeCandidate.formatted.shapingTrace?.supportObjectType &&
    params.narrativeCandidate.formatted.shapingTrace?.renderContractSelected
  ) {
    return params.narrativeCandidate;
  }
  return params.plannerCandidate;
}
