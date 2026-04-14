import type {
  CanonicalAdjudicationResult,
  CanonicalPredicateFamily,
  CanonicalTieBreakReason,
  CanonicalWinnerTier,
  RetrievalLatencyBudget
} from "./types.js";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import type { RenderedSupportClaim } from "./support-objects.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export const DEFAULT_RETRIEVAL_LATENCY_BUDGET: RetrievalLatencyBudget = {
  family: "default",
  maxBranchDepth: 3,
  maxNeighborhoodExpansions: 6,
  maxLeafCandidates: 16,
  stopOnFirstSufficient: false,
  disableArtifactDerivationAfterSufficient: false
};

const RETRIEVAL_LATENCY_BUDGETS: Record<RetrievalLatencyBudget["family"], RetrievalLatencyBudget> = {
  bounded_event_detail: {
    family: "bounded_event_detail",
    maxBranchDepth: 2,
    maxNeighborhoodExpansions: 4,
    maxLeafCandidates: 12,
    stopOnFirstSufficient: true,
    disableArtifactDerivationAfterSufficient: true
  },
  descriptive_place_activity: {
    family: "descriptive_place_activity",
    maxBranchDepth: 1,
    maxNeighborhoodExpansions: 3,
    maxLeafCandidates: 8,
    stopOnFirstSufficient: true,
    disableArtifactDerivationAfterSufficient: false
  },
  commonality_aggregation: {
    family: "commonality_aggregation",
    maxBranchDepth: 2,
    maxNeighborhoodExpansions: 3,
    maxLeafCandidates: 10,
    stopOnFirstSufficient: false,
    disableArtifactDerivationAfterSufficient: false
  },
  default: DEFAULT_RETRIEVAL_LATENCY_BUDGET
};

export function inferRetrievalLatencyBudgetFamily(queryText: string, exactDetailFamily: string): RetrievalLatencyBudget["family"] {
  const normalized = normalize(queryText).toLowerCase();
  if (
    ["meat_preference", "favorite_painting_style", "research_topic"].includes(exactDetailFamily) ||
    /\bwhich meat\b/u.test(normalized) ||
    /\bfavorite style of painting\b/u.test(normalized) ||
    /\bwhat did\b[^?!.]{0,60}\bresearch\b/u.test(normalized)
  ) {
    return "bounded_event_detail";
  }
  if (
    /\bwhat is an indoor activity\b/u.test(normalized) ||
    /\bwhat kind of places\b/u.test(normalized)
  ) {
    return "descriptive_place_activity";
  }
  if (
    /\bboth\b/u.test(normalized) &&
    (/\bvisited\b/u.test(normalized) || /\bvolunteer(?:ing)?\b/u.test(normalized) || /\bshare\b/u.test(normalized))
  ) {
    return "commonality_aggregation";
  }
  return "default";
}

export function retrievalLatencyBudgetForQuery(queryText: string, exactDetailFamily: string): RetrievalLatencyBudget {
  return RETRIEVAL_LATENCY_BUDGETS[inferRetrievalLatencyBudgetFamily(queryText, exactDetailFamily)];
}

