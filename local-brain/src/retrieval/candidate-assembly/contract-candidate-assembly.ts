import type {
  CandidatePoolSelection,
  CanonicalReportKind,
  RetrievalRescuePolicy,
  SuppressionPoolSelection,
  TargetedBackfillRequest,
  TypedContractName
} from "../types.js";
import {
  getTypedContractRegistryEntry,
  isDirectDestressQueryText,
  isReasonedProfileJudgmentQueryText,
  typedContractCandidatePools,
  typedContractSupportCompletenessTarget
} from "../typed-contract-registry.js";

export interface ContractAssemblyAdjustmentState {
  readonly candidatePools: CandidatePoolSelection[];
  readonly suppressionPools: SuppressionPoolSelection[];
  readonly targetedFields: string[];
  readonly requiredFields: string[];
  readonly targetedBackfill: string[];
  readonly targetedBackfillRequests: TargetedBackfillRequest[];
  readonly queryExpansionTerms: Set<string>;
  readonly ownerEligibilityHints: string[];
  readonly suppressionHints: string[];
  familyConfidence: number;
  supportCompletenessTarget: number;
  rescuePolicy: RetrievalRescuePolicy;
}

function pushUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function addBackfillRequest(
  target: TargetedBackfillRequest[],
  request: TargetedBackfillRequest
): void {
  if (!target.some((entry) => entry.reason === request.reason)) {
    target.push(request);
  }
}

function asCandidatePoolSelection(pool: string): CandidatePoolSelection {
  return pool as CandidatePoolSelection;
}

function isCompanionScopedIndoorActivityQuery(queryText: string): boolean {
  return (
    /\bindoor activities?\b/iu.test(queryText) &&
    /\bwith\b[^?!.]{0,40}\b(?:girlfriend|boyfriend|wife|husband|partner|fianc[eé]|fiancée|gf|bf)\b/iu.test(queryText)
  );
}

function addContractFieldPolicy(params: {
  readonly contract: TypedContractName;
  readonly state: ContractAssemblyAdjustmentState;
}): void {
  const entry = getTypedContractRegistryEntry(params.contract);
  if (!entry) {
    return;
  }
  for (const field of entry.requiredFields) {
    pushUnique(params.state.requiredFields, field);
    pushUnique(params.state.targetedFields, field);
    pushUnique(params.state.targetedBackfill, field);
  }

  const reason =
    params.contract === "book_list"
      ? "book_list_entries_missing"
      : params.contract === "book_recommendation_pair"
        ? "book_recommendation_pair_missing"
      : params.contract === "event_inventory" || params.contract === "direct_destress_activity"
        ? "event_list_entries_missing"
        : params.contract === "family_activity_inventory"
          ? "event_list_entries_missing"
        : params.contract === "pair_event_inventory"
          ? "pair_event_entries_missing"
          : params.contract === "support_network"
            ? "support_network_entries_missing"
            : params.contract === "location_history" || params.contract === "camping_location_history"
              ? "location_history_entries_missing"
            : params.contract === "inventory_list" || params.contract === "made_item_inventory" || params.contract === "made_item_pair_inventory" || params.contract === "pet_inventory"
              ? "set_entries_missing"
              : params.contract === "identity_profile"
                ? "identity_support_missing"
                : params.contract === "relationship_profile"
                  ? "relationship_status_missing"
                  : params.contract === "preference_profile"
                    ? "preference_value_missing"
                    : params.contract === "reasoned_profile_judgment" || params.contract === "profile_trait_judgment"
                      ? "judgment_reason_missing"
                      : params.contract === "direct_reason" || params.contract === "structured_direct_reason" || params.contract === "benefit_reason_slot"
                        ? "exact_detail_support_missing"
                        : params.contract === "value_slot" || params.contract === "symbolic_value_slot" || params.contract === "direct_attribute" || params.contract === "temporal_plan_detail" || params.contract === "utterance_fact"
                          ? "exact_detail_support_missing"
                          : null;
  if (!reason) {
    return;
  }
  addBackfillRequest(params.state.targetedBackfillRequests, {
    reason,
    requiredFields: entry.requiredFields,
    candidatePool: asCandidatePoolSelection(entry.continuationPools[0] ?? entry.candidatePools[0] ?? "snippet_results"),
    maxPasses: 1
  });
}

