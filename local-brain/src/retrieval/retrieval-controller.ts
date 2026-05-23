import {
  isBroadPreferenceProfileQuery,
  isChildScopedPreferenceProfileQuery,
  isIdentityProfileQuery,
  isRelationshipProfileQuery
} from "./query-signals.js";
import type {
  CandidatePoolSelection,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  PlannerAnswerKind,
  RetrievalPlanLane,
  SuppressionPoolSelection,
} from "./types.js";
import type {
  BoundedCandidateAssemblyPolicy,
  RetrievalControllerIntent,
  RetrievalControllerSubjectArity
} from "./retrieval-controller-types.js";
import {
  getTypedContractRegistryEntry,
  resolvePrimaryTypedContract
} from "./typed-contract-registry.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function inferSubjectArity(queryText: string): RetrievalControllerSubjectArity {
  const normalized = normalize(queryText);
  if (/\b(?:and|both|together|shared)\b/u.test(normalized)) {
    return "pair";
  }
  return /\b[A-Z][a-z]+\b/u.test(queryText) ? "single" : "none";
}

function inferExpectedShape(params: {
  readonly queryText: string;
  readonly lane: RetrievalPlanLane;
  readonly answerKind: PlannerAnswerKind;
  readonly reportKind?: CanonicalReportKind | null;
  readonly primaryTypedContract: ReturnType<typeof resolvePrimaryTypedContract>;
}): RetrievalControllerIntent["expectedShape"] {
  if (params.lane === "temporal_event") {
    return "temporal";
  }
  if (params.primaryTypedContract === "preference_profile" && isChildScopedPreferenceProfileQuery(params.queryText)) {
    return "list";
  }
  const contractEntry = getTypedContractRegistryEntry(params.primaryTypedContract);
  if (contractEntry?.expectedShape === "list") {
    return "list";
  }
  if (contractEntry?.expectedShape === "reason") {
    return "reason";
  }
  if (contractEntry?.expectedShape === "scalar") {
    return "scalar";
  }
  if (contractEntry?.expectedShape === "judgment") {
    return "judgment";
  }
  if (
    params.reportKind === "career_report" ||
    /\bwould\b|\blikely\b|\bmight\b/iu.test(params.queryText)
  ) {
    return "judgment";
  }
  return "report";
}

export function inferRetrievalControllerIntent(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly family: RetrievalControllerIntent["family"];
  readonly lane: RetrievalPlanLane;
  readonly answerKind: PlannerAnswerKind;
  readonly reportKind?: CanonicalReportKind | null;
}): RetrievalControllerIntent {
  const subjectArity = inferSubjectArity(params.queryText);
  const primaryTypedContract = resolvePrimaryTypedContract({
    queryText: params.queryText,
    lane: params.lane,
    answerKind: params.answerKind,
    family: params.family
  });
  const expectedShape = inferExpectedShape({
    ...params,
    primaryTypedContract
  });
  const contractLock =
    params.family === "report"
      ? "report_first"
      : params.family === "exact_detail"
        ? "exact_detail_first"
        : params.family === "abstention"
          ? "abstention_only"
          : "typed_first";
  const backfillMode =
    contractLock === "typed_first"
      ? "contract_only"
      : contractLock === "report_first"
        ? "report_only"
        : contractLock === "exact_detail_first"
          ? "exact_detail_only"
          : "disabled";
  const neighborhoodMode =
    params.family === "report"
      ? "report_enrichment"
      : params.family === "exact_detail"
        ? "exact_detail_enrichment"
        : params.family === "abstention"
          ? "disabled"
          : "enrichment_only";
  const genericFamilyEligibleBeforeContractFailure =
    params.family === "report" &&
    !primaryTypedContract &&
    !isIdentityProfileQuery(params.queryText);
  return {
    family: params.family,
    lane: params.lane,
    answerKind: params.answerKind,
    primaryTypedContract,
    expectedShape,
    subjectArity,
    contractLock,
    backfillMode,
    neighborhoodMode,
    genericFamilyEligibleBeforeContractFailure
  };
}

export function buildBoundedCandidateAssemblyPolicy(
  intent: RetrievalControllerIntent
): BoundedCandidateAssemblyPolicy {
  const registryEntry = getTypedContractRegistryEntry(intent.primaryTypedContract);
  const candidatePools: readonly CandidatePoolSelection[] =
    intent.lane === "temporal_event"
      ? [
          "temporal_exact_facts",
          "temporal_aligned_anchors",
          "temporal_event_neighbors",
          "temporal_derived_relatives",
          "canonical_temporal_facts",
          "normalized_event_facts",
          "temporal_results",
          "snippet_results",
          "raw_text_fallback"
        ]
      : registryEntry
        ? registryEntry.candidatePools as readonly CandidatePoolSelection[]
        : intent.lane === "collection_inference"
          ? ["normalized_collection_facts", "canonical_reports", "report_support", "profile_report_support", "collection_support", "snippet_results", "raw_text_fallback"]
          : intent.lane === "report"
            ? ["report_typed_payloads", "canonical_reports", "canonical_sets", "report_support", "profile_report_support", "snippet_results", "raw_text_fallback"]
            : intent.lane === "abstention"
              ? ["structured_candidates", "snippet_results", "raw_text_fallback"]
              : ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"];

  const suppressionPools: readonly SuppressionPoolSelection[] =
    intent.contractLock === "typed_first"
      ? ["exact_detail_support", "generic_snippet_support"]
      : intent.contractLock === "report_first"
        ? ["generic_snippet_support"]
        : [];

  const familyConfidence =
    intent.lane === "generic"
      ? 0.4
      : intent.lane === "temporal_event"
        ? 0.95
        : intent.contractLock === "typed_first"
          ? 0.95
          : 0.8;

  const supportCompletenessTarget =
    registryEntry?.supportCompletenessTarget ??
    (intent.expectedShape === "scalar" || intent.expectedShape === "temporal"
      ? 1
      : intent.expectedShape === "judgment" || intent.expectedShape === "report"
        ? 0.7
        : 0.75);

  const rescuePolicy =
    intent.contractLock === "typed_first" || intent.contractLock === "report_first"
      ? "single_targeted_rescue_before_fallback"
      : intent.contractLock === "exact_detail_first"
        ? "allow_immediate_abstention"
        : "allow_immediate_abstention";

  const ownerEligibilityHints = intent.contractLock === "typed_first" ? ["canonical_list_set"] : [];
  const suppressionHints =
    intent.contractLock === "typed_first"
      ? ["canonical_exact_detail", "runtime_exact_detail"]
      : [];

  return {
    candidatePools,
    suppressionPools,
    ownerEligibilityHints,
    suppressionHints,
    familyConfidence,
    supportCompletenessTarget,
    rescuePolicy
  };
}
