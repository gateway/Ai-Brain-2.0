import {
  isConcreteValueSlotQuery,
  isConstraintQuery,
  isCurrentPreferenceQuery,
  isIdentityProfileQuery,
  isPreciseFactDetailQuery,
  isProfileInferenceQuery,
  isRoutineSummaryQuery,
  isSharedCommonalityQuery,
  isTemporalDetailQuery
} from "./query-signals.js";
import type { ExactDetailClaimCandidate, RecallResponse } from "./types.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeTelemetryText(value: string | null | undefined): string {
  return normalizeWhitespace(value ?? "").toLowerCase();
}

export function inferSupportBundleFamilyForTelemetry(params: {
  readonly queryText: string;
  readonly finalClaimSource: string | null | undefined;
  readonly retrievalPlanFamily?: string | null;
}): RecallResponse["meta"]["supportBundleFamily"] {
  const claimSource = params.finalClaimSource ?? "";
  if (
    claimSource === "canonical_temporal" ||
    params.retrievalPlanFamily === "temporal_event_fact" ||
    isTemporalDetailQuery(params.queryText) ||
    /^\s*when\b/iu.test(params.queryText)
  ) {
    return "temporal_detail";
  }
  if (
    claimSource === "canonical_list_set" ||
    /\blist|set|inventory|activities|events|books|pets|types?\b/iu.test(params.queryText)
  ) {
    return "typed_list_set";
  }
  if (claimSource === "canonical_exact_detail" || isPreciseFactDetailQuery(params.queryText)) {
    return "exact_detail";
  }
  if (isConcreteValueSlotQuery(params.queryText)) {
    return "exact_detail";
  }
  if (claimSource === "canonical_commonality" || isSharedCommonalityQuery(params.queryText)) {
    return "commonality";
  }
  if (
    claimSource === "canonical_profile" ||
    claimSource === "canonical_report" ||
    claimSource === "canonical_counterfactual" ||
    isProfileInferenceQuery(params.queryText) ||
    isIdentityProfileQuery(params.queryText)
  ) {
    return "profile_report";
  }
  if (
    isRoutineSummaryQuery(params.queryText) ||
    isConstraintQuery(params.queryText) ||
    isCurrentPreferenceQuery(params.queryText) ||
    /\bcurrent\b|\bright now\b|\btoday\b|\bhabit\b|\bprojects?\b|\bwarm start\b/iu.test(params.queryText)
  ) {
    return "current_state";
  }
  return "generic";
}

export function inferReducerFamilyForTelemetry(params: {
  readonly queryText: string;
  readonly inferExactDetailQuestionFamily: (queryText: string) => string;
  readonly isResidualPlaceEventAggregationQuery: (queryText: string) => boolean;
}): string | undefined {
  const exactDetailFamily = params.inferExactDetailQuestionFamily(params.queryText);
  if (exactDetailFamily !== "generic") {
    return exactDetailFamily;
  }
  if (isTemporalDetailQuery(params.queryText) || /^\s*when\b/i.test(params.queryText) || /\bwhich\s+year\b/i.test(params.queryText)) {
    return "temporal";
  }
  if (isProfileInferenceQuery(params.queryText)) {
    return "profile_inference";
  }
  if (isSharedCommonalityQuery(params.queryText)) {
    return "shared_commonality";
  }
  if (params.isResidualPlaceEventAggregationQuery(params.queryText)) {
    return "place_event_aggregation";
  }
  if (/\bwhat\b/iu.test(params.queryText) && /\bactivities|books|pets|types?\b/iu.test(params.queryText)) {
    return "generic_direct_fact";
  }
  return undefined;
}

export function inferFallbackSuppressedReasonForTelemetry(params: {
  readonly queryText: string;
  readonly inferExactDetailQuestionFamily: (queryText: string) => string;
  readonly isResidualPlaceEventAggregationQuery: (queryText: string) => boolean;
}): string | undefined {
  const exactDetailFamily = params.inferExactDetailQuestionFamily(params.queryText);
  if (exactDetailFamily !== "generic") {
    return "exact_detail_family";
  }
  if (/\bif\b/i.test(params.queryText) && /\bwould\b/i.test(params.queryText)) {
    return "counterfactual_guard";
  }
  if (/\bgoals?\b/i.test(params.queryText)) {
    return "goal_family_guard";
  }
  if (params.isResidualPlaceEventAggregationQuery(params.queryText)) {
    return "place_event_aggregation_guard";
  }
  if (isProfileInferenceQuery(params.queryText)) {
    return "profile_inference_guard";
  }
  if (/\blist|set|inventory|activities|events|books|pets|types?\b/iu.test(params.queryText)) {
    return "generic_direct_fact_guard";
  }
  return undefined;
}