function addContractExpansionTerms(contract: TypedContractName, queryText: string, target: Set<string>): void {
  const values: string[] =
    contract === "book_list"
      ? ["book", "books", "read", "reading", "title", "titles"]
      : contract === "book_recommendation_pair"
        ? ["book", "books", "recommend", "recommended", "suggestion", "suggested", "title"]
      : contract === "event_inventory" || contract === "direct_destress_activity"
        ? ["activity", "activities", "event", "events", "participated", "partake", "destress", "relax"]
        : contract === "family_activity_inventory"
          ? ["activity", "activities", "family", "hike", "hiking", "camping", "workshop", "discussion"]
        : contract === "pair_event_inventory"
          ? ["event", "events", "together", "shared", "attended", "participated"]
        : contract === "camping_location_history"
          ? ["camp", "camped", "camping", "campground", "campsite"]
          : contract === "location_history"
            ? ["location", "place", "visited", "went", "travel"]
            : contract === "made_item_pair_inventory"
              ? ["painted", "painting", "pottery", "made", "made together", "kids", "family"]
              : contract === "pet_inventory"
                ? ["pet", "pets", "dog", "dogs", "cat", "cats", "turtle", "turtles"]
            : contract === "support_network"
              ? ["support", "supports", "supporter", "supportive", "friend", "friends", "family", "mentor", "mentors", "rock", "rocks", "there for", "strength"]
              : contract === "identity_profile"
                ? ["identity", "transgender", "nonbinary", "queer", "lgbtq"]
                : contract === "preference_profile"
                  ? ["like", "likes", "favorite", "favorites", "enjoy"]
                  : contract === "profile_trait_judgment"
                    ? ["religious", "personality", "traits", "enjoy", "move back", "political", "leaning"]
                    : contract === "relationship_profile"
                    ? ["relationship", "single", "single parent", "dating", "married", "breakup", "broke up", "partner"]
                    : contract === "reasoned_profile_judgment"
                      ? ["career", "counseling", "writing", "job", "field"]
                      : contract === "benefit_reason_slot"
                        ? ["motivated", "inspired", "great for", "benefit", "take away"]
                      : contract === "structured_direct_reason"
                        ? ["reason", "because", "started", "got into"]
                        : contract === "symbolic_value_slot"
                          ? ["symbolize", "symbolism", "represent", "meaning"]
                          : contract === "temporal_plan_detail"
                            ? ["plan", "planning", "grand opening", "fundraiser", "do"]
                      : [];
  for (const value of values) {
    target.add(value);
  }
  if (contract === "event_inventory" && isCompanionScopedIndoorActivityQuery(queryText)) {
    for (const value of [
      "indoor",
      "board games",
      "boardgames",
      "wine tasting",
      "pet shelter",
      "volunteering",
      "flowers",
      "growing flowers",
      "taking care of flowers",
      "garden"
    ]) {
      target.add(value);
    }
  }
  if (isDirectDestressQueryText(queryText)) {
    target.add("stress");
    target.add("stress relief");
  }
}

export function applyContractCandidateAssemblyAdjustments(params: {
  readonly queryText: string;
  readonly reportKind?: CanonicalReportKind | null;
  readonly primaryTypedContract: TypedContractName | null;
  readonly state: ContractAssemblyAdjustmentState;
}): void {
  const contract = params.primaryTypedContract;
  if (!contract) {
    return;
  }
  for (const pool of typedContractCandidatePools(contract)) {
    pushUnique(params.state.candidatePools, asCandidatePoolSelection(pool));
  }
  if (contract !== "reasoned_profile_judgment") {
    pushUnique(params.state.suppressionPools, "generic_snippet_support");
  }
  if (["book_list", "book_recommendation_pair", "event_inventory", "family_activity_inventory", "pair_event_inventory", "direct_destress_activity", "support_network", "location_history", "camping_location_history", "inventory_list", "made_item_inventory", "made_item_pair_inventory", "pet_inventory"].includes(contract)) {
    pushUnique(params.state.ownerEligibilityHints, "canonical_list_set");
    pushUnique(params.state.suppressionHints, "canonical_exact_detail");
    pushUnique(params.state.suppressionHints, "runtime_exact_detail");
  }
  const targetCompleteness = typedContractSupportCompletenessTarget(contract);
  if (targetCompleteness !== null) {
    params.state.supportCompletenessTarget = Math.max(params.state.supportCompletenessTarget, targetCompleteness);
  }
  if (contract === "identity_profile" || contract === "relationship_profile" || contract === "preference_profile" || contract === "reasoned_profile_judgment" || contract === "profile_trait_judgment") {
    params.state.familyConfidence = Math.max(params.state.familyConfidence, 0.9);
  }
  if (contract === "reasoned_profile_judgment" || contract === "profile_trait_judgment" || (params.reportKind === "career_report" && isReasonedProfileJudgmentQueryText(params.queryText))) {
    params.state.rescuePolicy = "single_targeted_rescue_before_fallback";
  }
  addContractFieldPolicy({ contract, state: params.state });
  addContractExpansionTerms(contract, params.queryText, params.state.queryExpansionTerms);
}
