import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";
import { isConcreteConsumablePreferenceQuery } from "./query-signals.js";
import type {
  AnswerOwnerCandidateTrace,
  AnswerOwnerFamily,
  AnswerOwnerName,
  AnswerRetrievalPlan,
  AnswerOwnerTrace,
  CanonicalAdjudicationResult,
  ExactDetailClaimCandidate,
  RetrievalPlanLane
} from "./types.js";
import type { RecallResult } from "../types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasExplicitSubject(queryText: string): boolean {
  return (
    extractPossessiveQuerySurfaceNames(queryText).length > 0 ||
    extractPrimaryQuerySurfaceNames(queryText).length > 0 ||
    extractPairQuerySurfaceNames(queryText).length > 0 ||
    extractQuerySurfaceNames(queryText).length > 0
  );
}

function isTemporalFamilyQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return (
    /^\s*when\b/u.test(normalized) ||
    /\bwhat\s+year\b/u.test(normalized) ||
    /\b(which|what)\s+month\b/u.test(normalized) ||
    /\bwhich\s+year\b/u.test(normalized) ||
    (!/\bwhy\b/u.test(normalized) && /\b(start|started|join|joined|launch|launched|begin|began|first)\b/u.test(normalized))
  );
}

function isListSetFamilyQuery(queryText: string, exactDetailFamily: string): boolean {
  const normalized = normalize(queryText);
  if (/\bfavorite\s+book\s+series\b/u.test(normalized) && /\babout\b/u.test(normalized)) {
    return false;
  }
  return (
    ["social_exclusion", "hobbies", "shop", "country", "symbolic_gifts", "bands", "favorite_band", "favorite_dj", "favorite_books"].includes(exactDetailFamily) ||
    /\bfavorite books?\b/u.test(normalized) ||
    /\bwhere\b[^?!.]{0,80}\b(?:made friends|vacationed|travel(?:ed|ing)?|visited|went)\b/u.test(normalized) ||
    /\bwhat\s+(?:states|areas|places)\b/u.test(normalized) ||
    /\bwhat do\b.*\bboth\b/u.test(normalized) ||
    /\bwhich country\b/u.test(normalized) ||
    /\bcommon\b|\bshare\b|\bmeet at\b|\bplanned to meet\b|\bplaces or events\b|\bgifts?\b/u.test(normalized)
  );
}

function isReportFamilyQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return (
    /\bwhy\b/u.test(normalized) ||
    /\bhow does\b[^?!.]{0,80}\bplan to\b/u.test(normalized) ||
    /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/u.test(normalized) ||
    /\brealiz(?:e|ed|ing)\b|\bideal\b|\bfavorite\b|\bprefer\b|\bstyle\b|\bwould\b|\blikely\b|\bbookshelf\b|\bcollect\b|\bdegree\b|\bfield\b|\beducation\b|\bdream\b|\bgoals?\b|\bfinancial status\b/u.test(normalized)
  );
}

function isPreferenceProfileQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  if (/\bfavorite style of painting\b/u.test(normalized)) {
    return false;
  }
  if (isConcreteConsumablePreferenceQuery(queryText.trim())) {
    return false;
  }
  return (
    /\bfavorite\b.*\bstyle\b/u.test(normalized) ||
    /\bfavorite\b.*\bdance\b/u.test(normalized) ||
    /\bfavorite\b.*\bmemory\b/u.test(normalized) ||
    /\bwhat is\b[^?!.]{0,80}\bfavorite style of dance\b/u.test(normalized) ||
    /\bwhat was\b[^?!.]{0,80}\bfavorite dancing memory\b/u.test(normalized)
  );
}