export function mapRuntimeAbstentionReason(params: {
  readonly ownerTraceReason?: string | null;
  readonly canonicalAbstainReason?: string | null;
  readonly answerAssessment?: RecallResponse["meta"]["answerAssessment"];
}): RecallResponse["meta"]["abstentionReason"] {
  const ownerReason = params.ownerTraceReason ?? params.canonicalAbstainReason ?? null;
  if (!ownerReason) {
    if (params.answerAssessment?.subjectMatch === "mismatched") {
      return "no_subject_binding";
    }
    if (params.answerAssessment?.sufficiency === "contradicted") {
      return "support_conflict";
    }
    if (params.answerAssessment?.sufficiency === "missing") {
      return "insufficient_active_truth";
    }
    return undefined;
  }
  if (ownerReason.includes("subject")) {
    return "no_subject_binding";
  }
  if (ownerReason.includes("temporal")) {
    return "temporal_gap";
  }
  if (ownerReason.includes("conflict")) {
    return "support_conflict";
  }
  if (ownerReason.includes("current_state") || ownerReason.includes("support")) {
    return "insufficient_active_truth";
  }
  if (ownerReason.includes("exact") || ownerReason.includes("value")) {
    return "no_exact_value_support";
  }
  return "insufficient_active_truth";
}

export function inferTemporalCoverageStatus(params: {
  readonly temporalExactness?: "exact" | "bounded" | "inferred" | null;
  readonly finalClaimSource?: string | null;
  readonly canonicalAbstainReason?: string | null;
  readonly temporalDetailFocus?: boolean;
  readonly temporalFactCount?: number;
}): RecallResponse["meta"]["temporalCoverageStatus"] {
  if (params.temporalExactness === "exact") {
    return "exact";
  }
  if (params.temporalExactness === "bounded") {
    return "bounded";
  }
  if (params.temporalExactness === "inferred") {
    return "partial";
  }
  if (params.canonicalAbstainReason === "conflicting_evidence") {
    return "conflicting";
  }
  if (
    params.finalClaimSource === "canonical_temporal" ||
    params.temporalDetailFocus ||
    (typeof params.temporalFactCount === "number" && params.temporalFactCount > 0)
  ) {
    return "unresolved";
  }
  return undefined;
}

export function inferEntityResolutionStatus(params: {
  readonly resolverStatus?: "resolved" | "ambiguous" | "unresolved" | null;
  readonly canonicalSubjectBindingStatus?: string | null;
  readonly answerAssessment?: RecallResponse["meta"]["answerAssessment"];
}): RecallResponse["meta"]["entityResolutionStatus"] {
  if (params.resolverStatus) {
    return params.resolverStatus;
  }
  if (params.canonicalSubjectBindingStatus === "resolved" || params.canonicalSubjectBindingStatus === "ambiguous" || params.canonicalSubjectBindingStatus === "unresolved") {
    return params.canonicalSubjectBindingStatus;
  }
  if (params.answerAssessment?.subjectMatch === "matched") {
    return "resolved";
  }
  if (params.answerAssessment?.subjectMatch === "mixed") {
    return "ambiguous";
  }
  if (params.answerAssessment?.subjectMatch === "mismatched") {
    return "unresolved";
  }
  return undefined;
}

export function inferStructuredSufficiencyStatus(params: {
  readonly typedContractSatisfied?: boolean;
  readonly typedContractComplete?: boolean;
  readonly activeSupportCount?: number;
  readonly answerAssessment?: RecallResponse["meta"]["answerAssessment"];
}): RecallResponse["meta"]["structuredSufficiencyStatus"] {
  if (params.typedContractSatisfied || params.typedContractComplete) {
    return "sufficient";
  }
  if (typeof params.activeSupportCount === "number" && params.activeSupportCount > 0) {
    return "partial";
  }
  if (params.answerAssessment?.sufficiency === "missing" || params.answerAssessment?.sufficiency === "contradicted") {
    return "insufficient";
  }
  if (params.answerAssessment) {
    return "partial";
  }
  return "none";
}

export function inferFinalClaimSourceForTelemetry(params: {
  readonly queryText: string;
  readonly results: readonly { readonly content: string }[];
  readonly claimText: string;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
  readonly temporalClaimText?: string | null;
  readonly profileClaimText?: string | null;
  readonly genericEnumerativeClaimText?: string | null;
}): string {
  const claimText = normalizeTelemetryText(params.claimText);
  const topContent = normalizeTelemetryText(params.results[0]?.content ?? null);
  if (!claimText || claimText === "none." || claimText === "unknown.") {
    return "abstention";
  }
  if (normalizeTelemetryText(params.exactDetailCandidate?.text) === claimText) {
    return "exact_detail_candidate";
  }
  if (normalizeTelemetryText(params.temporalClaimText) === claimText) {
    return "temporal_reducer";
  }
  if (normalizeTelemetryText(params.profileClaimText) === claimText) {
    return "profile_reducer";
  }
  if (normalizeTelemetryText(params.genericEnumerativeClaimText) === claimText) {
    return "family_reducer";
  }
  if (topContent && topContent === claimText) {
    return "top_snippet";
  }
  if (isPreciseFactDetailQuery(params.queryText)) {
    return "family_reducer";
  }
  return "fallback_derived";
}
