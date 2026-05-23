import {
  isBenefitReasonSlotQuery,
  isBroadPreferenceProfileQuery,
  isChildScopedPreferenceProfileQuery,
  isConcreteBookHistoryQuery,
  isConcreteEventInventoryQuery,
  isConcreteLocationHistoryQuery,
  isFamilyActivityInventoryQuery,
  isConcreteSupportNetworkQuery,
  isIdentityProfileQuery,
  isMadeItemPairInventoryQuery,
  isPetInventoryQuery,
  isProfileTraitJudgmentQuery,
  isRelationshipProfileQuery
} from "./query-signals.js";
import { extractPairQuerySurfaceNames, extractQuerySurfaceNames } from "./query-subjects.js";
import { isCampingLocationQuery } from "./location-history/camping.js";
import type {
  PlannerAnswerKind,
  RetrievalPlanLane,
  TypedContractName
} from "./types.js";

function isPreferenceChoiceStyleQuery(queryText: string): boolean {
  const normalized = normalize(queryText).toLowerCase();
  if (/\binterested in\b|\bprefer\b|\brather\b/u.test(normalized)) {
    return true;
  }
  if (/\bbooks?\s+by\b/u.test(normalized) && /\bor\b/u.test(normalized)) {
    return true;
  }
  if (!/\bor\b/u.test(normalized)) {
    return false;
  }
  return (
    /\b(would|will|do|does|did|is|are|was|were|could|might|should)\b/u.test(normalized) &&
    /\b(more interested|interested|prefer|rather|choose|pick|like better|enjoy more|enjoy|like|love|read(?:ing)?)\b/u.test(normalized)
  );
}

export interface TypedContractRegistryEntry {
  readonly contract: TypedContractName;
  readonly expectedShape: "scalar" | "list" | "reason" | "judgment";
  readonly requiredFields: readonly string[];
  readonly candidatePools: readonly string[];
  readonly continuationPools: readonly string[];
  readonly supportCompletenessTarget: number;
}

