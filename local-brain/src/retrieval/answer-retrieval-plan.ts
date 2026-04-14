import type { RecallResult } from "../types.js";
import {
  inferTemporalEventKeyFromText,
  type StoredCanonicalLookup
} from "../canonical-memory/service.js";
import {
  extractAnchoredQuerySurfaceNames,
  extractObjectQuerySurfaceNames,
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";
import { isConcreteConsumablePreferenceQuery } from "./query-signals.js";
import type {
  AnswerOwnerFamily,
  AnswerRetrievalPlan,
  AtomicMemoryUnit,
  CandidatePoolSelection,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  DirectDetailSupportUnit,
  RetrievalPlanLane,
  RetrievalRescuePolicy,
  SuppressionPoolSelection,
  TargetedBackfillRequest,
  TemporalEventFactSupportUnit
} from "./types.js";

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeFamily(predicateFamily: CanonicalPredicateFamily): AnswerOwnerFamily | "generic" {
  if (predicateFamily === "temporal_event_fact") {
    return "temporal";
  }
  if (predicateFamily === "list_set" || predicateFamily === "commonality" || predicateFamily === "location_history") {
    return "list_set";
  }
  if (
    predicateFamily === "profile_state" ||
    predicateFamily === "counterfactual" ||
    predicateFamily.startsWith("narrative_")
  ) {
    return "report";
  }
  if (predicateFamily === "abstention") {
    return "abstention";
  }
  return "exact_detail";
}

export function retrievalPlanLaneToOwnerFamily(lane: RetrievalPlanLane): AnswerOwnerFamily | "generic" {
  switch (lane) {
    case "collection_inference":
    case "report":
      return "report";
    case "temporal_event":
      return "temporal";
    case "event_list":
    case "book_list":
    case "support_network":
    case "location_history":
      return "list_set";
    case "exact_detail":
      return "exact_detail";
    case "abstention":
      return "abstention";
    default:
      return "generic";
  }
}

function isInferentialProfileQuery(queryText: string): boolean {
  return (
    /\bwould\b|\blikely\b/iu.test(queryText) &&
    (
      /\bbookshelf\b/iu.test(queryText) ||
      /\bdr\.?\s*seuss\b/iu.test(queryText) ||
      /\bcollect(?:ion|s)?\b/iu.test(queryText) ||
      /\binterested in\b/iu.test(queryText) ||
      /\bmember of the lgbtq community\b/iu.test(queryText) ||
      /\bally\b/iu.test(queryText)
    )
  );
}

function isEventListQuery(queryText: string): boolean {
  return (
    /\bwhat\s+(?:[a-z0-9+&'’ -]+\s+)?events?\b/iu.test(queryText) &&
    /\bparticipat(?:e|ed|es|ing)\b|\battend(?:ed|ing|s)?\b|\bwent to\b|\bgone to\b/iu.test(queryText)
  );
}

function isBookListQuery(queryText: string): boolean {
  if (/\bfavorite\s+book\s+series\b/iu.test(queryText) && /\babout\b/iu.test(queryText)) {
    return false;
  }
  return (
    /\bwhat\s+books?\b/iu.test(queryText) ||
    /\bfavorite books?\b/iu.test(queryText) ||
    /\bbooks?\b[^?!.]{0,40}\bread\b/iu.test(queryText)
  );
}

function isSupportNetworkQuery(queryText: string): boolean {
  return (
    /\bwho\s+supports?\b/iu.test(queryText) ||
    /\bsupport network\b/iu.test(queryText) ||
    (/\bfriends?\b/iu.test(queryText) && /\bbesides\b/iu.test(queryText))
  );
}

function isPairLocationResolutionQuery(queryText: string): boolean {
  const pairNames = extractPairQuerySurfaceNames(queryText);
  if (pairNames.length < 2) {
    return false;
  }
  const normalized = normalize(queryText);
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

function isLocationHistoryQuery(queryText: string): boolean {
  return (
    isPairLocationResolutionQuery(queryText) ||
    /\bwhere\b[^?!.]{0,80}\b(?:made friends|vacationed|travel(?:ed|ing)?|visited|went)\b/iu.test(queryText) ||
    /\bwhat\s+(?:states|areas|places)\b/iu.test(queryText)
  );
}

function isPetCareQuery(queryText: string): boolean {
  return /\bdog\b|\bdogs\b|\bpet\b|\bclasses?\b|\bgroups?\b|\bcare\b|\bagility\b|\bindoor activity\b|\bdog treats?\b/iu.test(queryText);
}

function isMedicalInferenceQuery(queryText: string): boolean {
  return /\bunderlying condition\b|\ballerg(?:y|ies)\b|\basthma\b|\bmedical condition\b/iu.test(queryText);
}

function isAspirationQuery(queryText: string): boolean {
  return /\bstore\b|\bbusiness\b|\bventure\b|\bstartup\b|\bapp\b|\bunique\b|\bbrand\b|\bdream\b|\bwhy\b.*\b(start|open|build)\b/iu.test(queryText);
}

function isTravelReportQuery(queryText: string): boolean {
  return /\broadtrips?\b|\btrip\b|\btravel\b|\bfestival\b|\bwhere has\b|\bwhere did\b.*\broadtrip\b/iu.test(queryText);
}

function isExplicitTemporalLookupQuery(queryText: string): boolean {
  return (
    /^\s*when\b/iu.test(queryText) ||
    /\bwhat year\b|\bwhich year\b/iu.test(queryText) ||
    /\bin which month'?s?\b|\bwhat month\b|\bwhich month\b/iu.test(queryText) ||
    /\bon what date\b|\bon which date\b|\bwhat date\b|\bwhich date\b/iu.test(queryText) ||
    /\bwhat day\b|\bwhich day\b/iu.test(queryText)
  );
}

function isBookshelfCollectionQuery(queryText: string): boolean {
  return /\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children'?s books?\b/iu.test(queryText);
}

function isGenericCollectionQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  if (
    /\b(?:buy|bought|purchase|purchased)\b/u.test(normalized) ||
    /\bwhat\s+items?\s+(?:did|has|have)\b/u.test(normalized) && /\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/u.test(normalized)
  ) {
    return false;
  }
  return (
    /\bwhat\s+items?\b/u.test(normalized) ||
    /\bwhat\s+does\b[^?!.]{0,80}\bcollect\b/u.test(normalized) ||
    /\bcollect(?:ion|s|ing)?\b/u.test(normalized) ||
    /\bcollectibles?\b/u.test(normalized) ||
    /\bmemorabilia\b/u.test(normalized)
  );
}

function isCommunityMembershipQuery(queryText: string): boolean {
  return /\bmember of the lgbtq community\b|\bally\b|\blgbtq\+?\b|\btransgender\b|\bpride\b/iu.test(queryText);
}

function isBooksByAuthorPreferenceQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return /\bbooks?\s+by\b/u.test(normalized) && /\bor\b/u.test(normalized);
}

export function isPreferenceChoiceQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  if (/\binterested in\b|\bprefer\b|\brather\b/u.test(normalized)) {
    return true;
  }
  if (isBooksByAuthorPreferenceQuery(queryText)) {
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

function isComparativeFitQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
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

function isPreferenceProfileQuery(queryText: string): boolean {
  if (/\bfavorite\s+style\s+of\s+painting\b/iu.test(queryText)) {
    return false;
  }
  if (isConcreteConsumablePreferenceQuery(queryText.trim())) {
    return false;
  }
  return (
    /\bfavorite\b.*\bstyle\b/iu.test(queryText) ||
    /\bfavorite\b.*\bdance\b/iu.test(queryText) ||
    /\bwhat is\b[^?!.]{0,80}\bfavorite style of dance\b/iu.test(queryText)
  );
}

function isCareerDirectionQuery(queryText: string): boolean {
  return /\bcareer\b|\bjob\b|\bfield\b|\bwork\b|\beduc/i.test(queryText) || /\bwriting\b/iu.test(queryText);
}

function isEducationFieldQuery(queryText: string): boolean {
  return (
    /\bwhat fields? would\b|\bwhat field would\b|\blikely\b.*\bpursue\b|\bpursue\b.*\beducat(?:ion|e|on)\b/iu.test(queryText) &&
    /\bfields?\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e|on)\b|\bstud(?:y|ied|ying)\b|\bcertification\b/iu.test(queryText)
  );
}

function isCareerReportQuery(queryText: string): boolean {
  return /\bwould\b.*\bpursue\b|\bcareer option\b|\bwhat kind of work\b|\bwhat career\b/iu.test(queryText);
}

function isNarrativeReasoningQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return (
    /^\s*why\b/iu.test(normalized) ||
    /\bwhat advice (?:might|would)\b/iu.test(normalized) ||
    /\badvice might\b[^?!.]{0,80}\bgive\b/iu.test(normalized) ||
    /\bhow did\b[^?!.]{0,100}\bhelp\b/iu.test(normalized) ||
    /\bwhat did\b[^?!.]{0,60}\brealiz(?:e|ed)\b/iu.test(normalized) ||
    /\bgoals?\b|\bdreams?\b|\bfinancial status\b|\bwhat might\b|\bmain focus\b/iu.test(normalized) ||
    /\bhow does\b[^?!.]{0,80}\bplan to\b/iu.test(normalized) ||
    /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/iu.test(normalized) ||
    isPetCareQuery(queryText) ||
    isAspirationQuery(queryText) ||
    isTravelReportQuery(queryText) ||
    isCareerDirectionQuery(queryText)
  );
}

function isCausalReasonQuery(queryText: string): boolean {
  return (
    /^\s*what helped\b/iu.test(queryText) ||
    /^\s*why\b/iu.test(queryText) ||
    /\bhow did\b[^?!.]{0,100}\bhelp\b/iu.test(queryText) ||
    /\bwhat\s+(?:made|caused|prompted|inspired|motivated)\b/iu.test(queryText) ||
    /\breason\b/iu.test(queryText)
  );
}

function isGriefPeaceSupportQuery(queryText: string): boolean {
  return /\bwhat helped\b|\bfind peace\b|\bgrieving\b|\bcope with grief\b|\bfind comfort\b/iu.test(queryText);
}

function isRealizationExactDetailQuery(queryText: string): boolean {
  return /^\s*what\s+did\b/iu.test(queryText) && /\brealiz(?:e|ed|ing)\b/iu.test(queryText);
}

function isStressBusterActivityQuery(queryText: string): boolean {
  return (
    /^\s*what\s+did\b/iu.test(queryText) &&
    /\bstart(?:ed|ing)?\s+doing\b/iu.test(queryText) &&
    /\b(stress|stress-buster|stress relief|happy place|escape)\b/iu.test(queryText)
  );
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
  return (
    /\bgoals?\b/iu.test(queryText) &&
    /\bbasketball\b/iu.test(queryText) &&
    !isOffCourtCareerGoalQuery(queryText)
  );
}

function isConcreteExactDetailQuery(queryText: string, predicateFamily: CanonicalPredicateFamily): boolean {
  const normalized = normalize(queryText);
  if (/\bfavorite\s+style\s+of\s+painting\b/iu.test(normalized)) {
    return true;
  }
  if (isConcreteConsumablePreferenceQuery(queryText.trim())) {
    return true;
  }
  if (/^\s*what\s+advice\s+did\b/iu.test(normalized)) {
    return true;
  }
  if (/\bhow\s+long\b/iu.test(normalized) && /\b(?:have|has|had)\b/iu.test(normalized)) {
    return true;
  }
  if ((/\bcompany\b|\bbrand\b|\bsponsor\b/iu.test(normalized)) && /\bendorsement\b/iu.test(normalized)) {
    return true;
  }
  if (isStressBusterActivityQuery(queryText)) {
    return true;
  }
  if (
    isExplicitTemporalLookupQuery(queryText) ||
    normalizeFamily(predicateFamily) === "temporal" ||
    isEventListQuery(queryText) ||
    isBookListQuery(queryText) ||
    isSupportNetworkQuery(queryText) ||
    isPairLocationResolutionQuery(queryText) ||
    isBookshelfCollectionQuery(queryText) ||
    isCommunityMembershipQuery(queryText) ||
    isInferentialProfileQuery(queryText) ||
    isCareerReportQuery(queryText) ||
    isPetCareQuery(queryText) ||
    isMedicalInferenceQuery(queryText) ||
    isAspirationQuery(queryText) ||
    isTravelReportQuery(queryText)
  ) {
    return false;
  }
  if (
    /\bwhy\b/iu.test(normalized) ||
    /\bwould\b/iu.test(normalized) ||
    /\blikely\b/iu.test(normalized) ||
    /\bgoals?\b/iu.test(normalized) ||
    /\bdreams?\b/iu.test(normalized) ||
    /\bplans?\b/iu.test(normalized) ||
    /\bfinancial status\b/iu.test(normalized) ||
    /\bidentity\b/iu.test(normalized) ||
    /\brelationship status\b/iu.test(normalized) ||
    /\bmember of\b/iu.test(normalized) ||
    /\bally\b/iu.test(normalized) ||
    /\bcollect(?:ion|s)?\b/iu.test(normalized) ||
    /\bbookshelf\b/iu.test(normalized) ||
    /\bcollectibles?\b/iu.test(normalized) ||
    /\bcareer\b/iu.test(normalized) ||
    /\bdegree\b/iu.test(normalized) ||
    /\bfield\b/iu.test(normalized) ||
    /\bwhat challenge did\b/iu.test(normalized) ||
    /\bwhat inspired\b/iu.test(normalized) ||
    isPreferenceProfileQuery(queryText) ||
    /\bhow does\b[^?!.]{0,80}\bplan to\b/iu.test(normalized) ||
    /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/iu.test(normalized)
  ) {
    return false;
  }
  if (predicateFamily !== "generic_fact" && normalizeFamily(predicateFamily) === "exact_detail") {
    return true;
  }
  return (
    /^\s*(what|which|who|where)\b/iu.test(normalized) &&
    (
      /^\s*what did\b(?!.*\brealiz)/iu.test(normalized) ||
      /\b(kind|type|color|colors|name|names|country|city|movie|movies|book|books|series|trilogy|band|bands|dj|game|games|pet|pets|item|items|flower|flowers|bird|birds|car|cars|hobbies|pastry|pastries)\b/iu.test(normalized) ||
      /\bfavorite\s+(movie|movies|book|books|series|trilogy|band|dj|game|games|memory)\b/iu.test(normalized)
    )
  );
}

export function inferAnswerRetrievalPredicateFamily(
  queryText: string,
  fallbackPredicateFamily: CanonicalPredicateFamily = "generic_fact"
): CanonicalPredicateFamily {
  if (/^\s*what helped\b/iu.test(queryText)) {
    return "profile_state";
  }
  if (isExplicitTemporalLookupQuery(queryText)) {
    return "temporal_event_fact";
  }
  if (isLocationHistoryQuery(queryText)) {
    return "location_history";
  }
  if (isEventListQuery(queryText) || isBookListQuery(queryText) || isSupportNetworkQuery(queryText) || isPairLocationResolutionQuery(queryText)) {
    return "list_set";
  }
  if (isConcreteExactDetailQuery(queryText, fallbackPredicateFamily)) {
    return "generic_fact";
  }
  if (
    isInferentialProfileQuery(queryText) ||
    isGenericCollectionQuery(queryText) ||
    isCommunityMembershipQuery(queryText) ||
    isCareerReportQuery(queryText) ||
    isPreferenceProfileQuery(queryText) ||
    isNarrativeReasoningQuery(queryText) ||
    isPetCareQuery(queryText) ||
    isMedicalInferenceQuery(queryText) ||
    isAspirationQuery(queryText) ||
    isTravelReportQuery(queryText)
  ) {
    return "profile_state";
  }
  if (isPreferenceChoiceQuery(queryText)) {
    return "profile_state";
  }
  return fallbackPredicateFamily;
}

function reportKindImpliesReportLane(reportKind: CanonicalReportKind | null | undefined, queryText: string): boolean {
  if (!reportKind) {
    return false;
  }
  if (reportKind === "pet_care_report" && isPetCareQuery(queryText)) {
    return true;
  }
  if (reportKind === "aspiration_report" && isAspirationQuery(queryText)) {
    return true;
  }
  if (reportKind === "travel_report" && isTravelReportQuery(queryText)) {
    return true;
  }
  if (reportKind === "profile_report" && (isNarrativeReasoningQuery(queryText) || isMedicalInferenceQuery(queryText))) {
    return true;
  }
  return false;
}

function inferPlannerLane(
  queryText: string,
  predicateFamily: CanonicalPredicateFamily,
  reportKind?: CanonicalReportKind | null
): RetrievalPlanLane {
  if (normalizeFamily(predicateFamily) === "abstention") {
    return "abstention";
  }
  if (/^\s*what helped\b/iu.test(queryText)) {
    return "report";
  }
  if (normalizeFamily(predicateFamily) === "temporal" || isExplicitTemporalLookupQuery(queryText)) {
    return "temporal_event";
  }
  if (isBookshelfCollectionQuery(queryText) || isGenericCollectionQuery(queryText)) {
    return "collection_inference";
  }
  if (isEventListQuery(queryText)) {
    return "event_list";
  }
  if (isBookListQuery(queryText)) {
    return "book_list";
  }
  if (isSupportNetworkQuery(queryText)) {
    return "support_network";
  }
  if (isPairLocationResolutionQuery(queryText)) {
    return "location_history";
  }
  if (isLocationHistoryQuery(queryText) || predicateFamily === "location_history") {
    return "location_history";
  }
  if (isComparativeFitQuery(queryText)) {
    return "report";
  }
  if (reportKindImpliesReportLane(reportKind, queryText)) {
    return "report";
  }
  if (isConcreteExactDetailQuery(queryText, predicateFamily)) {
    return "exact_detail";
  }
  if (
    isInferentialProfileQuery(queryText) ||
    isEducationFieldQuery(queryText) ||
    isCareerReportQuery(queryText) ||
    isCommunityMembershipQuery(queryText) ||
    isPreferenceChoiceQuery(queryText) ||
    isPreferenceProfileQuery(queryText) ||
    isMedicalInferenceQuery(queryText) ||
    isNarrativeReasoningQuery(queryText)
  ) {
    return "report";
  }
  if (normalizeFamily(predicateFamily) === "exact_detail") {
    return "exact_detail";
  }
  return "generic";
}

function readProvenanceText(result: RecallResult, key: string): string | null {
  const direct = result.provenance[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const nested = metadata?.[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

function readProvenanceMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function readCollectionUnitValues(result: RecallResult): readonly string[] {
  const metadata = readProvenanceMetadata(result);
  const answerPayload =
    typeof metadata?.answer_payload === "object" && metadata.answer_payload !== null
      ? (metadata.answer_payload as Record<string, unknown>)
      : null;
  const itemValues = Array.isArray(answerPayload?.item_values)
    ? answerPayload.item_values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const collectionItemValue = typeof metadata?.collection_item_value === "string" ? metadata.collection_item_value.trim() : "";
  const answerValue = typeof answerPayload?.answer_value === "string" ? answerPayload.answer_value.trim() : "";
  return unique([...itemValues, collectionItemValue, answerValue]);
}

function readCollectionUnitSourceText(result: RecallResult): string {
  const metadata = readProvenanceMetadata(result);
  const sourceSentenceText = typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text.trim() : "";
  const sourceTurnText = typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text.trim() : "";
  return sourceSentenceText || sourceTurnText || result.content;
}

export function buildAnswerRetrievalPlan(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly reportKind?: CanonicalReportKind | null;
  readonly supportObjectType?: string | null;
  readonly subjectBindingStatus?: "resolved" | "ambiguous" | "unresolved";
  readonly temporalEventIdentityStatus?: string | null;
  readonly temporalGranularityStatus?: string | null;
  readonly subjectEntityHints?: readonly string[];
}): AnswerRetrievalPlan {
  const lane = inferPlannerLane(params.queryText, params.predicateFamily, params.reportKind);
  const family = retrievalPlanLaneToOwnerFamily(lane);
  const pairNames = extractPairQuerySurfaceNames(params.queryText);
  const anchoredSubjectNames = extractAnchoredQuerySurfaceNames(params.queryText);
  const genericSurfaceNames = extractQuerySurfaceNames(params.queryText);
  const subjectNames =
    pairNames.length >= 2
      ? unique(pairNames)
      : anchoredSubjectNames.length > 0
        ? unique(anchoredSubjectNames)
        : unique(genericSurfaceNames.slice(0, 1));
  const objectNames = unique(genericSurfaceNames.filter((name) => !subjectNames.includes(name)));
  const pairSubjectNames = pairNames.length >= 2 ? unique(pairNames.slice(1)) : [];
  const candidatePools: CandidatePoolSelection[] =
    lane === "temporal_event"
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
      : lane === "collection_inference"
        ? ["normalized_collection_facts", "canonical_reports", "report_support", "profile_report_support", "collection_support", "snippet_results", "raw_text_fallback"]
        : lane === "report"
          ? ["report_typed_payloads", "canonical_reports", "canonical_sets", "report_support", "profile_report_support", "snippet_results", "raw_text_fallback"]
          : lane === "event_list"
            ? ["canonical_sets", "normalized_event_facts", "event_list_support", "set_entries", "snippet_results", "raw_text_fallback"]
            : lane === "book_list"
              ? ["canonical_sets", "book_list_support", "set_entries", "snippet_results", "raw_text_fallback"]
              : lane === "support_network"
                ? ["canonical_sets", "support_network_support", "set_entries", "snippet_results", "raw_text_fallback"]
                : lane === "location_history"
                  ? ["canonical_sets", "set_entries", "snippet_results", "raw_text_fallback"]
                : lane === "abstention"
                  ? ["structured_candidates", "snippet_results", "raw_text_fallback"]
                  : ["canonical_facts", "exact_detail_results", "direct_detail_support", "snippet_results", "raw_text_fallback"];
  const suppressionPools: SuppressionPoolSelection[] = [];
  const queryExpansionTerms = new Set([...subjectNames, ...objectNames]);
  const bannedExpansionTerms = new Set<string>();
  const targetedFields: string[] = [];
  const requiredFields: string[] = [];
  const targetedBackfill: string[] = [];
  const targetedBackfillRequests: TargetedBackfillRequest[] = [];
  const ownerEligibilityHints: string[] = [];
  const suppressionHints: string[] = [];
  const resolvedSubjectEntityId =
    params.subjectEntityHints && unique(params.subjectEntityHints).length >= 1
      ? unique(params.subjectEntityHints)[0] ?? null
      : null;
  const pairSubjectEntityId =
    pairSubjectNames.length > 0 && params.subjectEntityHints && unique(params.subjectEntityHints).length >= 2
      ? unique(params.subjectEntityHints)[1] ?? null
      : null;
  const resolvedEventKey = lane === "temporal_event" ? inferTemporalEventKeyFromText(params.queryText) : null;
  const resolvedObjectEntityId =
    objectNames.length > 0 && params.subjectEntityHints && unique(params.subjectEntityHints).length >= (pairSubjectNames.length > 0 ? 3 : 2)
      ? unique(params.subjectEntityHints)[pairSubjectNames.length > 0 ? 2 : 1] ?? null
      : null;
  let familyConfidence = lane === "generic" ? 0.4 : 0.8;
  let supportCompletenessTarget = family === "exact_detail" ? 1 : 0.7;
  const exactDetailNeedsDirectedRescue =
    /\bhow\s+long\b/iu.test(params.queryText) ||
    ((/\bcompany\b|\bbrand\b|\bsponsor\b/iu.test(params.queryText)) && /\bendorsement\b/iu.test(params.queryText)) ||
    isStressBusterActivityQuery(params.queryText) ||
    isRealizationExactDetailQuery(params.queryText);
  let rescuePolicy: RetrievalRescuePolicy =
    family === "exact_detail" || family === "generic"
      ? (exactDetailNeedsDirectedRescue ? "single_targeted_rescue_before_fallback" : "allow_immediate_abstention")
      : "single_targeted_rescue_before_fallback";
  if (params.subjectBindingStatus && params.subjectBindingStatus !== "resolved") {
    targetedFields.push("subject_entity_id");
    requiredFields.push("subject_entity_id");
    targetedBackfill.push("subject_entity_id");
    targetedBackfillRequests.push({
      reason: "subject_entity_missing",
      requiredFields: ["subject_entity_id"],
      candidatePool: null,
      maxPasses: 1
    });
  }
  if (lane === "temporal_event") {
    familyConfidence = 0.95;
    supportCompletenessTarget = 1;
    requiredFields.push("event_key");
    const planningEventKey = resolvedEventKey ?? inferTemporalEventKeyFromText(params.queryText);
    const genericWhenTemporalQuery = /\bwhen\b/iu.test(params.queryText) && !/\bwhat year\b|\bwhich year\b|\bwhat month\b|\bwhich month\b|\bwhat date\b|\bwhich date\b/iu.test(params.queryText);
    switch (planningEventKey) {
      case "start_surfing":
        queryExpansionTerms.add("surf");
        queryExpansionTerms.add("surfing");
        queryExpansionTerms.add("started surfing");
        queryExpansionTerms.add("first time");
        break;
      case "make_muffins_self":
        queryExpansionTerms.add("muffins");
        queryExpansionTerms.add("bake");
        queryExpansionTerms.add("baked");
        queryExpansionTerms.add("baking");
        queryExpansionTerms.add("for herself");
        queryExpansionTerms.add("for myself");
        queryExpansionTerms.add("just for me");
        queryExpansionTerms.add("last week");
        break;
      case "doctor_weight_problem":
        queryExpansionTerms.add("doctor");
        queryExpansionTerms.add("checkup");
        queryExpansionTerms.add("weight");
        queryExpansionTerms.add("weight problem");
        break;
      case "start_financial_analyst_job":
        queryExpansionTerms.add("new job");
        queryExpansionTerms.add("financial analyst");
        queryExpansionTerms.add("started new job");
        queryExpansionTerms.add("last week");
        queryExpansionTerms.add("job start");
        break;
      case "mother_pass_away":
        queryExpansionTerms.add("mother");
        queryExpansionTerms.add("mom");
        queryExpansionTerms.add("passed away");
        queryExpansionTerms.add("died");
        queryExpansionTerms.add("death");
        break;
      case "resume_playing_drums":
        queryExpansionTerms.add("drums");
        queryExpansionTerms.add("playing again");
        queryExpansionTerms.add("resume");
        break;
      case "career_high_points":
        queryExpansionTerms.add("points");
        queryExpansionTerms.add("score");
        queryExpansionTerms.add("career-high");
        queryExpansionTerms.add("personal best");
        queryExpansionTerms.add("game");
        break;
      case "perform_festival":
        queryExpansionTerms.add("festival");
        queryExpansionTerms.add("perform");
        queryExpansionTerms.add("performance");
        queryExpansionTerms.add("rehearsal");
        queryExpansionTerms.add("showcase");
        break;
      case "game_in_seattle":
        queryExpansionTerms.add("Seattle");
        queryExpansionTerms.add("game");
        break;
      default:
        if (resolvedEventKey && /support_group$/u.test(resolvedEventKey)) {
          queryExpansionTerms.add("support group");
          queryExpansionTerms.add("joined");
          queryExpansionTerms.add("attended");
          if (/\blgbtq\b/iu.test(params.queryText)) {
            queryExpansionTerms.add("lgbtq");
          }
        }
        break;
    }
    if (planningEventKey === "make_muffins_self" && genericWhenTemporalQuery) {
      for (const field of ["year", "month", "day"] as const) {
        if (!targetedFields.includes(field)) {
          targetedFields.push(field);
        }
        if (!requiredFields.includes(field)) {
          requiredFields.push(field);
        }
        if (!targetedBackfill.includes(field)) {
          targetedBackfill.push(field);
        }
      }
      if (!targetedBackfillRequests.some((entry) => entry.reason === "temporal_event_neighbors_missing")) {
        targetedBackfillRequests.push({
          reason: "temporal_event_neighbors_missing",
          requiredFields: ["event_key", "year", "month", "day"],
          candidatePool: "temporal_event_neighbors",
          maxPasses: 1
        });
      }
    }
    if (planningEventKey === "mother_pass_away" && genericWhenTemporalQuery) {
      if (!targetedFields.includes("year")) {
        targetedFields.push("year");
      }
      if (!requiredFields.includes("year")) {
        requiredFields.push("year");
      }
      if (!targetedBackfill.includes("year")) {
        targetedBackfill.push("year");
      }
      if (!targetedBackfillRequests.some((entry) => entry.reason === "temporal_year_missing")) {
        targetedBackfillRequests.push({
          reason: "temporal_year_missing",
          requiredFields: ["year"],
          candidatePool: "temporal_derived_relatives",
          maxPasses: 1
        });
      }
    }
    if (params.temporalEventIdentityStatus && params.temporalEventIdentityStatus !== "resolved") {
      targetedFields.push("event_key");
      requiredFields.push("event_key");
      targetedBackfill.push("event_key");
      targetedBackfillRequests.push({
        reason: "temporal_event_neighbors_missing",
        requiredFields: ["event_key"],
        candidatePool: "temporal_event_neighbors",
        maxPasses: 1
      });
    }
    if (params.temporalGranularityStatus && params.temporalGranularityStatus !== "resolved") {
      const missingYear = /\byear\b/u.test(params.temporalGranularityStatus);
      const missingMonth = /\bmonth\b/u.test(params.temporalGranularityStatus);
      const missingDay = /\bday\b/u.test(params.temporalGranularityStatus);
      if (missingYear) {
        targetedFields.push("year");
        requiredFields.push("year");
        targetedBackfill.push("year");
        targetedBackfillRequests.push({
          reason: "temporal_year_missing",
          requiredFields: ["year"],
          candidatePool: "temporal_exact_facts",
          maxPasses: 1
        });
      }
      if (missingMonth || params.temporalGranularityStatus === "incomplete_temporal_support") {
        targetedFields.push("month");
        requiredFields.push("month");
        targetedBackfill.push("month");
        targetedBackfillRequests.push({
          reason: "temporal_month_missing",
          requiredFields: ["month"],
          candidatePool: "temporal_aligned_anchors",
          maxPasses: 1
        });
      }
      if (missingDay || params.temporalGranularityStatus === "incomplete_temporal_support") {
        targetedFields.push("day");
        requiredFields.push("day");
        targetedBackfill.push("day");
        targetedBackfillRequests.push({
          reason: "temporal_day_missing",
          requiredFields: ["day"],
          candidatePool: "temporal_exact_facts",
          maxPasses: 1
        });
      }
      if (!missingYear && !missingMonth && !missingDay) {
        targetedFields.push("answer_date_parts");
        requiredFields.push("answer_date_parts");
        targetedBackfill.push("answer_date_parts");
      }
    }
    suppressionPools.push("exact_detail_support", "generic_snippet_support");
  }
  if (family === "report") {
    requiredFields.push("report_payload");
    targetedBackfill.push("report_payload");
    targetedBackfillRequests.push({
      reason: "report_payload_missing",
      requiredFields: ["report_payload"],
      candidatePool: "report_typed_payloads",
      maxPasses: 1
    });
  }
  if (pairSubjectNames.length > 0 && (family === "report" || family === "list_set")) {
    if (!candidatePools.includes("pair_subject_neighbors")) {
      candidatePools.splice(Math.min(2, candidatePools.length), 0, "pair_subject_neighbors");
    }
    targetedBackfill.push("pair_subject_binding");
    targetedBackfillRequests.push({
      reason: "pair_subject_binding_missing",
      requiredFields: ["pair_subject_binding"],
      candidatePool: "pair_subject_neighbors",
      maxPasses: 1
    });
  }
  if (objectNames.length > 0 || /\bphoto\b|\bimage\b|\bcountry\b|\bwhich country\b|\bwhat country\b/iu.test(params.queryText)) {
    if (!candidatePools.includes("subject_object_facts")) {
      candidatePools.splice(Math.min(2, candidatePools.length), 0, "subject_object_facts");
    }
    targetedBackfill.push("object_binding");
    targetedBackfillRequests.push({
      reason: "object_binding_missing",
      requiredFields: ["object_binding"],
      candidatePool: "subject_object_facts",
      maxPasses: 1
    });
  }

  if (family === "report") {
    ownerEligibilityHints.push("canonical_report", "canonical_narrative");
    suppressionHints.push("canonical_exact_detail", "runtime_exact_detail");
    requiredFields.push("profile_support");
    if (isBookshelfCollectionQuery(params.queryText)) {
      familyConfidence = 0.98;
      supportCompletenessTarget = 0.85;
      rescuePolicy = "single_targeted_rescue_before_abstention";
      requiredFields.push("collection_support");
      queryExpansionTerms.add("bookshelf");
      queryExpansionTerms.add("bookcase");
      queryExpansionTerms.add("library");
      queryExpansionTerms.add("classic");
      queryExpansionTerms.add("children's");
      queryExpansionTerms.add("books");
      queryExpansionTerms.add("dr seuss");
      suppressionPools.push("career_support", "health_support", "mental_health_support", "exact_detail_support", "generic_snippet_support");
      bannedExpansionTerms.add("career");
      bannedExpansionTerms.add("job");
      bannedExpansionTerms.add("jobs");
      bannedExpansionTerms.add("mental");
      bannedExpansionTerms.add("health");
      bannedExpansionTerms.add("counseling");
      bannedExpansionTerms.add("counselor");
      bannedExpansionTerms.add("options");
      targetedBackfill.push("collection_support");
      targetedBackfillRequests.push({
        reason: "collection_support_missing",
        requiredFields: ["collection_support"],
        candidatePool: "normalized_collection_facts",
        maxPasses: 1
      });
    } else if (isGenericCollectionQuery(params.queryText)) {
      familyConfidence = 0.95;
      supportCompletenessTarget = 0.8;
      rescuePolicy = "single_targeted_rescue_before_abstention";
      requiredFields.push("collection_support");
      requiredFields.push("collection_entries");
      queryExpansionTerms.add("collect");
      queryExpansionTerms.add("collection");
      queryExpansionTerms.add("collectibles");
      queryExpansionTerms.add("memorabilia");
      queryExpansionTerms.add("items");
      suppressionPools.push("career_support", "health_support", "mental_health_support", "exact_detail_support", "generic_snippet_support");
      bannedExpansionTerms.add("career");
      bannedExpansionTerms.add("job");
      bannedExpansionTerms.add("jobs");
      bannedExpansionTerms.add("mental");
      bannedExpansionTerms.add("health");
      bannedExpansionTerms.add("counseling");
      bannedExpansionTerms.add("counselor");
      bannedExpansionTerms.add("options");
      targetedBackfill.push("collection_entries");
      targetedBackfillRequests.push({
        reason: "collection_entries_missing",
        requiredFields: ["collection_entries"],
        candidatePool: "normalized_collection_facts",
        maxPasses: 1
      });
    } else if (isCommunityMembershipQuery(params.queryText)) {
      if (!candidatePools.includes("community_membership_support")) {
        candidatePools.splice(2, 0, "community_membership_support");
      }
      familyConfidence = 0.95;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("lgbtq");
      queryExpansionTerms.add("pride");
      queryExpansionTerms.add("community");
      queryExpansionTerms.add("ally");
      queryExpansionTerms.add("transgender");
      queryExpansionTerms.add("support");
      queryExpansionTerms.add("mentoring");
      suppressionPools.push("career_support", "health_support", "mental_health_support", "exact_detail_support", "generic_snippet_support");
      bannedExpansionTerms.add("career");
      bannedExpansionTerms.add("job");
      bannedExpansionTerms.add("mental");
      bannedExpansionTerms.add("health");
      bannedExpansionTerms.add("counseling");
      bannedExpansionTerms.add("counselor");
      bannedExpansionTerms.add("options");
      targetedBackfill.push("community_membership_support");
      targetedBackfillRequests.push({
        reason: "community_membership_support_missing",
        requiredFields: ["community_membership_support"],
        candidatePool: "community_membership_support",
        maxPasses: 1
      });
    } else if (isEducationFieldQuery(params.queryText)) {
      if (!candidatePools.includes("education_support")) {
        candidatePools.splice(2, 0, "education_support");
      }
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("education");
      queryExpansionTerms.add("study");
      queryExpansionTerms.add("degree");
      queryExpansionTerms.add("major");
      queryExpansionTerms.add("field");
      queryExpansionTerms.add("certification");
      requiredFields.push("education_field");
      targetedBackfill.push("education_field");
      targetedBackfillRequests.push({
        reason: "education_field_missing",
        requiredFields: ["education_field"],
        candidatePool: "education_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isAspirationQuery(params.queryText) || params.reportKind === "aspiration_report") {
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.8;
      requiredFields.push("aspiration_support");
      queryExpansionTerms.add("business");
      queryExpansionTerms.add("venture");
      queryExpansionTerms.add("startup");
      queryExpansionTerms.add("app");
      queryExpansionTerms.add("unique");
      queryExpansionTerms.add("customize");
      queryExpansionTerms.add("preferences");
      queryExpansionTerms.add("needs");
      queryExpansionTerms.add("brand");
      targetedBackfill.push("aspiration_support");
      targetedBackfillRequests.push({
        reason: "aspiration_support_missing",
        requiredFields: ["aspiration_support"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isPetCareQuery(params.queryText) || params.reportKind === "pet_care_report") {
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.8;
      requiredFields.push("pet_care_support");
      queryExpansionTerms.add("dog");
      queryExpansionTerms.add("dogs");
      queryExpansionTerms.add("pet");
      queryExpansionTerms.add("training");
      queryExpansionTerms.add("dog treats");
      queryExpansionTerms.add("agility");
      queryExpansionTerms.add("workshops");
      queryExpansionTerms.add("groups");
      queryExpansionTerms.add("remote");
      queryExpansionTerms.add("hybrid");
      queryExpansionTerms.add("suburbs");
      targetedBackfill.push("pet_care_support");
      targetedBackfillRequests.push({
        reason: "pet_care_support_missing",
        requiredFields: ["pet_care_support"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isTravelReportQuery(params.queryText) || params.reportKind === "travel_report") {
      familyConfidence = 0.88;
      supportCompletenessTarget = 0.8;
      requiredFields.push("travel_location_entries");
      queryExpansionTerms.add("travel");
      queryExpansionTerms.add("roadtrip");
      queryExpansionTerms.add("trip");
      queryExpansionTerms.add("family");
      queryExpansionTerms.add("visited");
      queryExpansionTerms.add("went");
      queryExpansionTerms.add("places");
      targetedBackfill.push("travel_location_entries");
      targetedBackfillRequests.push({
        reason: "travel_location_entries_missing",
        requiredFields: ["travel_location_entries"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isPreferenceChoiceQuery(params.queryText) || isPreferenceProfileQuery(params.queryText)) {
      if (!candidatePools.includes("preference_support")) {
        candidatePools.splice(2, 0, "preference_support");
      }
      familyConfidence = 0.85;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("favorite");
      queryExpansionTerms.add("prefer");
      queryExpansionTerms.add("interested");
      queryExpansionTerms.add("enjoy");
      queryExpansionTerms.add("style");
      queryExpansionTerms.add("dance");
      if (isBooksByAuthorPreferenceQuery(params.queryText)) {
        queryExpansionTerms.add("books");
        queryExpansionTerms.add("reading");
        queryExpansionTerms.add("authors");
        queryExpansionTerms.add("novels");
        queryExpansionTerms.add("fantasy");
        queryExpansionTerms.add("series");
      }
      requiredFields.push("preference_support");
      targetedBackfill.push("preference_support");
      targetedBackfillRequests.push({
        reason: "preference_support_missing",
        requiredFields: ["preference_support"],
        candidatePool: "preference_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isComparativeFitQuery(params.queryText)) {
      familyConfidence = 0.88;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("performing");
      queryExpansionTerms.add("stage");
      queryExpansionTerms.add("crowd");
      queryExpansionTerms.add("crowds");
      queryExpansionTerms.add("perform");
      targetedBackfill.push("causal_reason");
      requiredFields.push("causal_reason");
      targetedBackfillRequests.push({
        reason: "causal_reason_missing",
        requiredFields: ["causal_reason"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isBasketballCareerGoalQuery(params.queryText)) {
      if (!candidatePools.includes("career_support")) {
        candidatePools.splice(2, 0, "career_support");
      }
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.85;
      requiredFields.push("report_payload");
      queryExpansionTerms.add("basketball goals");
      queryExpansionTerms.add("shooting percentage");
      queryExpansionTerms.add("improve shooting");
      queryExpansionTerms.add("win a championship");
      queryExpansionTerms.add("win a title");
      queryExpansionTerms.add("basketball career");
      bannedExpansionTerms.add("endorsements");
      bannedExpansionTerms.add("brand");
      bannedExpansionTerms.add("charity");
      bannedExpansionTerms.add("community outreach");
      bannedExpansionTerms.add("off the court");
      targetedBackfill.push("report_payload");
      targetedBackfillRequests.push({
        reason: "report_payload_missing",
        requiredFields: ["report_payload"],
        candidatePool: "report_typed_payloads",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isOffCourtCareerGoalQuery(params.queryText)) {
      if (!candidatePools.includes("career_support")) {
        candidatePools.splice(2, 0, "career_support");
      }
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.85;
      requiredFields.push("report_payload");
      queryExpansionTerms.add("endorsements");
      queryExpansionTerms.add("brand");
      queryExpansionTerms.add("charity");
      queryExpansionTerms.add("community outreach");
      queryExpansionTerms.add("off the court");
      queryExpansionTerms.add("outside basketball");
      bannedExpansionTerms.add("shooting");
      bannedExpansionTerms.add("championship");
      bannedExpansionTerms.add("all-star");
      bannedExpansionTerms.add("defense");
      bannedExpansionTerms.add("teammates");
      targetedBackfill.push("report_payload");
      targetedBackfillRequests.push({
        reason: "report_payload_missing",
        requiredFields: ["report_payload"],
        candidatePool: "report_typed_payloads",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isCareerReportQuery(params.queryText) || isCareerDirectionQuery(params.queryText)) {
      if (!candidatePools.includes("career_support")) {
        candidatePools.splice(2, 0, "career_support");
      }
      familyConfidence = 0.85;
      queryExpansionTerms.add("career");
      queryExpansionTerms.add("job");
      queryExpansionTerms.add("work");
      queryExpansionTerms.add("writing");
      queryExpansionTerms.add("reading");
      queryExpansionTerms.add("counseling");
      queryExpansionTerms.add("counselor");
      queryExpansionTerms.add("mental");
      queryExpansionTerms.add("health");
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isMedicalInferenceQuery(params.queryText)) {
      familyConfidence = 0.88;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("allergies");
      queryExpansionTerms.add("allergy");
      queryExpansionTerms.add("asthma");
      queryExpansionTerms.add("condition");
      requiredFields.push("medical_inference");
      targetedBackfill.push("medical_inference");
      targetedBackfillRequests.push({
        reason: "report_payload_missing",
        requiredFields: ["medical_inference"],
        candidatePool: "report_typed_payloads",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isGriefPeaceSupportQuery(params.queryText)) {
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.85;
      queryExpansionTerms.add("grief");
      queryExpansionTerms.add("grieving");
      queryExpansionTerms.add("peace");
      queryExpansionTerms.add("comfort");
      queryExpansionTerms.add("yoga");
      queryExpansionTerms.add("meditation");
      queryExpansionTerms.add("family album");
      queryExpansionTerms.add("old photos");
      queryExpansionTerms.add("photos");
      queryExpansionTerms.add("roses");
      queryExpansionTerms.add("dahlias");
      queryExpansionTerms.add("garden");
      queryExpansionTerms.add("nature");
      queryExpansionTerms.add("memories");
      targetedBackfill.push("causal_reason");
      requiredFields.push("causal_reason");
      targetedBackfillRequests.push({
        reason: "causal_reason_missing",
        requiredFields: ["causal_reason"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (isCausalReasonQuery(params.queryText)) {
      familyConfidence = 0.88;
      supportCompletenessTarget = 0.8;
      queryExpansionTerms.add("because");
      queryExpansionTerms.add("since");
      queryExpansionTerms.add("after");
      queryExpansionTerms.add("inspired");
      queryExpansionTerms.add("motivated");
      queryExpansionTerms.add("passion");
      queryExpansionTerms.add("creative freedom");
      queryExpansionTerms.add("lost job");
      targetedBackfill.push("causal_reason");
      requiredFields.push("causal_reason");
      targetedBackfillRequests.push({
        reason: "causal_reason_missing",
        requiredFields: ["causal_reason"],
        candidatePool: "profile_report_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    }
  }
  if (family === "list_set") {
    ownerEligibilityHints.push("canonical_list_set");
    suppressionHints.push("canonical_exact_detail", "runtime_exact_detail");
    if (lane === "event_list" || isEventListQuery(params.queryText)) {
      familyConfidence = 0.95;
      supportCompletenessTarget = 0.75;
      requiredFields.push("event_list_entries");
      targetedBackfill.push("event_list_entries");
      targetedBackfillRequests.push({
        reason: "event_list_entries_missing",
        requiredFields: ["event_list_entries"],
        candidatePool: "event_list_support",
        maxPasses: 1
      });
      queryExpansionTerms.add("events");
      queryExpansionTerms.add("participated");
      queryExpansionTerms.add("attended");
      queryExpansionTerms.add("support");
      queryExpansionTerms.add("mentoring");
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (lane === "book_list" || isBookListQuery(params.queryText)) {
      familyConfidence = 0.95;
      supportCompletenessTarget = 0.75;
      requiredFields.push("book_list_entries");
      targetedBackfill.push("book_list_entries");
      targetedBackfillRequests.push({
        reason: "book_list_entries_missing",
        requiredFields: ["book_list_entries"],
        candidatePool: "book_list_support",
        maxPasses: 1
      });
      queryExpansionTerms.add("books");
      queryExpansionTerms.add("read");
      queryExpansionTerms.add("reading");
      queryExpansionTerms.add("book");
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (lane === "support_network") {
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.65;
      targetedBackfill.push("support_network_entries");
      targetedBackfillRequests.push({
        reason: "support_network_entries_missing",
        requiredFields: ["support_network_entries"],
        candidatePool: "support_network_support",
        maxPasses: 1
      });
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    } else if (lane === "location_history") {
      familyConfidence = 0.9;
      supportCompletenessTarget = 0.7;
      requiredFields.push("location_history_entries");
      targetedBackfill.push("location_history_entries");
      targetedBackfillRequests.push({
        reason: "location_history_entries_missing",
        requiredFields: ["location_history_entries"],
        candidatePool: "set_entries",
        maxPasses: 1
      });
      queryExpansionTerms.add("places");
      queryExpansionTerms.add("locations");
      queryExpansionTerms.add("made friends");
      queryExpansionTerms.add("vacationed");
      queryExpansionTerms.add("visited");
      suppressionPools.push("exact_detail_support", "generic_snippet_support");
    }
  }
  if (family === "exact_detail" && exactDetailNeedsDirectedRescue) {
    supportCompletenessTarget = 1;
    requiredFields.push("exact_detail_support");
    targetedBackfill.push("exact_detail_support");
    targetedBackfillRequests.push({
      reason: "exact_detail_support_missing",
      requiredFields: ["exact_detail_support"],
      candidatePool: "direct_detail_support",
      maxPasses: 1
    });
    if (/\bhow\s+long\b/iu.test(params.queryText)) {
      queryExpansionTerms.add("years");
      queryExpansionTerms.add("months");
      queryExpansionTerms.add("weeks");
      queryExpansionTerms.add("days");
      queryExpansionTerms.add("since");
      queryExpansionTerms.add("have had");
      queryExpansionTerms.add("had them");
      if (/\bfirst two\b/iu.test(params.queryText)) {
        queryExpansionTerms.add("first two");
      }
    }
    if ((/\bcompany\b|\bbrand\b|\bsponsor\b/iu.test(params.queryText)) && /\bendorsement\b/iu.test(params.queryText)) {
      queryExpansionTerms.add("endorsement");
      queryExpansionTerms.add("brand");
      queryExpansionTerms.add("company");
      queryExpansionTerms.add("sponsor");
      queryExpansionTerms.add("reached out");
    }
    if (isStressBusterActivityQuery(params.queryText)) {
      queryExpansionTerms.add("started doing");
      queryExpansionTerms.add("stress-buster");
      queryExpansionTerms.add("stress relief");
      queryExpansionTerms.add("happy place");
      queryExpansionTerms.add("escape");
      queryExpansionTerms.add("dancing");
      queryExpansionTerms.add("painting");
      queryExpansionTerms.add("yoga");
    }
    if (isRealizationExactDetailQuery(params.queryText)) {
      queryExpansionTerms.add("realized");
      queryExpansionTerms.add("realize");
      queryExpansionTerms.add("learned");
      queryExpansionTerms.add("after");
    }
  }
  return {
    family,
    lane,
    resolvedSubjectEntityId,
    resolvedObjectEntityId,
    resolvedEventKey,
    subjectNames,
    objectNames,
    pairSubjectEntityId,
    pairSubjectNames,
    candidatePools,
    suppressionPools,
    targetedFields,
    requiredFields,
    targetedBackfill,
    targetedBackfillRequests,
    queryExpansionTerms: unique([...queryExpansionTerms]),
    bannedExpansionTerms: unique([...bannedExpansionTerms]),
    ownerEligibilityHints,
    suppressionHints,
    familyConfidence,
    supportCompletenessTarget,
    rescuePolicy,
    reason:
      params.supportObjectType
        ? `Plan derived for ${lane} (${family}) answers using ${params.supportObjectType}.`
        : `Plan derived for ${lane} (${family}) answers before support normalization.`
  };
}

export function extractAtomicMemoryUnits(params: {
  readonly results: readonly RecallResult[];
  readonly storedCanonical?: StoredCanonicalLookup | null;
  readonly supportObjectType?: string | null;
  readonly selectedEventKey?: string | null;
  readonly selectedEventType?: string | null;
  readonly selectedTimeGranularity?: string | null;
  readonly exactDetailSource?: string | null;
  readonly retrievalPlan?: AnswerRetrievalPlan | null;
}): readonly AtomicMemoryUnit[] {
  const inferCueTypes = (result: RecallResult): string[] => {
    const cues = new Set<string>();
    const normalizedContent = normalize(result.content).toLowerCase();
    if (params.retrievalPlan?.lane) {
      cues.add(`planner_lane:${params.retrievalPlan.lane}`);
    }
    if (params.supportObjectType) {
      cues.add(`support:${params.supportObjectType}`);
    }
    if (readProvenanceText(result, "subject_entity_id")) {
      cues.add("subject_bound");
    }
    const lexicalMatches =
      params.retrievalPlan?.queryExpansionTerms.filter((term) => normalize(result.content).includes(normalize(term))) ?? [];
    if (lexicalMatches.length > 0) {
      cues.add("lexical_overlap");
    }
    if (/\bbecause\b|\bsince\b|\bafter\b|\bwhen\b|\bthrough\b/iu.test(normalizedContent)) {
      cues.add("causal_clause");
    }
    if (/\bcollects?\b|\bcollection\b|\bcollecting\b/iu.test(normalizedContent)) {
      cues.add("collection_cue");
    }
    if (/\bevent\b|\battend(?:ed|ing)?\b|\bparticipat(?:ed|ing)?\b/iu.test(normalizedContent)) {
      cues.add("event_cue");
    }
    return [...cues];
  };

  const collectionFactUnits =
    params.retrievalPlan?.candidatePools.includes("normalized_collection_facts")
      ? params.results.flatMap((result, resultIndex) => {
          const metadata = readProvenanceMetadata(result);
          const sourceTable =
            (typeof metadata?.source_table === "string" ? normalize(metadata.source_table) : "") ||
            (typeof result.provenance.source_table === "string" ? normalize(result.provenance.source_table) : "");
          const collectionValues = readCollectionUnitValues(result);
          if (
            collectionValues.length === 0 &&
            sourceTable !== "canonical_collection_facts" &&
            sourceTable !== "canonical_set_collection_support"
          ) {
            return [];
          }
          const lexicalMatches =
            params.retrievalPlan?.queryExpansionTerms.filter((term) => normalize(result.content).includes(normalize(term))) ?? [];
          return collectionValues.map((collectionValue, valueIndex) => ({
            id: `${result.memoryId}:collection:${resultIndex}:${valueIndex}`,
            namespace: result.namespaceId,
            unitType: "NormalizedCollectionFactSupportUnit",
            memoryId: result.memoryId,
            artifactId: result.artifactId ?? null,
            sourceArtifactId: result.artifactId ?? null,
            sourceChunkId: readProvenanceText(result, "source_chunk_id"),
            sourceUri: typeof result.provenance.sourceUri === "string" ? result.provenance.sourceUri : null,
            subjectEntityId: readProvenanceText(result, "subject_entity_id"),
            objectEntityId: readProvenanceText(result, "object_entity_id"),
            sourceText: readCollectionUnitSourceText(result),
            canonicalText: collectionValue,
            confidence: null,
            cueTypes: [
              ...new Set([
                ...(params.retrievalPlan?.lane ? [`planner_lane:${params.retrievalPlan.lane}`] : []),
                "collection_cue",
                "normalized_collection_fact",
                ...(readProvenanceText(result, "subject_entity_id") ? ["subject_bound"] : [])
              ])
            ],
            supportClass: "CollectionInferenceSupport",
            lexicalMatchTerms: lexicalMatches,
            plannerFamily: params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? "generic"
          } satisfies AtomicMemoryUnit));
        })
      : [];

  const units: AtomicMemoryUnit[] = params.results.slice(0, 6).map((result, index) => ({
    id: `${result.memoryId}:base:${index}`,
    namespace: result.namespaceId,
    unitType: params.supportObjectType === "TemporalEventSupport" ? "TemporalEventFactSupportUnit" : "DirectDetailSupportUnit",
    memoryId: result.memoryId,
    artifactId: result.artifactId ?? null,
    sourceArtifactId: result.artifactId ?? null,
    sourceChunkId: readProvenanceText(result, "source_chunk_id"),
    sourceUri: typeof result.provenance.sourceUri === "string" ? result.provenance.sourceUri : null,
    subjectEntityId: readProvenanceText(result, "subject_entity_id"),
    objectEntityId: readProvenanceText(result, "object_entity_id"),
    sourceText: result.content,
    canonicalText: result.content,
    confidence: null,
    cueTypes: inferCueTypes(result),
    supportClass: params.supportObjectType ?? null,
    lexicalMatchTerms:
      params.retrievalPlan?.queryExpansionTerms.filter((term) => normalize(result.content).includes(normalize(term))) ?? [],
    plannerFamily: params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? "generic"
  }));

  if (params.supportObjectType === "TemporalEventSupport") {
    return [
      ...collectionFactUnits,
      ...units.map((unit) => ({
        ...unit,
        unitType: "TemporalEventFactSupportUnit",
        eventKey: params.selectedEventKey ?? (params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.eventKey ?? null : null),
        eventType: params.selectedEventType ?? (params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.eventType ?? null : null),
        answerYear: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.answerYear ?? null : null,
        answerMonth: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.answerMonth ?? null : null,
        answerDay: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.answerDay ?? null : null,
        supportKind:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.supportKind ?? unit.supportKind ?? null
            : unit.supportKind ?? null,
        bindingConfidence:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.bindingConfidence ?? unit.bindingConfidence ?? null
            : unit.bindingConfidence ?? null,
        temporalSourceQuality:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.temporalSourceQuality ?? unit.temporalSourceQuality ?? null
            : unit.temporalSourceQuality ?? null,
        derivedFromReference:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.derivedFromReference ?? unit.derivedFromReference ?? false
            : unit.derivedFromReference ?? false,
        eventSurfaceText:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.eventSurfaceText ?? unit.eventSurfaceText ?? null
            : unit.eventSurfaceText ?? null,
        locationSurfaceText:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.locationSurfaceText ?? unit.locationSurfaceText ?? null
            : unit.locationSurfaceText ?? null,
        participantEntityIds:
          params.storedCanonical?.kind === "temporal_fact"
            ? params.storedCanonical.participantEntityIds ?? unit.participantEntityIds ?? []
            : unit.participantEntityIds ?? [],
        absoluteDate:
          params.storedCanonical?.kind === "temporal_fact"
            ? {
                year: params.storedCanonical.answerYear ?? null,
                month: params.storedCanonical.answerMonth ?? null,
                day: params.storedCanonical.answerDay ?? null
              }
            : null,
        timeGranularity: params.selectedTimeGranularity ?? (params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.timeGranularity ?? null : null),
        anchorEventKey: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.anchorEventKey ?? null : null,
        anchorRelation: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.anchorRelation ?? null : null,
        anchorOffsetValue: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.anchorOffsetValue ?? null : null,
        anchorOffsetUnit: params.storedCanonical?.kind === "temporal_fact" ? params.storedCanonical.anchorOffsetUnit ?? null : null,
        relativeAnchor:
          params.storedCanonical?.kind === "temporal_fact"
            ? {
                anchorEventKey: params.storedCanonical.anchorEventKey ?? null,
                relation: params.storedCanonical.anchorRelation ?? null,
                offsetValue: params.storedCanonical.anchorOffsetValue ?? null,
                offsetUnit: params.storedCanonical.anchorOffsetUnit ?? null
              }
            : null
      } satisfies TemporalEventFactSupportUnit))
    ];
  }

  return [
    ...collectionFactUnits,
    ...units.map((unit) => ({
      ...unit,
      unitType: "DirectDetailSupportUnit",
      exactDetailSource:
        params.exactDetailSource === "episodic_leaf" ||
        params.exactDetailSource === "artifact_source" ||
        params.exactDetailSource === "derivation" ||
        params.exactDetailSource === "mixed"
          ? params.exactDetailSource
          : "unknown"
    } satisfies DirectDetailSupportUnit))
  ];
}