function isConcreteExactDetailQuery(queryText: string, exactDetailFamily: string): boolean {
  const normalized = normalize(queryText);
  if (/\bfavorite style of painting\b/u.test(normalized)) {
    return true;
  }
  if (isConcreteConsumablePreferenceQuery(queryText.trim())) {
    return true;
  }
  if (
    (/\bhow\s+long\b/u.test(normalized) && /\b(?:have|has|had)\b/u.test(normalized)) ||
    (((/\bcompany\b|\bbrand\b|\bsponsor\b/u.test(normalized)) && /\bendorsement\b/u.test(normalized))) ||
    (
      /^\s*what did\b/u.test(normalized) &&
      /\bstart(?:ed|ing)?\s+doing\b/u.test(normalized) &&
      /\b(stress|stress-buster|stress relief|happy place|escape)\b/u.test(normalized)
    )
  ) {
    return true;
  }
  if (
    isTemporalFamilyQuery(queryText) ||
    /\bwhat\s+books?\b/u.test(normalized) ||
    /\bbooks?\b[^?!.]{0,40}\bread\b/u.test(normalized) ||
    /\bwhat\s+(?:[a-z0-9+&'’ -]+\s+)?events?\b/u.test(normalized) ||
    /\bwho\s+supports?\b/u.test(normalized) ||
    /\bsupport network\b/u.test(normalized) ||
    isListSetFamilyQuery(queryText, exactDetailFamily) ||
    /\bwhy\b/u.test(normalized) ||
    /\bwould\b/u.test(normalized) ||
    /\blikely\b/u.test(normalized) ||
    /\brealiz(?:e|ed|ing)\b/u.test(normalized) ||
    /\bgoals?\b/u.test(normalized) ||
    /\bdreams?\b/u.test(normalized) ||
    /\bplans?\b/u.test(normalized) ||
    /\bfinancial status\b/u.test(normalized) ||
    /\bidentity\b/u.test(normalized) ||
    /\brelationship status\b/u.test(normalized) ||
    /\bmember of\b/u.test(normalized) ||
    /\bally\b/u.test(normalized) ||
    /\bcollect(?:ion|s)?\b/u.test(normalized) ||
    /\bbookshelf\b/u.test(normalized) ||
    /\bcareer\b/u.test(normalized) ||
    /\bdegree\b/u.test(normalized) ||
    /\bfield\b/u.test(normalized) ||
    isPreferenceProfileQuery(queryText) ||
    /\badvice\b/u.test(normalized) ||
    /\bhow does\b[^?!.]{0,80}\bplan to\b/u.test(normalized) ||
    /\bwhat can\b[^?!.]{0,80}\bpotentially do\b/u.test(normalized)
  ) {
    return false;
  }
  if (exactDetailFamily !== "generic" && !["social_exclusion", "hobbies", "shop", "country", "symbolic_gifts", "bands", "favorite_band", "favorite_dj"].includes(exactDetailFamily)) {
    return true;
  }
  return (
    /^\s*(what|which|who|where)\b/u.test(normalized) &&
    (
      /^\s*what did\b(?!.*\brealiz)/u.test(normalized) ||
      /\b(kind|type|color|colors|name|names|country|city|movie|movies|book|books|series|trilogy|band|bands|dj|game|games|pet|pets|item|items|flower|flowers|bird|birds|car|cars|hobbies|pastry|pastries)\b/u.test(normalized) ||
      /\bfavorite\s+(movie|movies|book|books|series|trilogy|band|dj|game|games)\b/u.test(normalized)
    )
  );
}

function retrievalLaneToOwnerFamily(lane: RetrievalPlanLane | AnswerOwnerFamily | "generic" | null | undefined): AnswerOwnerFamily | "generic" {
  switch (lane) {
    case "collection_inference":
    case "report":
      return "report";
    case "temporal_event":
    case "temporal":
      return "temporal";
    case "event_list":
    case "book_list":
    case "support_network":
    case "location_history":
    case "list_set":
      return "list_set";
    case "exact_detail":
      return "exact_detail";
    case "abstention":
      return "abstention";
    default:
      return "generic";
  }
}

function typedSupportFamily(candidate: CanonicalAdjudicationResult | null): AnswerOwnerFamily | null {
  const shapingTrace = candidate?.formatted.shapingTrace;
  if (!shapingTrace?.shapingPipelineEntered) {
    return null;
  }
  if (shapingTrace.supportObjectType === "DirectDetailSupport") {
    return "exact_detail";
  }
  if (shapingTrace.supportObjectType === "TemporalEventSupport" || shapingTrace.selectedFamily === "temporal") {
    return "temporal";
  }
  if (shapingTrace.supportObjectType === "ListSetSupport" || shapingTrace.selectedFamily === "list_set") {
    return "list_set";
  }
  if (
    shapingTrace.supportObjectType === "CollectionSetSupport" ||
    shapingTrace.supportObjectType === "CollectionInferenceSupport" ||
    shapingTrace.supportObjectType === "ProfileInferenceSupport" ||
    shapingTrace.supportObjectType === "PreferenceChoiceSupport" ||
    shapingTrace.supportObjectType === "CounterfactualCareerSupport" ||
    shapingTrace.selectedFamily === "report"
  ) {
    return "report";
  }
  return null;
}

function plannerFamily(candidate: CanonicalAdjudicationResult | null): AnswerOwnerFamily | "generic" {
  return retrievalLaneToOwnerFamily(
    candidate?.formatted.shapingTrace?.retrievalPlanLane ??
      candidate?.formatted.shapingTrace?.retrievalPlanFamily ??
      null
  );
}

function plannerSuppressesExactDetail(
  candidate: CanonicalAdjudicationResult | null,
  runtimePlan?: AnswerRetrievalPlan | null
): boolean {
  const shapingTrace = candidate?.formatted.shapingTrace;
  if (!shapingTrace) {
    return (
      runtimePlan?.suppressionHints?.includes("canonical_exact_detail") === true ||
      runtimePlan?.suppressionHints?.includes("runtime_exact_detail") === true ||
      runtimePlan?.suppressionPools?.includes("exact_detail_support") === true
    );
  }
  return (
    shapingTrace.suppressionHints?.includes("canonical_exact_detail") === true ||
    shapingTrace.suppressionHints?.includes("runtime_exact_detail") === true ||
    shapingTrace.retrievalPlanSuppressionPools?.includes("exact_detail_support") === true ||
    runtimePlan?.suppressionHints?.includes("canonical_exact_detail") === true ||
    runtimePlan?.suppressionHints?.includes("runtime_exact_detail") === true ||
    runtimePlan?.suppressionPools?.includes("exact_detail_support") === true
  );
}

function plannerHasIncompleteTypedLane(runtimePlan?: AnswerRetrievalPlan | null): boolean {
  if (!runtimePlan) {
    return false;
  }
  const family = retrievalLaneToOwnerFamily(runtimePlan.lane ?? runtimePlan.family ?? null);
  if (!["report", "temporal", "list_set"].includes(family)) {
    return false;
  }
  return (
    (runtimePlan.requiredFields?.length ?? 0) > 0 ||
    (runtimePlan.targetedBackfill?.length ?? 0) > 0 ||
    (runtimePlan.targetedBackfillRequests?.length ?? 0) > 0
  );
}

function classifyOwnerFamily(params: {
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly retrievalPlan?: AnswerRetrievalPlan | null;
  readonly narrativeCandidate: CanonicalAdjudicationResult | null;
  readonly canonicalAdjudication: CanonicalAdjudicationResult | null;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}): AnswerOwnerFamily {
  const canonicalKind = params.canonicalAdjudication?.canonical.kind ?? null;
  const canonicalPredicateFamily = params.canonicalAdjudication?.bundle.predicateFamily ?? null;
  const canonicalFinalClaimSource = params.canonicalAdjudication?.formatted.finalClaimSource ?? null;
  const plannerFamilyHint =
    retrievalLaneToOwnerFamily(params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? null) !== "generic"
      ? retrievalLaneToOwnerFamily(params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? null)
      : plannerFamily(params.canonicalAdjudication) !== "generic"
        ? plannerFamily(params.canonicalAdjudication)
        : plannerFamily(params.narrativeCandidate);
  const exactDetailLike = isConcreteExactDetailQuery(params.queryText, params.exactDetailFamily);
  const typedFamily = typedSupportFamily(params.canonicalAdjudication);
  if (
    (plannerFamilyHint === "exact_detail" || exactDetailLike) &&
    (params.exactDetailCandidate || canonicalKind === "fact" || canonicalPredicateFamily === "generic_fact" || canonicalFinalClaimSource === "canonical_exact_detail")
  ) {
    return "exact_detail";
  }
  if (
    plannerFamilyHint &&
    plannerFamilyHint !== "generic" &&
    plannerFamilyHint !== "exact_detail" &&
    (!typedFamily || typedFamily === plannerFamilyHint || typedFamily !== "exact_detail")
  ) {
    return plannerFamilyHint;
  }
  if (typedFamily && typedFamily !== "exact_detail") {
    return typedFamily;
  }
  if (canonicalFinalClaimSource === "canonical_temporal") {
    return "temporal";
  }
  if (canonicalFinalClaimSource === "canonical_profile" || canonicalFinalClaimSource === "canonical_counterfactual") {
    return "report";
  }
  if (canonicalFinalClaimSource === "canonical_list_set" || canonicalFinalClaimSource === "canonical_commonality") {
    return "list_set";
  }
  if (canonicalPredicateFamily === "profile_state" || canonicalPredicateFamily === "relationship_state" || canonicalPredicateFamily === "counterfactual") {
    return "report";
  }
  if (canonicalPredicateFamily === "list_set" || canonicalPredicateFamily === "commonality" || canonicalPredicateFamily === "location_history") {
    return "list_set";
  }
  if (canonicalKind === "temporal_fact" || isTemporalFamilyQuery(params.queryText)) {
    return "temporal";
  }
  const narrativeKind = params.narrativeCandidate?.canonical.kind ?? null;
  if (narrativeKind === "report" || narrativeKind === "narrative") {
    return "report";
  }
  if (isReportFamilyQuery(params.queryText)) {
    return "report";
  }
  if (canonicalKind === "set" || isListSetFamilyQuery(params.queryText, params.exactDetailFamily)) {
    return "list_set";
  }
  if (canonicalKind === "abstention") {
    return "abstention";
  }
  if (params.exactDetailFamily !== "generic") {
    return "exact_detail";
  }
  if (canonicalKind === "fact" || canonicalKind === "state" || params.exactDetailCandidate) {
    return "exact_detail";
  }
  return "generic";
}

function ownerFromNarrativeCandidate(candidate: CanonicalAdjudicationResult | null): AnswerOwnerName | null {
  if (!candidate) {
    return null;
  }
  switch (candidate.canonical.kind) {
    case "set":
      return "canonical_list_set";
    case "temporal_fact":
      return "canonical_temporal";
    case "narrative":
      return "canonical_narrative";
    case "report":
      return "canonical_report";
    case "abstention":
      return "canonical_abstention";
    default:
      return null;
  }
}

function ownerFromCanonical(candidate: CanonicalAdjudicationResult | null): AnswerOwnerName | null {
  if (!candidate) {
    return null;
  }
  const typedFamily = typedSupportFamily(candidate);
  if (typedFamily === "report") {
    return "canonical_report";
  }
  if (typedFamily === "list_set") {
    return "canonical_list_set";
  }
  if (typedFamily === "temporal") {
    return "canonical_temporal";
  }
  const finalClaimSource = candidate.formatted.finalClaimSource;
  if (finalClaimSource === "canonical_temporal") {
    return "canonical_temporal";
  }
  if (finalClaimSource === "canonical_profile" || finalClaimSource === "canonical_counterfactual") {
    return "canonical_report";
  }
  if (finalClaimSource === "canonical_list_set" || finalClaimSource === "canonical_commonality") {
    return "canonical_list_set";
  }
  if (candidate.bundle.predicateFamily === "profile_state" || candidate.bundle.predicateFamily === "relationship_state" || candidate.bundle.predicateFamily === "counterfactual") {
    return "canonical_report";
  }
  if (candidate.bundle.predicateFamily === "list_set" || candidate.bundle.predicateFamily === "commonality" || candidate.bundle.predicateFamily === "location_history") {
    return "canonical_list_set";
  }
  switch (candidate.canonical.kind) {
    case "temporal_fact":
      return "canonical_temporal";
    case "set":
      return "canonical_list_set";
    case "abstention":
      return "canonical_abstention";
    case "fact":
    case "state":
      return "canonical_exact_detail";
    case "narrative":
      return "canonical_narrative";
    case "report":
      return "canonical_report";
    default:
      return null;
  }
}

function familyForOwner(owner: AnswerOwnerName): AnswerOwnerFamily {
  switch (owner) {
    case "canonical_report":
    case "canonical_narrative":
      return "report";
    case "canonical_temporal":
      return "temporal";
    case "canonical_list_set":
      return "list_set";
    case "runtime_exact_detail":
    case "canonical_exact_detail":
      return "exact_detail";
    case "canonical_abstention":
      return "abstention";
    case "top_snippet":
    default:
      return "generic";
  }
}

function sourceTableForCandidate(candidate: CanonicalAdjudicationResult | null): string | null {
  return candidate?.bundle.ownerSourceTable ?? null;
}

function sourceTableForExactDetailCandidate(candidate: ExactDetailClaimCandidate | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  return `runtime_exact_detail:${candidate.source}`;
}

function subjectBindingBlocked(candidate: CanonicalAdjudicationResult | null, queryText: string): boolean {
  if (!candidate || !hasExplicitSubject(queryText)) {
    return false;
  }
  const subjectPlanKind = candidate.bundle.subjectPlan?.kind;
  if (subjectPlanKind === "single_subject" || subjectPlanKind === "pair_subject") {
    return false;
  }
  return candidate.bundle.subjectBindingStatus !== "resolved";
}

function reasonCodesForCandidate(
  owner: AnswerOwnerName,
  candidate: CanonicalAdjudicationResult | null,
  queryText: string
): string[] {
  if (!candidate) {
    return ["missing_candidate"];
  }
  const codes = [
    `candidate_kind:${candidate.canonical.kind}`,
    `owner_family:${familyForOwner(owner)}`,
    `source:${candidate.bundle.ownerSourceTable ?? "runtime"}`
  ];
  if (hasExplicitSubject(queryText)) {
    codes.push("explicit_subject_query");
  }
  if (candidate.bundle.subjectPlan?.kind) {
    codes.push(`subject_plan:${candidate.bundle.subjectPlan.kind}`);
  }
  if (candidate.bundle.subjectBindingStatus) {
    codes.push(`binding:${candidate.bundle.subjectBindingStatus}`);
  }
  return codes;
}

export interface AnswerOwnerResolution {
  readonly adjudication: CanonicalAdjudicationResult | null;
  readonly trace: AnswerOwnerTrace;
}

export function resolveAnswerOwner(params: {
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly results: readonly RecallResult[];
  readonly retrievalPlan?: AnswerRetrievalPlan | null;
  readonly canonicalAdjudication: CanonicalAdjudicationResult | null;
  readonly narrativeCandidate: CanonicalAdjudicationResult | null;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}): AnswerOwnerResolution {
  const family = classifyOwnerFamily(params);
  const runtimePlannerFamily = retrievalLaneToOwnerFamily(params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? null);
  const narrativeOwner = ownerFromNarrativeCandidate(params.narrativeCandidate);
  const canonicalOwner = ownerFromCanonical(params.canonicalAdjudication);
  const explicitSubject = hasExplicitSubject(params.queryText);

  const candidateEntries: Array<{
    owner: AnswerOwnerName;
    candidate: CanonicalAdjudicationResult | null;
    eligible: boolean;
    suppressed: boolean;
    suppressionReason?: string;
  }> = [];

  if (narrativeOwner) {
    candidateEntries.push({
      owner: narrativeOwner,
      candidate: params.narrativeCandidate,
      eligible: true,
      suppressed: false
    });
  }
  if (canonicalOwner) {
    candidateEntries.push({
      owner: canonicalOwner,
      candidate: params.canonicalAdjudication,
      eligible: canonicalOwner === "canonical_abstention" || params.canonicalAdjudication !== null,
      suppressed: false
    });
  }
  if (params.exactDetailCandidate) {
    candidateEntries.push({
      owner: "runtime_exact_detail",
      candidate: null,
      eligible: params.exactDetailCandidate.predicateFit !== false,
      suppressed: false
    });
  }
  candidateEntries.push({
    owner: "top_snippet",
    candidate: null,
    eligible: params.results.length > 0,
    suppressed: false
  });

  const typedOwnersPresent = candidateEntries.some(
    (entry) =>
      entry.eligible &&
      ["canonical_report", "canonical_narrative", "canonical_temporal", "canonical_list_set"].includes(entry.owner) &&
      !subjectBindingBlocked(entry.candidate, params.queryText)
  );
  const activeStructuredOwnerExists = (owners?: readonly AnswerOwnerName[]): boolean =>
    candidateEntries.some(
      (candidate) =>
        candidate.eligible &&
        !candidate.suppressed &&
        candidate.owner !== "top_snippet" &&
        candidate.owner !== "canonical_abstention" &&
        !subjectBindingBlocked(candidate.candidate, params.queryText) &&
        (!owners || owners.includes(candidate.owner))
    );
  const plannerTypedLaneViable =
    typedOwnersPresent ||
    ["report", "temporal", "list_set"].includes(retrievalLaneToOwnerFamily(params.retrievalPlan?.lane ?? params.retrievalPlan?.family ?? null)) ||
    Boolean(
      params.canonicalAdjudication?.formatted.shapingTrace?.supportObjectAttempted &&
      typedSupportFamily(params.canonicalAdjudication) &&
      typedSupportFamily(params.canonicalAdjudication) !== "exact_detail"
    );
  const typedListSetPreferred =
    ["country", "shop", "symbolic_gifts", "bands", "favorite_band", "favorite_dj", "favorite_books"].includes(params.exactDetailFamily) &&
    activeStructuredOwnerExists(["canonical_list_set"]);

  for (const entry of candidateEntries) {
    if (!entry.eligible) {
      continue;
    }
    if (
      entry.owner !== "canonical_abstention" &&
      entry.owner !== "runtime_exact_detail" &&
      entry.owner !== "top_snippet" &&
      subjectBindingBlocked(entry.candidate, params.queryText)
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "binding_required_for_explicit_subject";
      continue;
    }
    if (
      entry.owner === "canonical_abstention" &&
      activeStructuredOwnerExists()
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "eligible_non_abstention_owner_exists";
      continue;
    }
    if (
      entry.owner === "top_snippet" &&
      (
        activeStructuredOwnerExists() ||
        candidateEntries.some((candidate) => candidate.owner === "canonical_abstention" && candidate.eligible && !candidate.suppressed)
      )
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "structured_owner_precedence";
      continue;
    }
    if (
      entry.owner === "top_snippet" &&
      !activeStructuredOwnerExists() &&
      plannerTypedLaneViable &&
      plannerHasIncompleteTypedLane(params.retrievalPlan) &&
      plannerSuppressesExactDetail(params.canonicalAdjudication, params.retrievalPlan) &&
      family === "report"
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "planner_typed_lane_incomplete";
      continue;
    }
    if (
      typedListSetPreferred &&
      ["canonical_exact_detail", "runtime_exact_detail"].includes(entry.owner)
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "typed_list_set_owner_precedence";
      continue;
    }
    if (
      ["canonical_exact_detail", "runtime_exact_detail"].includes(entry.owner) &&
      plannerSuppressesExactDetail(params.canonicalAdjudication, params.retrievalPlan) &&
      plannerTypedLaneViable &&
      ["report", "temporal", "list_set"].includes(family)
    ) {
      entry.suppressed = true;
      entry.suppressionReason = `planner_${family}_suppresses_exact_detail`;
      continue;
    }
    if (["canonical_exact_detail", "runtime_exact_detail"].includes(entry.owner) && typedOwnersPresent && ["report", "temporal", "list_set"].includes(family)) {
      entry.suppressed = true;
      entry.suppressionReason = `typed_${family}_owner_precedence`;
      continue;
    }
    if (
      family === "report" &&
      ["canonical_exact_detail", "runtime_exact_detail", "canonical_abstention", "top_snippet"].includes(entry.owner) &&
      activeStructuredOwnerExists(["canonical_report", "canonical_narrative"])
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "report_family_precedence";
      continue;
    }
    if (
      family === "temporal" &&
      ["canonical_exact_detail", "runtime_exact_detail", "canonical_abstention", "top_snippet"].includes(entry.owner) &&
      activeStructuredOwnerExists(["canonical_temporal"])
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "temporal_family_precedence";
      continue;
    }
    if (
      family === "list_set" &&
      ["canonical_exact_detail", "runtime_exact_detail", "canonical_abstention", "top_snippet"].includes(entry.owner) &&
      activeStructuredOwnerExists(["canonical_list_set"])
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "list_set_family_precedence";
      continue;
    }
    if (
      family === "exact_detail" &&
      ["canonical_report", "canonical_narrative"].includes(entry.owner) &&
      activeStructuredOwnerExists(["runtime_exact_detail", "canonical_exact_detail"])
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "exact_detail_family_precedence";
      continue;
    }
    if (
      entry.owner === "canonical_exact_detail" &&
      candidateEntries.some((candidate) => candidate.owner === "runtime_exact_detail" && candidate.eligible)
    ) {
      entry.suppressed = true;
      entry.suppressionReason = "runtime_exact_detail_precedence";
      continue;
    }
  }

  const precedenceByFamily: Record<AnswerOwnerFamily, readonly AnswerOwnerName[]> = {
    report: ["canonical_report", "canonical_narrative", "runtime_exact_detail", "canonical_exact_detail", "canonical_list_set", "canonical_temporal", "canonical_abstention", "top_snippet"],
    temporal: ["canonical_temporal", "runtime_exact_detail", "canonical_exact_detail", "canonical_abstention", "top_snippet"],
    list_set: ["canonical_list_set", "runtime_exact_detail", "canonical_exact_detail", "canonical_abstention", "top_snippet"],
    exact_detail: ["runtime_exact_detail", "canonical_exact_detail", "canonical_list_set", "canonical_report", "canonical_narrative", "canonical_abstention", "top_snippet"],
    abstention: ["canonical_abstention", "top_snippet"],
    generic: ["canonical_report", "canonical_narrative", "canonical_temporal", "canonical_list_set", "runtime_exact_detail", "canonical_exact_detail", "canonical_abstention", "top_snippet"]
  };
  const precedence = precedenceByFamily[family];
  const winnerEntry =
    precedence
      .map((owner) => candidateEntries.find((entry) => entry.owner === owner && entry.eligible && !entry.suppressed) ?? null)
      .find((entry) => entry !== null) ?? null;

  const winner =
    winnerEntry?.owner === "runtime_exact_detail"
        ? null
      : winnerEntry?.owner === "top_snippet"
        ? null
        : winnerEntry?.candidate ?? null;

  const candidates: AnswerOwnerCandidateTrace[] = candidateEntries.map((entry) => ({
    owner: entry.owner,
    family: familyForOwner(entry.owner),
    eligible: entry.eligible,
    suppressed: entry.suppressed,
    suppressionReason: entry.suppressionReason,
    reasonCodes: reasonCodesForCandidate(
      entry.owner,
      entry.candidate,
      params.queryText
    ),
    subjectBindingStatus: entry.candidate?.bundle.subjectBindingStatus,
    subjectPlanKind: entry.candidate?.bundle.subjectPlan?.kind,
    sourceTable:
      entry.owner === "runtime_exact_detail"
          ? sourceTableForExactDetailCandidate(params.exactDetailCandidate)
          : sourceTableForCandidate(entry.candidate)
  }));

  const primaryQuerySubjects = extractPrimaryQuerySurfaceNames(params.queryText);
  const possessiveSubjects = extractPossessiveQuerySurfaceNames(params.queryText);
  const pairSubjects = extractPairQuerySurfaceNames(params.queryText);
  const fallbackSubjectName =
    primaryQuerySubjects[0] ??
    possessiveSubjects[0] ??
    (pairSubjects.length === 1 ? pairSubjects[0] : null);
  const fallbackSubjectPlanKind =
    pairSubjects.length >= 2
      ? "pair_subject"
      : fallbackSubjectName
        ? "single_subject"
        : undefined;
  const fallbackBindingStatus = fallbackSubjectName ? "resolved" : undefined;

  return {
    adjudication: winner,
    trace: {
      family,
      reasonCodes: [
        `family:${family}`,
        explicitSubject ? "explicit_subject_query" : "implicit_subject_query",
        `planner_family:${
          runtimePlannerFamily !== "generic"
            ? runtimePlannerFamily
            : plannerFamily(params.canonicalAdjudication) !== "generic"
              ? plannerFamily(params.canonicalAdjudication)
              : plannerFamily(params.narrativeCandidate)
        }`
      ],
      resolvedSubject: {
        bindingStatus:
          winner?.bundle.subjectBindingStatus ??
          params.canonicalAdjudication?.bundle.subjectBindingStatus ??
          params.narrativeCandidate?.bundle.subjectBindingStatus ??
          fallbackBindingStatus,
        subjectPlanKind:
          winner?.bundle.subjectPlan?.kind ??
          params.canonicalAdjudication?.bundle.subjectPlan?.kind ??
          params.narrativeCandidate?.bundle.subjectPlan?.kind ??
          fallbackSubjectPlanKind,
        subjectId: winner?.bundle.subjectEntityId ?? params.canonicalAdjudication?.bundle.subjectEntityId ?? params.narrativeCandidate?.bundle.subjectEntityId ?? null,
        subjectName:
          winner?.bundle.canonicalSubjectName ??
          params.canonicalAdjudication?.bundle.canonicalSubjectName ??
          params.narrativeCandidate?.bundle.canonicalSubjectName ??
          fallbackSubjectName ??
          null
      },
      eligibleOwners: candidateEntries.filter((entry) => entry.eligible && !entry.suppressed).map((entry) => entry.owner),
      suppressedOwners: candidateEntries
        .filter((entry) => entry.suppressed && entry.suppressionReason)
        .map((entry) => ({ owner: entry.owner, reason: entry.suppressionReason! })),
      candidates,
      winner: winnerEntry?.owner ?? null,
      fallbackPath: candidateEntries.filter((entry) => entry.eligible).map((entry) => entry.owner),
      abstentionReason:
        params.canonicalAdjudication?.canonical.kind === "abstention"
          ? params.canonicalAdjudication.canonical.abstainReason
          : params.narrativeCandidate?.canonical.kind === "abstention"
            ? params.narrativeCandidate.canonical.abstainReason
            : null
    }
  };
}
