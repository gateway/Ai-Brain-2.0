import { isBroadDirectFactPressureQuery, isProfileInferenceQuery } from "./query-signals.js";
import { isPreferenceChoiceQuery } from "./answer-retrieval-plan.js";
import { isCampingLocationQuery } from "./location-history/camping.js";
import { isReasonedProfileJudgmentContract } from "./typed-contract-registry.js";
import type { AnswerRetrievalPlan, RetrievalLatencyBudget } from "./types.js";
import { inferTemporalEventKeyFromText } from "../canonical-memory/service.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isSparseProfileInferenceBudgetQuery(normalizedQuery: string): boolean {
  return (
    /\bwould\b|\blikely\b|\bmight\b|\bseem(?:s)?\b/u.test(normalizedQuery) ||
    /\bcareer options?\b|\bwhat\s+fields?\b|\bwhat\s+(?:kind|kinds)\s+of\s+jobs?\b/u.test(normalizedQuery) ||
    /\bwhat\s+kind\s+of\s+role\b|\bwhat\s+role\s+does\b/u.test(normalizedQuery) ||
    /\blooking\s+into\s+(?:counseling|mental health|career|education)\b/u.test(normalizedQuery) ||
    (/\b(?:education|educaton|study|career|major|degree)\b/u.test(normalizedQuery) && /\blikely\b/u.test(normalizedQuery))
  );
}

export function inferPlannerIntentBudgetFamily(
  queryText: string,
  exactDetailFamily: string,
  retrievalPlan?: Pick<AnswerRetrievalPlan, "family" | "lane" | "answerKind" | "controllerIntent"> | null
): RetrievalLatencyBudget["family"] | null {
  const normalized = normalize(queryText);
  const temporalEventKey = inferTemporalEventKeyFromText(queryText);
  const primaryTypedContract = retrievalPlan?.controllerIntent?.primaryTypedContract ?? null;
  if (retrievalPlan?.family === "temporal" || retrievalPlan?.lane === "temporal_event" || retrievalPlan?.answerKind === "temporal_event") {
    return "temporal_event";
  }
  if (
    (retrievalPlan?.answerKind === "location_history" || retrievalPlan?.lane === "location_history") &&
    isCampingLocationQuery(queryText)
  ) {
    return "camping_location_history";
  }
  if (retrievalPlan?.answerKind === "location_history" || retrievalPlan?.lane === "location_history") {
    return "location_history";
  }
  if (retrievalPlan?.answerKind === "event_inventory" || retrievalPlan?.lane === "event_list") {
    return "event_inventory";
  }
  if (primaryTypedContract === "family_activity_inventory") {
    return "event_inventory";
  }
  if (primaryTypedContract === "direct_destress_activity") {
    return "event_inventory";
  }
  if (
    primaryTypedContract === "relationship_profile" ||
    (
      /\brelationship status\b|\bmarried\b|\bsingle\b|\bdating\b|\bdivorc(?:ed|e)\b/iu.test(queryText) &&
      retrievalPlan?.family === "report"
    )
  ) {
    return "relationship_profile";
  }
  if (
    primaryTypedContract === "preference_profile" ||
    primaryTypedContract === "profile_trait_judgment" ||
    (
      (
        /\bpolitical leaning\b|\bwhat do .* kids like\b|\bpreference\b|\blikely\b/iu.test(queryText) ||
        isPreferenceChoiceQuery(queryText)
      ) &&
      retrievalPlan?.family === "report"
    )
  ) {
    return "broad_preference_profile";
  }
  if (
    isReasonedProfileJudgmentContract(primaryTypedContract) ||
    (
      /\bwould\b|\blikely\b|\bmight\b/iu.test(queryText) &&
      /\bcareer option\b|\bpursue\b[^?!.]{0,40}\bcareer\b|\bcounseling\b|\bwriting\b|\bjob\b|\bfield\b/iu.test(queryText) &&
      retrievalPlan?.family === "report"
    )
  ) {
    return "sparse_profile_inference";
  }
  if (
    /\bnegative experience\b|\bwho supports\b|\bsupport network\b/iu.test(queryText) &&
    (retrievalPlan?.answerKind === "support_network" || retrievalPlan?.lane === "support_network")
  ) {
    return "support_network_reasoned";
  }
  if (
    primaryTypedContract === "made_item_inventory" ||
    primaryTypedContract === "made_item_pair_inventory" ||
    (
      /\bwhat has\b.*\bpainted\b|\bwhat kind of art\b|\bmade\b|\bdesigned\b/iu.test(queryText) &&
      (
        retrievalPlan?.answerKind === "inventory_list" ||
        retrievalPlan?.answerKind === "direct_attribute"
      )
    )
  ) {
    return "made_item_inventory";
  }
  if (
    primaryTypedContract === "pet_inventory" ||
    retrievalPlan?.answerKind === "inventory_list" ||
    retrievalPlan?.answerKind === "list_history" ||
    retrievalPlan?.answerKind === "support_network" ||
    retrievalPlan?.lane === "book_list" ||
    retrievalPlan?.lane === "support_network"
  ) {
    return "list_history";
  }
  if (primaryTypedContract === "benefit_reason_slot") {
    return "broad_direct_fact";
  }
  if (
    temporalEventKey &&
    (
      /^\s*when\b/u.test(normalized) ||
      /\bwhat year\b|\bwhich year\b|\bin which month'?s?\b|\bwhat month\b|\bwhich month\b|\bwhat date\b|\bwhich date\b|\bwhat day\b|\bwhich day\b/u.test(normalized)
    )
  ) {
    return "temporal_event";
  }
  if (
    [
      "pet_name",
      "breed",
      "brand",
      "count",
      "service_name",
      "shop",
      "venue",
      "certification",
      "capacity",
      "speed",
      "time_of_day",
      "duration",
      "role"
    ].includes(exactDetailFamily)
  ) {
    return "exact_detail_scalar";
  }
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
  if (isProfileInferenceQuery(queryText) && isSparseProfileInferenceBudgetQuery(normalized)) {
    return "sparse_profile_inference";
  }
  if (isBroadDirectFactPressureQuery(queryText)) {
    return "broad_direct_fact";
  }
  return null;
}