const REGISTRY: Readonly<Record<TypedContractName, TypedContractRegistryEntry>> = {
  book_list: {
    contract: "book_list",
    expectedShape: "list",
    requiredFields: ["book_list_entries"],
    candidatePools: ["canonical_sets", "book_list_support", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["book_list_support", "set_entries"],
    supportCompletenessTarget: 0.9
  },
  book_recommendation_pair: {
    contract: "book_recommendation_pair",
    expectedShape: "scalar",
    requiredFields: ["exact_detail_support"],
    candidatePools: ["canonical_facts", "book_list_support", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["book_list_support", "direct_detail_support"],
    supportCompletenessTarget: 1
  },
  inventory_list: {
    contract: "inventory_list",
    expectedShape: "list",
    requiredFields: ["set_entries"],
    candidatePools: ["canonical_sets", "set_entries", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["set_entries", "direct_detail_support"],
    supportCompletenessTarget: 0.8
  },
  made_item_inventory: {
    contract: "made_item_inventory",
    expectedShape: "list",
    requiredFields: ["set_entries"],
    candidatePools: ["canonical_sets", "set_entries", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["set_entries", "direct_detail_support"],
    supportCompletenessTarget: 0.85
  },
  made_item_pair_inventory: {
    contract: "made_item_pair_inventory",
    expectedShape: "list",
    requiredFields: ["set_entries"],
    candidatePools: ["canonical_sets", "pair_subject_neighbors", "set_entries", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["pair_subject_neighbors", "set_entries", "direct_detail_support"],
    supportCompletenessTarget: 1
  },
  location_history: {
    contract: "location_history",
    expectedShape: "list",
    requiredFields: ["location_history_entries"],
    candidatePools: ["canonical_sets", "set_entries", "subject_object_facts", "snippet_results", "raw_text_fallback"],
    continuationPools: ["set_entries", "subject_object_facts"],
    supportCompletenessTarget: 0.85
  },
  camping_location_history: {
    contract: "camping_location_history",
    expectedShape: "list",
    requiredFields: ["location_history_entries"],
    candidatePools: ["canonical_sets", "set_entries", "subject_object_facts", "snippet_results", "raw_text_fallback"],
    continuationPools: ["set_entries", "subject_object_facts"],
    supportCompletenessTarget: 1
  },
  support_network: {
    contract: "support_network",
    expectedShape: "list",
    requiredFields: ["support_network_entries"],
    candidatePools: ["canonical_sets", "support_network_support", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["support_network_support", "set_entries"],
    supportCompletenessTarget: 1
  },
  event_inventory: {
    contract: "event_inventory",
    expectedShape: "list",
    requiredFields: ["event_list_entries"],
    candidatePools: ["canonical_sets", "normalized_event_facts", "event_list_support", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["event_list_support", "normalized_event_facts", "set_entries"],
    supportCompletenessTarget: 0.85
  },
  family_activity_inventory: {
    contract: "family_activity_inventory",
    expectedShape: "list",
    requiredFields: ["event_list_entries"],
    candidatePools: ["canonical_sets", "normalized_event_facts", "event_list_support", "pair_subject_neighbors", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["event_list_support", "normalized_event_facts", "pair_subject_neighbors"],
    supportCompletenessTarget: 1
  },
  pair_event_inventory: {
    contract: "pair_event_inventory",
    expectedShape: "list",
    requiredFields: ["event_list_entries"],
    candidatePools: ["canonical_sets", "normalized_event_facts", "event_list_support", "pair_subject_neighbors", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["event_list_support", "normalized_event_facts", "pair_subject_neighbors"],
    supportCompletenessTarget: 1
  },
  direct_destress_activity: {
    contract: "direct_destress_activity",
    expectedShape: "list",
    requiredFields: ["event_list_entries"],
    candidatePools: ["canonical_sets", "normalized_event_facts", "event_list_support", "set_entries", "snippet_results", "raw_text_fallback"],
    continuationPools: ["event_list_support", "normalized_event_facts", "set_entries"],
    supportCompletenessTarget: 1
  },
  direct_reason: {
    contract: "direct_reason",
    expectedShape: "reason",
    requiredFields: ["causal_reason"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support"],
    supportCompletenessTarget: 1
  },
  structured_direct_reason: {
    contract: "structured_direct_reason",
    expectedShape: "reason",
    requiredFields: ["causal_reason"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "structured_candidates", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support", "structured_candidates"],
    supportCompletenessTarget: 1
  },
  benefit_reason_slot: {
    contract: "benefit_reason_slot",
    expectedShape: "reason",
    requiredFields: ["causal_reason"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "structured_candidates", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support", "structured_candidates"],
    supportCompletenessTarget: 1
  },
  value_slot: {
    contract: "value_slot",
    expectedShape: "scalar",
    requiredFields: ["exact_detail_support"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support"],
    supportCompletenessTarget: 1
  },
  symbolic_value_slot: {
    contract: "symbolic_value_slot",
    expectedShape: "scalar",
    requiredFields: ["exact_detail_support"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "structured_candidates", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support", "structured_candidates"],
    supportCompletenessTarget: 1
  },
  direct_attribute: {
    contract: "direct_attribute",
    expectedShape: "scalar",
    requiredFields: ["exact_detail_support"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support"],
    supportCompletenessTarget: 1
  },
  temporal_plan_detail: {
    contract: "temporal_plan_detail",
    expectedShape: "scalar",
    requiredFields: ["exact_detail_support"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "normalized_event_facts", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support", "normalized_event_facts"],
    supportCompletenessTarget: 1
  },
  utterance_fact: {
    contract: "utterance_fact",
    expectedShape: "scalar",
    requiredFields: ["quoted_statement"],
    candidatePools: ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["direct_detail_support"],
    supportCompletenessTarget: 1
  },
  pet_inventory: {
    contract: "pet_inventory",
    expectedShape: "list",
    requiredFields: ["set_entries"],
    candidatePools: ["canonical_sets", "set_entries", "structured_candidates", "direct_detail_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["set_entries", "structured_candidates", "direct_detail_support"],
    supportCompletenessTarget: 1
  },
  identity_profile: {
    contract: "identity_profile",
    expectedShape: "scalar",
    requiredFields: ["identity_support"],
    candidatePools: ["report_typed_payloads", "canonical_reports", "profile_report_support", "report_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["profile_report_support", "report_support"],
    supportCompletenessTarget: 1
  },
  relationship_profile: {
    contract: "relationship_profile",
    expectedShape: "scalar",
    requiredFields: ["relationship_status"],
    candidatePools: ["report_typed_payloads", "canonical_reports", "profile_report_support", "report_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["profile_report_support", "report_support"],
    supportCompletenessTarget: 0.85
  },
  preference_profile: {
    contract: "preference_profile",
    expectedShape: "scalar",
    requiredFields: ["preference_value"],
    candidatePools: ["canonical_sets", "report_typed_payloads", "canonical_reports", "preference_support", "set_entries", "profile_report_support", "report_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["preference_support", "set_entries", "profile_report_support", "report_support"],
    supportCompletenessTarget: 0.85
  },
  profile_trait_judgment: {
    contract: "profile_trait_judgment",
    expectedShape: "judgment",
    requiredFields: ["judgment_reason"],
    candidatePools: ["report_typed_payloads", "canonical_reports", "preference_support", "profile_report_support", "report_support", "structured_candidates", "snippet_results", "raw_text_fallback"],
    continuationPools: ["preference_support", "profile_report_support", "structured_candidates"],
    supportCompletenessTarget: 1
  },
  reasoned_profile_judgment: {
    contract: "reasoned_profile_judgment",
    expectedShape: "judgment",
    requiredFields: ["judgment_reason"],
    candidatePools: ["report_typed_payloads", "canonical_reports", "career_support", "profile_report_support", "report_support", "snippet_results", "raw_text_fallback"],
    continuationPools: ["career_support", "profile_report_support", "report_support"],
    supportCompletenessTarget: 0.9
  }
};

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isDirectDestressActivityQuery(queryText: string): boolean {
  return /\bdestress|stress relief|de-?stress|relax|chill out\b/iu.test(queryText);
}

function isReasonedProfileJudgmentQuery(queryText: string): boolean {
  return /\bwould\b|\blikely\b|\bmight\b/iu.test(queryText) &&
    (
      /\bcareer option\b|\bpursue\b[^?!.]{0,40}\bcareer\b|\bcounseling\b|\bwriting\b|\bjob\b|\bfield\b/iu.test(queryText) ||
      /\bif\b[^?!.]{0,80}\bhadn'?t\b/iu.test(queryText)
    );
}

function isBookRecommendationPairQuery(queryText: string): boolean {
  const namedParticipants = extractQuerySurfaceNames(queryText);
  return (
    namedParticipants.length >= 2 &&
    /\bwhat\s+book\b[^?!.]{0,80}\b(?:recommend|suggest)\b/iu.test(queryText)
  ) || (
    namedParticipants.length >= 2 &&
    /\bread\b[^?!.]{0,80}\b(?:suggest(?:ion)?|recommend(?:ed|ation)?)\b/iu.test(queryText)
  );
}

function isTemporalPlanDetailQuery(queryText: string): boolean {
  return (
    /^\s*what\s+does\b[^?!.]{0,120}\bplan\s+to\s+do\b/iu.test(queryText) ||
    /\bwhat\s+events?\b[^?!.]{0,80}\bplanning\b/iu.test(queryText)
  );
}

function isSymbolicValueSlotQuery(queryText: string): boolean {
  return /\bsymbolize\b|\bsymbolism\b|\brepresent\b|\bmeaning\b/iu.test(queryText);
}

function isStructuredReasonQuery(queryText: string): boolean {
  return /\breason\b[^?!.]{0,40}\bgetting into\b|\bwhy\b[^?!.]{0,80}\bstart(?:ed|ing)?\b/iu.test(queryText);
}

export function getTypedContractRegistryEntry(contract: TypedContractName | null | undefined): TypedContractRegistryEntry | null {
  if (!contract) {
    return null;
  }
  return REGISTRY[contract] ?? null;
}

export function resolvePrimaryTypedContract(params: {
  readonly queryText: string;
  readonly lane: RetrievalPlanLane;
  readonly answerKind: PlannerAnswerKind;
  readonly family: "report" | "list_set" | "exact_detail" | "temporal" | "abstention" | "generic";
}): TypedContractName | null {
  if (isDirectDestressActivityQuery(params.queryText)) {
    return "direct_destress_activity";
  }
  if (isFamilyActivityInventoryQuery(params.queryText)) {
    return "family_activity_inventory";
  }
  if (isBookRecommendationPairQuery(params.queryText)) {
    return "book_recommendation_pair";
  }
  if (isBenefitReasonSlotQuery(params.queryText)) {
    return "benefit_reason_slot";
  }
  if (isTemporalPlanDetailQuery(params.queryText)) {
    return "temporal_plan_detail";
  }
  if (isMadeItemPairInventoryQuery(params.queryText)) {
    return "made_item_pair_inventory";
  }
  if (isPetInventoryQuery(params.queryText)) {
    return "pet_inventory";
  }
  if (params.family === "report" && isReasonedProfileJudgmentQuery(params.queryText)) {
    return "reasoned_profile_judgment";
  }
  if (params.family === "report" && isProfileTraitJudgmentQuery(params.queryText)) {
    return "profile_trait_judgment";
  }
  if (params.lane === "book_list" || params.answerKind === "list_history" || isConcreteBookHistoryQuery(params.queryText)) {
    return "book_list";
  }
  if (params.lane === "support_network" || params.answerKind === "support_network" || isConcreteSupportNetworkQuery(params.queryText)) {
    return "support_network";
  }
  if (params.lane === "event_list" || params.answerKind === "event_inventory" || isConcreteEventInventoryQuery(params.queryText)) {
    return extractPairQuerySurfaceNames(params.queryText).length >= 2 ? "pair_event_inventory" : "event_inventory";
  }
  if (params.lane === "location_history" || params.answerKind === "location_history" || isConcreteLocationHistoryQuery(params.queryText)) {
    return isCampingLocationQuery(params.queryText) ? "camping_location_history" : "location_history";
  }
  if (isChildScopedPreferenceProfileQuery(params.queryText)) {
    return "preference_profile";
  }
  if (params.answerKind === "inventory_list") {
    if (isMadeItemPairInventoryQuery(params.queryText)) {
      return "made_item_pair_inventory";
    }
    if (isPetInventoryQuery(params.queryText)) {
      return "pet_inventory";
    }
    return "inventory_list";
  }
  if (params.answerKind === "direct_reason") {
    if (isBenefitReasonSlotQuery(params.queryText)) {
      return "benefit_reason_slot";
    }
    return isStructuredReasonQuery(params.queryText) ? "structured_direct_reason" : "direct_reason";
  }
  if (params.answerKind === "value_slot") {
    return isSymbolicValueSlotQuery(params.queryText) ? "symbolic_value_slot" : "value_slot";
  }
  if (params.answerKind === "direct_attribute") {
    return "direct_attribute";
  }
  if (params.answerKind === "utterance_fact") {
    return "utterance_fact";
  }
  if (params.family === "report" && isRelationshipProfileQuery(params.queryText)) {
    return "relationship_profile";
  }
  if (params.family === "report" && (isBroadPreferenceProfileQuery(params.queryText) || isPreferenceChoiceStyleQuery(params.queryText))) {
    return "preference_profile";
  }
  if (params.family === "report" && isIdentityProfileQuery(params.queryText)) {
    return "identity_profile";
  }
  return null;
}

export function resolveTypedContractFromPlan(params: {
  readonly queryText: string;
  readonly retrievalPlan: Pick<
    { readonly family: "report" | "list_set" | "exact_detail" | "temporal" | "abstention" | "generic"; readonly answerKind: PlannerAnswerKind; readonly lane: RetrievalPlanLane; readonly controllerIntent?: { readonly primaryTypedContract?: TypedContractName | null } },
    "family" | "answerKind" | "lane" | "controllerIntent"
  >;
}): TypedContractName | null {
  return (
    params.retrievalPlan.controllerIntent?.primaryTypedContract ??
    resolvePrimaryTypedContract({
      queryText: params.queryText,
      lane: params.retrievalPlan.lane,
      answerKind: params.retrievalPlan.answerKind,
      family: params.retrievalPlan.family
    })
  );
}

export function inferTypedContractRequiredField(contract: TypedContractName): string {
  return REGISTRY[contract].requiredFields[0] ?? "exact_detail_support";
}

export function isDirectDestressTypedContract(contract: TypedContractName | null | undefined): boolean {
  return contract === "direct_destress_activity" || contract === "event_inventory" || contract === "pair_event_inventory";
}

export function normalizeTypedContractListContract(contract: TypedContractName): TypedContractName {
  if (contract === "direct_destress_activity") {
    return "event_inventory";
  }
  if (contract === "family_activity_inventory") {
    return "event_inventory";
  }
  if (contract === "pair_event_inventory") {
    return "event_inventory";
  }
  if (contract === "made_item_pair_inventory") {
    return "made_item_inventory";
  }
  return contract;
}

export function typedContractExpectedShape(contract: TypedContractName | null | undefined): TypedContractRegistryEntry["expectedShape"] | null {
  return contract ? REGISTRY[contract]?.expectedShape ?? null : null;
}

export function typedContractCandidatePools(contract: TypedContractName | null | undefined): readonly string[] {
  return contract ? REGISTRY[contract]?.candidatePools ?? [] : [];
}

export function typedContractContinuationPools(contract: TypedContractName | null | undefined): readonly string[] {
  return contract ? REGISTRY[contract]?.continuationPools ?? [] : [];
}

export function typedContractSupportCompletenessTarget(contract: TypedContractName | null | undefined): number | null {
  return contract ? REGISTRY[contract]?.supportCompletenessTarget ?? null : null;
}

export function isReasonedProfileJudgmentContract(contract: TypedContractName | null | undefined): boolean {
  return contract === "reasoned_profile_judgment" || contract === "profile_trait_judgment";
}

export function isDirectDestressQueryText(queryText: string): boolean {
  return isDirectDestressActivityQuery(queryText);
}

export function isReasonedProfileJudgmentQueryText(queryText: string): boolean {
  return isReasonedProfileJudgmentQuery(queryText);
}