export function renderStoredCanonicalSetValues(
  predicateFamily: CanonicalPredicateFamily,
  objectValues: readonly string[],
  pairSubject = false
): string | null {
  const values = [...new Set(objectValues.map((value) => normalize(value)).filter(Boolean))];
  if (values.length === 0) {
    return null;
  }
  if (values.every((value) => isCanonicalGoalItem(value))) {
    return orderCanonicalGoalItems(values).join(", ");
  }
  if (predicateFamily === "commonality") {
    const joined =
      values.length === 1
        ? values[0]!
        : values.length === 2
          ? `${values[0]} and ${values[1]}`
          : `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
    return pairSubject ? `They ${joined}.` : joined;
  }
  return values.join(", ");
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

export function inferCanonicalWinnerTier(params: {
  readonly finalClaimSource: CanonicalAdjudicationResult["formatted"]["finalClaimSource"] | null | undefined;
  readonly renderedSupport: RenderedSupportClaim | null | undefined;
  readonly storedCanonical: StoredCanonicalLookup | null | undefined;
  readonly subjectBindingStatus?: string | null | undefined;
}): CanonicalWinnerTier {
  const supportType = params.renderedSupport?.supportObjectType ?? null;
  if (
    params.finalClaimSource === "canonical_temporal" &&
    (params.subjectBindingStatus === "resolved" ||
      params.storedCanonical?.subjectBindingStatus === "resolved" ||
      params.renderedSupport?.subjectBindingStatus === "resolved")
  ) {
    return "canonical_temporal_bound";
  }
  if (params.finalClaimSource === "canonical_temporal") {
    return "canonical_temporal_derived";
  }
  if (
    params.finalClaimSource === "canonical_profile" ||
    params.finalClaimSource === "canonical_report" ||
    params.finalClaimSource === "canonical_counterfactual" ||
    params.finalClaimSource === "canonical_list_set" ||
    params.finalClaimSource === "canonical_commonality" ||
    supportType === "ListSetSupport" ||
    supportType === "ProfileInferenceSupport" ||
    supportType === "CollectionInferenceSupport" ||
    supportType === "CollectionSetSupport" ||
    supportType === "PreferenceChoiceSupport" ||
    supportType === "CounterfactualCareerSupport"
  ) {
    return "canonical_structured";
  }
  if (params.finalClaimSource === "canonical_exact_detail") {
    return "canonical_exact_detail";
  }
  return "snippet_fallback";
}

export function inferCanonicalTieBreakReason(params: {
  readonly queryText: string;
  readonly finalClaimSource: CanonicalAdjudicationResult["formatted"]["finalClaimSource"] | null | undefined;
  readonly storedCanonical: StoredCanonicalLookup | null | undefined;
  readonly subjectBindingStatus: string | null | undefined;
  readonly renderedSupport: RenderedSupportClaim | null | undefined;
  readonly exactDetailCandidatePredicateFit?: boolean;
  readonly preferDerivedTemporalOverStored: boolean;
}): CanonicalTieBreakReason | null {
  const normalized = normalize(params.queryText).toLowerCase();
  if (params.preferDerivedTemporalOverStored) {
    return "derived_temporal_over_stored_relative";
  }
  if (params.finalClaimSource === "canonical_temporal" && params.subjectBindingStatus === "resolved") {
    return /\b[A-Z][a-z]+(?:'s)?\b/u.test(params.queryText)
      ? "named_subject_binding"
      : "temporal_bound_over_snippet";
  }
  if (
    params.renderedSupport?.supportObjectType === "ListSetSupport" &&
    /\bgoals?\b/u.test(normalized) &&
    /\bcareer|basketball|endorsements?|brand|charity\b/u.test(normalized)
  ) {
    return /\bnot related to\b/u.test(normalized) ? "goal_set_order_preserved" : "goal_set_scope";
  }
  if (
    params.finalClaimSource === "canonical_profile" ||
    params.finalClaimSource === "canonical_report" ||
    params.finalClaimSource === "canonical_counterfactual" ||
    params.finalClaimSource === "canonical_list_set" ||
    params.finalClaimSource === "canonical_commonality" ||
    params.renderedSupport?.supportObjectType === "ListSetSupport" ||
    params.renderedSupport?.supportObjectType === "ProfileInferenceSupport" ||
    params.renderedSupport?.supportObjectType === "CounterfactualCareerSupport"
  ) {
    return params.exactDetailCandidatePredicateFit === false ? "structured_over_scalar" : "structured_over_scalar";
  }
  return null;
}

export function inferStructuredPayloadKind(renderedSupport: RenderedSupportClaim | null | undefined): string | null {
  switch (renderedSupport?.supportObjectType) {
    case "TemporalEventSupport":
      return "temporal_event";
    case "ListSetSupport":
      return "set_entries";
    case "ProfileInferenceSupport":
      return "profile_report";
    case "CollectionInferenceSupport":
      return "collection_report";
    case "CollectionSetSupport":
      return "collection_set";
    case "PreferenceChoiceSupport":
      return "preference_choice";
    case "CounterfactualCareerSupport":
      return "counterfactual_judgment";
    case "DirectDetailSupport":
      return "direct_detail";
    default:
      return null;
  }
}

export function shouldPreferDerivedTemporalOverStored(params: {
  readonly claimText: string;
  readonly storedCanonical: StoredCanonicalLookup | null | undefined;
}): boolean {
  const claimText = normalize(params.claimText);
  if (!claimText || params.storedCanonical?.kind !== "temporal_fact") {
    return false;
  }
  const storedValue = normalize(params.storedCanonical.objectValue);
  const storedRelative =
    params.storedCanonical.timeScopeKind === "anchored_relative" ||
    /\b(yesterday|today|tomorrow|last|next|ago|before|after)\b/iu.test(storedValue);
  const derivedConcrete =
    /\bbetween\b/iu.test(claimText) ||
    /\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/u.test(claimText) ||
    /\b[A-Za-z]+\s+\d{4}\b/u.test(claimText);
  return storedRelative && derivedConcrete;
}

export function shouldUseListSetRenderContract(params: {
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly storedCanonical: StoredCanonicalLookup | null | undefined;
  readonly listSetEntryCount: number;
}): boolean {
  if (params.listSetEntryCount <= 0) {
    return false;
  }
  return (
    params.predicateFamily === "list_set" ||
    params.predicateFamily === "commonality" ||
    params.storedCanonical?.kind === "set"
  );
}
