import type { RecallResult } from "../types.js";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import type {
  AnswerRetrievalPlan,
  AnswerShapingTrace,
  CanonicalAbstainReason,
  CanonicalAdjudicationResult,
  CanonicalAdjudicationRequest,
  CanonicalAnswerBundle,
  CanonicalFormatterResult,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  CanonicalSupportStrength,
  CanonicalSubjectBindingStatus,
  CanonicalTimeScopeKind,
  ExactDetailClaimCandidate,
  RecallConfidenceGrade,
  RecallEvidenceItem,
  RecallResponse,
  RecallSufficiencyGrade,
  RecallSubjectMatch,
  SubjectPlan,
  TemporalValidityWindow
} from "./types.js";
import { resolveCanonicalSubjectBinding } from "./canonical-subject-binding.js";
import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";
import { buildCanonicalSubjectPlan } from "./subject-plan.js";
import { buildReasoningChain } from "./reasoning-chain.js";
import { buildAnswerRetrievalPlan, extractAtomicMemoryUnits, isPreferenceChoiceQuery } from "./answer-retrieval-plan.js";
import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import {
  buildCollectionInferenceSupport,
  buildCounterfactualCareerSupport,
  buildDirectDetailSupport,
  buildListSetSupport,
  buildPreferenceChoiceSupport,
  buildProfileInferenceSupport,
  buildSnippetFactSupport,
  buildTemporalEventSupport,
  renderCollectionInferenceSupport,
  renderCounterfactualCareerSupport,
  renderDirectDetailSupport,
  renderListSetSupport,
  renderPreferenceChoiceSupport,
  renderProfileInferenceSupport,
  renderSnippetFactSupport,
  shouldUseCounterfactualCareerJudgment,
  renderTemporalEventSupport,
  type RenderedSupportClaim
} from "./support-objects.js";
import {
  inferCanonicalTieBreakReason,
  inferCanonicalWinnerTier,
  inferRetrievalLatencyBudgetFamily,
  inferStructuredPayloadKind,
  renderStoredCanonicalSetValues,
  shouldPreferDerivedTemporalOverStored,
  shouldUseListSetRenderContract as shouldUseListSetRenderContractPolicy
} from "./canonical-adjudication-policy.js";

interface CanonicalDerivedClaims {
  readonly temporal?: string | null;
  readonly profile?: string | null;
  readonly identity?: string | null;
  readonly commonality?: string | null;
  readonly counterfactual?: string | null;
  readonly realization?: string | null;
  readonly causal?: string | null;
  readonly goals?: string | null;
  readonly residualExact?: string | null;
  readonly residualPlaceEvent?: string | null;
  readonly descriptivePlaceActivity?: string | null;
  readonly moveFromCountry?: string | null;
  readonly genericEnumerative?: string | null;
  readonly placeShopCountry?: string | null;
  readonly symbolicGift?: string | null;
  readonly musicMedia?: string | null;
  readonly hobbies?: string | null;
  readonly petSafety?: string | null;
  readonly financialStatus?: string | null;
  readonly companionExclusion?: string | null;
  readonly shared?: string | null;
  readonly currentProject?: string | null;
  readonly purchaseSummary?: string | null;
  readonly mediaSummary?: string | null;
  readonly preferenceSummary?: string | null;
  readonly personTime?: string | null;
}

type CanonicalAdjudicationInput = Omit<CanonicalAdjudicationRequest, "derived"> & {
  readonly derived: CanonicalDerivedClaims;
};

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeDerivedTemporalDirectClaim(value: string): string {
  const normalized = normalize(value).replace(/^the best supported date is\s+/iu, "");
  if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}\.?$/u.test(normalized) || /^[A-Za-z]+\s+\d{4}\.?$/u.test(normalized)) {
    return normalized.replace(/\.$/u, "");
  }
  return normalized;
}

function requiresTypedTemporalSupportContract(value: string): boolean {
  const normalized = normalize(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\bweek of\b|\bweekend of\b|\bweek before\b|\bweek after\b|\blast week\b|\bthis week\b|\bnext week\b|\ba few days before\b|\ba few days after\b|\ba few years before\b|\ba few years after\b/.test(
    normalized
  );
}

function shouldPreferTypedTemporalSupportContract(params: {
  readonly directClaimText: string;
  readonly renderedSupport: RenderedSupportClaim | null;
}): boolean {
  if (!/^the best supported date is\b/iu.test(normalize(params.directClaimText))) {
    return false;
  }
  const renderedClaimText = normalize(params.renderedSupport?.claimText);
  if (!renderedClaimText) {
    return false;
  }
  return params.renderedSupport?.renderContractSelected === "temporal_relative_day";
}

function requiresSupportBackedExactDetailFamily(family: string): boolean {
  return family === "duration" || family === "endorsement_company" || family === "habit_start_activity";
}

function derivePromotedExactDetailSupportCandidate(
  input: CanonicalAdjudicationInput
): { readonly text: string; readonly source: "mixed"; readonly strongSupport: true } | null {
  if (input.exactDetailCandidateStrongSupport && normalize(input.exactDetailCandidateText)) {
    return {
      text: normalize(input.exactDetailCandidateText),
      source: "mixed",
      strongSupport: true
    };
  }
  if (
    requiresSupportBackedExactDetailFamily(input.exactDetailFamily) &&
    input.exactDetailCandidatePredicateFit &&
    normalize(input.exactDetailCandidateText)
  ) {
    return {
      text: normalize(input.exactDetailCandidateText),
      source: "mixed",
      strongSupport: true
    };
  }
  if (!requiresSupportBackedExactDetailFamily(input.exactDetailFamily)) {
    return null;
  }
  const residualExact = normalize(input.derived.residualExact);
  if (!residualExact || /^none\.?$/iu.test(residualExact)) {
    return null;
  }
  return {
    text: residualExact,
    source: "mixed",
    strongSupport: true
  };
}

function isCanonicalCollectionQuery(queryText: string): boolean {
  return /\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children'?s books\b|\bcollect(?:ion|s)?\b/iu.test(queryText);
}

function inferCanonicalReportKind(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly storedCanonical?: StoredCanonicalLookup | null;
}): CanonicalReportKind {
  if (params.storedCanonical?.reportKind) {
    return params.storedCanonical.reportKind;
  }
  if (params.predicateFamily === "counterfactual") {
    return "career_report";
  }
  if (/\bwould\b.*\bpursue\b|\bcareer option\b|\bwhat career\b|\bwhat kind of work\b/iu.test(params.queryText)) {
    return "career_report";
  }
  if (isCanonicalCollectionQuery(params.queryText)) {
    return "collection_report";
  }
  if (params.predicateFamily === "relationship_state") {
    return "relationship_report";
  }
  if (/\bfavorite\b|\bprefer\b/iu.test(params.queryText) || isPreferenceChoiceQuery(params.queryText)) {
    return "preference_report";
  }
  return "profile_report";
}

function renderCanonicalReportSupport(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly storedCanonical?: StoredCanonicalLookup | null;
  readonly fallbackSummary: string | null;
  readonly results: readonly RecallResult[];
}): RenderedSupportClaim | null {
  const reportKind = inferCanonicalReportKind(params);
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: params.queryText,
    predicateFamily: params.storedCanonical?.predicateFamily ?? params.predicateFamily,
    reportKind,
    subjectEntityHints: params.results
      .map((result) => {
        const subjectEntityId = result.provenance.subject_entity_id;
        return typeof subjectEntityId === "string" && subjectEntityId.trim() ? subjectEntityId.trim() : null;
      })
      .filter((value): value is string => Boolean(value))
  });
  const atomicUnits = extractAtomicMemoryUnits({
    results: params.results,
    storedCanonical: params.storedCanonical,
    retrievalPlan
  });
  const answerPayload =
    typeof params.storedCanonical?.answerPayload === "object" && params.storedCanonical.answerPayload !== null
      ? params.storedCanonical.answerPayload
      : null;
  if (reportKind === "collection_report") {
    const rendered = renderCollectionInferenceSupport(
      params.queryText,
      buildCollectionInferenceSupport({
        queryText: params.queryText,
        fallbackSummary: params.fallbackSummary,
        answerPayload,
        results: params.results,
        atomicUnits
      })
    );
    return rendered.claimText ? rendered : null;
  }
  const support = buildProfileInferenceSupport({
    reportKind,
    queryText: params.queryText,
    fallbackSummary: params.fallbackSummary,
    answerPayload,
    results: params.results
  });
  if (isPreferenceChoiceQuery(params.queryText)) {
    const renderedChoice = renderPreferenceChoiceSupport(
      buildPreferenceChoiceSupport({
        queryText: params.queryText,
        support
      })
    );
    if (renderedChoice.claimText) {
      return renderedChoice;
    }
  }
  if (shouldUseCounterfactualCareerJudgment(params.queryText, support.reportKind)) {
    const renderedCareer = renderCounterfactualCareerSupport(
      buildCounterfactualCareerSupport({
        queryText: params.queryText,
        support
      })
    );
    if (renderedCareer.claimText) {
      return renderedCareer;
    }
  }
  const rendered = renderProfileInferenceSupport(params.queryText, support);
  return rendered.claimText ? rendered : null;
}

function shouldPromoteStoredSubjectBinding(params: {
  readonly queryText: string;
  readonly storedCanonical: StoredCanonicalLookup | null;
  readonly canonicalSubjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly foreignParticipants: readonly string[];
}): boolean {
  if (!params.storedCanonical || params.canonicalSubjectBindingStatus === "resolved") {
    return false;
  }
  if (extractPairQuerySurfaceNames(params.queryText).length > 1 || params.foreignParticipants.length > 0) {
    return false;
  }
  const explicitNames = [
    ...extractPossessiveQuerySurfaceNames(params.queryText),
    ...extractPrimaryQuerySurfaceNames(params.queryText)
  ].map((value) => normalize(value).toLowerCase()).filter(Boolean);
  if (explicitNames.length !== 1) {
    return false;
  }
  const storedName = normalize(params.storedCanonical.canonicalSubjectName).toLowerCase();
  return storedName.length > 0 && explicitNames[0] === storedName;
}

function detectSubjectEntityId(results: readonly RecallResult[]): string | null {
  for (const result of results) {
    const direct = result.provenance.subject_entity_id;
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    if (typeof metadata?.subject_entity_id === "string" && metadata.subject_entity_id.length > 0) {
      return metadata.subject_entity_id;
    }
  }
  return null;
}

function inferValidity(results: readonly RecallResult[]): { readonly validFrom: string | null; readonly validUntil: string | null } {
  for (const result of results) {
    const validFrom = readStringProvenance(result, "valid_from");
    const validUntil = readStringProvenance(result, "valid_until");
    if (validFrom || validUntil) {
      return { validFrom, validUntil };
    }
  }
  return { validFrom: null, validUntil: null };
}

function readStringProvenance(result: RecallResult, key: string): string | null {
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

function inferSupportStrength(confidence: RecallConfidenceGrade, sufficiency: RecallSufficiencyGrade): CanonicalSupportStrength {
  if (confidence === "confident" && sufficiency === "supported") {
    return "strong";
  }
  if (confidence === "missing" || sufficiency === "missing" || sufficiency === "contradicted") {
    return "weak";
  }
  return "moderate";
}

function inferTimeScopeKind(queryText: string, claimText: string | null | undefined): CanonicalTimeScopeKind {
  const query = queryText.toLowerCase();
  const claim = normalize(claimText).toLowerCase();
  if (!claim) {
    return "unknown";
  }
  if (/\b(ago|last year|last week|weekend before|between|before|after)\b/i.test(claim)) {
    return /\bbetween\b/i.test(claim) ? "range" : "anchored_relative";
  }
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(claim)) {
    return /\b\d{4}\b/.test(claim) || /\bwhich year\b/i.test(query) ? "month_year" : "anchored_relative";
  }
  if (/\b\d{1,2}\s+[a-z]+\s+\d{4}\b/i.test(claim) || /\b\d{4}-\d{2}-\d{2}\b/.test(claim)) {
    return "exact";
  }
  if (/\b(before|after)\b/i.test(claim)) {
    return "before_after";
  }
  if (/\b(current|currently|now|active)\b/i.test(claim)) {
    return "active";
  }
  if (/\b(former|used to|historical|previously|previous)\b/i.test(claim)) {
    return "historical";
  }
  return /\bwhen|year|month|ago|first|start|resume|moved\b/i.test(query) ? "unknown" : "active";
}

function inferTemporalValidityWindow(params: {
  readonly storedCanonical?: StoredCanonicalLookup | null;
  readonly claimText: string | null;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}): TemporalValidityWindow {
  return {
    mentionedAt: params.storedCanonical?.mentionedAt ?? null,
    validFrom: params.validFrom,
    validUntil: params.validUntil,
    timeScopeKind: params.timeScopeKind,
    source:
      params.storedCanonical?.temporalValiditySource ??
      (params.validFrom || params.validUntil
        ? "event_time"
        : ["exact", "month_year", "range", "before_after", "anchored_relative"].includes(params.timeScopeKind)
          ? "event_time"
          : "unknown")
  };
}

function inferClaimKind(
  predicateFamily: CanonicalPredicateFamily,
  abstain: boolean,
  canonicalKind: "fact" | "state" | "temporal_fact" | "set" | "narrative" | "report"
): CanonicalAnswerBundle["claimKind"] {
  if (abstain) {
    return "abstention";
  }
  if (canonicalKind === "temporal_fact") {
    return "temporal";
  }
  if (canonicalKind === "set") {
    return "set";
  }
  if (canonicalKind === "narrative") {
    return "narrative";
  }
  if (canonicalKind === "report") {
    return "report";
  }
  if (canonicalKind === "state" || predicateFamily === "profile_state" || predicateFamily === "relationship_state") {
    return "state";
  }
  return "fact";
}

function inferCanonicalSourceFromRenderedSupport(params: {
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly renderedSupport: RenderedSupportClaim | null;
}): CanonicalFormatterResult["finalClaimSource"] | null {
  switch (params.renderedSupport?.supportObjectType) {
    case "TemporalEventSupport":
      return "canonical_temporal";
    case "ListSetSupport":
      return params.predicateFamily === "commonality" ? "canonical_commonality" : "canonical_list_set";
    case "CounterfactualCareerSupport":
      return "canonical_counterfactual";
    case "CollectionSetSupport":
    case "CollectionInferenceSupport":
    case "ProfileInferenceSupport":
    case "PreferenceChoiceSupport":
      return "canonical_profile";
    case "DirectDetailSupport":
      return "canonical_exact_detail";
    default:
      return null;
  }
}

function inferPredicateFamily(queryText: string, exactDetailFamily: string): CanonicalPredicateFamily {
  if (/\bidentity\b|\bgender identity\b|\btransgender\b|\bnonbinary\b|\bqueer\b/i.test(queryText)) {
    return "alias_identity";
  }
  if (exactDetailFamily === "favorite_books" || (/\bwhat\s+kind\s+of\s+flowers?\b/i.test(queryText) && /\btattoo\b/i.test(queryText))) {
    return "ownership_binding";
  }
  if (/\bif\b.*\bwould\b|\bwould\b.*\bif\b|\bwhy\b/i.test(queryText)) {
    return "counterfactual";
  }

  if (exactDetailFamily !== "generic") {
    if (["plural_names", "allergy_safe_pets"].includes(exactDetailFamily)) {
      return "ownership_binding";
    }
    if (["goals"].includes(exactDetailFamily)) {
      return "profile_state";
    }
    if (["social_exclusion", "hobbies", "shop", "country", "symbolic_gifts", "deceased_people", "bands", "favorite_band", "favorite_dj"].includes(exactDetailFamily)) {
      return "list_set";
    }
    if (["realization"].includes(exactDetailFamily)) {
      return "counterfactual";
    }
    return "generic_fact";
  }

  if (/\bwho\s+is\b|\balias\b|\bcalled\b/i.test(queryText)) {
    return "alias_identity";
  }
  if (/\bwhen\b|\bwhich\s+year\b|\bwhich\s+month\b|\bhow long ago\b/i.test(queryText)) {
    return "temporal_event_fact";
  }
  if (/\bwhat do .* have in common\b|\bcommon\b/i.test(queryText)) {
    return "commonality";
  }
  if (extractPairQuerySurfaceNames(queryText).length >= 2 && /\bshare\b/i.test(queryText)) {
    return "commonality";
  }
  if (/\bwhat subject have\b/i.test(queryText) || /\bcompare their entrepreneurial journeys\b/i.test(queryText) || /\bactivity did\b/i.test(queryText) && /\btogether\b/i.test(queryText)) {
    return "commonality";
  }
  if (/\bwhat books?\b/i.test(queryText) || /\bwho supports?\b/i.test(queryText) || /\bdestress\b/i.test(queryText) || /\bin what ways\b/i.test(queryText) && /\blgbtq\+?\b/i.test(queryText)) {
    return "list_set";
  }
  if (/\bwhat\s+(?:[a-z0-9+&'’ -]+\s+)?events?\b/i.test(queryText) && /\bparticipat(?:e|ed|es|ing)\b|\battend(?:ed|ing|s)?\b/i.test(queryText)) {
    return "list_set";
  }
  if (/\bwhat\s+(?:types|kinds)\b/i.test(queryText) || /\bwhat has\b.*\bpainted\b/i.test(queryText) || /\bhow many children\b/i.test(queryText)) {
    return "list_set";
  }
  if (/\bgoal|career|plan\b/i.test(queryText)) {
    return "profile_state";
  }
  if (/\bwould\b/i.test(queryText) && (/\benjoy\b/i.test(queryText) || /\binterested in\b/i.test(queryText) || /\bbookshelf\b/i.test(queryText) || /\bmember of the lgbtq community\b/i.test(queryText) || /\bally\b/i.test(queryText))) {
    return "profile_state";
  }
  if (/\blive\b|\bmarried\b|\bemploy\b|\bhealth\b|\bdrive\b/i.test(queryText)) {
    return "profile_state";
  }
  if (/\bwhere\b|\bplaces?\b|\btravel\b|\bmeet\b/i.test(queryText)) {
    return "location_history";
  }
  return "generic_fact";
}

function extractNamedSubjects(queryText: string): readonly string[] {
  return extractQuerySurfaceNames(queryText);
}

function requiresResolvedSubjectBinding(queryText: string, predicateFamily: CanonicalPredicateFamily, exactDetailFamily: string): boolean {
  if (extractNamedSubjects(queryText).length === 0) {
    return false;
  }
  // Named-subject queries should not silently degrade into generic claims. Either
  // we bind the person cleanly or we abstain before snippet-level fallback takes over.
  if (predicateFamily === "alias_identity" || predicateFamily === "abstention") {
    return false;
  }
  if (predicateFamily === "commonality" || /\bboth\b|\btogether\b|\bin common\b/i.test(queryText)) {
    return false;
  }
  if (exactDetailFamily !== "generic") {
    return true;
  }
  return true;
}

function shouldPromoteExplicitTemporalSubjectBinding(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly canonicalSubjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly subjectPlan: SubjectPlan;
}): boolean {
  if (params.predicateFamily !== "temporal_event_fact") {
    return false;
  }
  if (params.canonicalSubjectBindingStatus === "resolved") {
    return false;
  }
  if (extractPairQuerySurfaceNames(params.queryText).length > 0) {
    return false;
  }
  const explicitNames = [
    ...extractPossessiveQuerySurfaceNames(params.queryText),
    ...extractPrimaryQuerySurfaceNames(params.queryText)
  ].map((value) => normalize(value)).filter(Boolean);
  if (explicitNames.length !== 1) {
    return false;
  }
  return params.subjectPlan.kind === "single_subject" && Boolean(params.subjectPlan.canonicalSubjectName);
}

function shouldPromoteExplicitSingleSubjectBinding(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly canonicalSubjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly subjectPlan: SubjectPlan;
}): boolean {
  if (params.canonicalSubjectBindingStatus === "resolved") {
    return false;
  }
  if (params.predicateFamily === "alias_identity" || params.predicateFamily === "commonality") {
    return false;
  }
  if (extractPairQuerySurfaceNames(params.queryText).length > 0) {
    return false;
  }
  const explicitNames = [
    ...extractPossessiveQuerySurfaceNames(params.queryText),
    ...extractPrimaryQuerySurfaceNames(params.queryText)
  ].map((value) => normalize(value)).filter(Boolean);
  if (explicitNames.length !== 1) {
    return false;
  }
  return params.subjectPlan.kind === "single_subject" && Boolean(params.subjectPlan.canonicalSubjectName);
}

function canonicalClaimForFamily(input: CanonicalAdjudicationInput, predicateFamily: CanonicalPredicateFamily): { claimText: string | null; source: CanonicalAdjudicationResult["formatted"]["finalClaimSource"] } {
  const claimMap = input.derived;
  const trustedExactDetail =
    input.exactDetailCandidateStrongSupport && (input.exactDetailCandidatePredicateFit ?? true)
      ? input.exactDetailCandidateText ?? null
      : null;
  if (input.currentDatingUnknownFromEvidence) {
    return { claimText: "Unknown.", source: "canonical_abstention" };
  }

  switch (predicateFamily) {
    case "temporal_event_fact":
      return { claimText: claimMap.temporal ?? null, source: "canonical_temporal" };
    case "commonality":
      return { claimText: claimMap.commonality ?? claimMap.shared ?? null, source: "canonical_commonality" };
    case "profile_state":
      return {
        claimText:
          claimMap.profile ??
          claimMap.identity ??
          claimMap.preferenceSummary ??
          claimMap.mediaSummary ??
          claimMap.genericEnumerative ??
          claimMap.financialStatus ??
          claimMap.goals ??
          claimMap.currentProject ??
          null,
        source: "canonical_profile"
      };
    case "ownership_binding":
      return {
        claimText: claimMap.residualExact ?? claimMap.petSafety ?? null,
        source: "canonical_exact_detail"
      };
    case "location_history":
      return {
        claimText:
          claimMap.residualPlaceEvent ??
          claimMap.descriptivePlaceActivity ??
          claimMap.placeShopCountry ??
          claimMap.moveFromCountry ??
          null,
        source: "canonical_list_set"
      };
    case "counterfactual":
      return {
        claimText: claimMap.counterfactual ?? claimMap.realization ?? claimMap.causal ?? null,
        source: input.derived.counterfactual ? "canonical_counterfactual" : "canonical_abstention"
      };
    case "list_set":
      return {
        claimText:
          claimMap.hobbies ??
          claimMap.petSafety ??
          claimMap.companionExclusion ??
          claimMap.placeShopCountry ??
          claimMap.symbolicGift ??
          claimMap.musicMedia ??
          claimMap.shared ??
          claimMap.genericEnumerative ??
          claimMap.residualPlaceEvent ??
          claimMap.descriptivePlaceActivity ??
          null,
        source: "canonical_list_set"
      };
    case "alias_identity":
      return {
        claimText: claimMap.identity ?? claimMap.profile ?? null,
        source: "canonical_profile"
      };
    case "generic_fact":
    default:
      for (const [claimText, source] of [
        [claimMap.residualExact ?? null, "canonical_exact_detail"],
        [claimMap.goals ?? null, "canonical_profile"],
        [claimMap.moveFromCountry ?? null, "canonical_list_set"],
        [claimMap.genericEnumerative ?? null, "canonical_list_set"],
        [claimMap.purchaseSummary ?? null, "canonical_generic"],
        [claimMap.mediaSummary ?? null, "canonical_generic"],
        [claimMap.preferenceSummary ?? null, "canonical_generic"],
        [claimMap.personTime ?? null, "canonical_generic"],
        [trustedExactDetail, "canonical_exact_detail"]
      ] as const) {
        if (normalize(claimText)) {
          return { claimText, source };
        }
      }
      return { claimText: null, source: "canonical_generic" };
  }
}

function parseCanonicalSetValues(claimText: string): readonly string[] {
  const normalized = claimText
    .replace(/\b(?:and|or)\b/gi, ",")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  return [...new Set(
    normalized
      .split(",")
      .map((value) => value.trim().replace(/^[.;:]+|[.;:]+$/g, ""))
      .filter(Boolean)
  )];
}

function inferAbstainReason(input: CanonicalAdjudicationInput, predicateFamily: CanonicalPredicateFamily): CanonicalAbstainReason {
  const subjectMatch = input.assessment.subjectMatch;
  if (subjectMatch === "mixed" || subjectMatch === "mismatched") {
    return "insufficient_subject_binding";
  }
  if (predicateFamily === "ownership_binding") {
    return "ownership_not_proven";
  }
  if (predicateFamily === "temporal_event_fact") {
    return "insufficient_temporal_anchor";
  }
  if (predicateFamily === "profile_state") {
    return "current_state_not_supported";
  }
  if (predicateFamily === "counterfactual") {
    return "unsupported_counterfactual_chain";
  }
  if (input.assessment.sufficiency === "contradicted") {
    return "conflicting_evidence";
  }
  return "insufficient_support";
}

function buildCanonicalShapingTrace(params: {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly storedCanonical: StoredCanonicalLookup | null;
  readonly subjectBindingStatus?: string | null;
  readonly subjectBindingReason?: string | null;
  readonly exactDetailCandidateText?: string | null;
  readonly exactDetailCandidateStrongSupport?: boolean;
  readonly finalClaimText: string;
  readonly supportRowsSelected: number;
  readonly shouldAbstain: boolean;
  readonly finalClaimSource?: CanonicalFormatterResult["finalClaimSource"] | null;
  readonly preferDerivedTemporalOverStored?: boolean;
  readonly earlyExitReason?: string | null;
  readonly renderedSupport?: RenderedSupportClaim | null;
}): AnswerShapingTrace {
  const effectivePredicateFamily = params.storedCanonical?.predicateFamily ?? params.predicateFamily;
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: params.queryText,
    predicateFamily: effectivePredicateFamily,
    reportKind: params.storedCanonical?.reportKind,
    supportObjectType: params.renderedSupport?.supportObjectType ?? null,
    subjectBindingStatus: (params.renderedSupport?.subjectBindingStatus ?? params.subjectBindingStatus ?? "unresolved") as CanonicalSubjectBindingStatus,
    temporalEventIdentityStatus: params.renderedSupport?.temporalEventIdentityStatus ?? null,
    temporalGranularityStatus: params.renderedSupport?.temporalGranularityStatus ?? null,
    subjectEntityHints: params.results
      .map((result) => {
        const subjectEntityId = result.provenance.subject_entity_id;
        return typeof subjectEntityId === "string" && subjectEntityId.trim() ? subjectEntityId.trim() : null;
      })
      .filter((value): value is string => Boolean(value))
  });
  const atomicUnits = extractAtomicMemoryUnits({
    results: params.results,
    storedCanonical: params.storedCanonical,
    supportObjectType: params.renderedSupport?.supportObjectType ?? null,
    selectedEventKey: params.renderedSupport?.selectedEventKey ?? null,
    selectedEventType: params.renderedSupport?.selectedEventType ?? null,
    selectedTimeGranularity: params.renderedSupport?.selectedTimeGranularity ?? null,
    exactDetailSource: params.renderedSupport?.exactDetailSource ?? null,
    retrievalPlan
  });
  const atomicUnitTypes = [...new Set(atomicUnits.map((unit) => unit.unitType))];
  const winnerTier =
    params.shouldAbstain
      ? null
      : inferCanonicalWinnerTier({
          finalClaimSource: params.finalClaimSource,
          renderedSupport: params.renderedSupport,
          storedCanonical: params.storedCanonical,
          subjectBindingStatus: params.renderedSupport?.subjectBindingStatus ?? params.subjectBindingStatus
        });
  const tieBreakReason = inferCanonicalTieBreakReason({
    queryText: params.queryText,
    finalClaimSource: params.finalClaimSource,
    storedCanonical: params.storedCanonical,
    subjectBindingStatus: params.renderedSupport?.subjectBindingStatus ?? params.subjectBindingStatus,
    renderedSupport: params.renderedSupport,
    exactDetailCandidatePredicateFit: params.exactDetailCandidateStrongSupport,
          preferDerivedTemporalOverStored: params.preferDerivedTemporalOverStored ?? false
  });
  const traceMetadata = {
    winnerTier,
    tieBreakReason,
    bindingSatisfied: (params.renderedSupport?.subjectBindingStatus ?? params.subjectBindingStatus) === "resolved",
    structuredPayloadKind: inferStructuredPayloadKind(params.renderedSupport),
    usedDualityFallback: false,
    latencyBudgetFamily: inferRetrievalLatencyBudgetFamily(params.queryText, inferExactDetailQuestionFamily(params.queryText)),
    earlyExitReason: params.earlyExitReason ?? null
  } satisfies Pick<
    AnswerShapingTrace,
    "winnerTier" | "tieBreakReason" | "bindingSatisfied" | "structuredPayloadKind" | "usedDualityFallback" | "latencyBudgetFamily" | "earlyExitReason"
  >;
  if (params.shouldAbstain) {
    return {
      ...traceMetadata,
      selectedFamily: "abstention",
      shapingMode: "abstention",
      retrievalPlanFamily: retrievalPlan.family,
      retrievalPlanLane: retrievalPlan.lane,
      retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
      retrievalPlanCandidatePools: retrievalPlan.candidatePools,
      retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
      retrievalPlanSubjectNames: retrievalPlan.subjectNames,
      retrievalPlanTargetedFields: retrievalPlan.targetedFields,
      retrievalPlanRequiredFields: retrievalPlan.requiredFields,
      retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
      retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
      retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
      retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
      retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
      retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
      retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
      ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
      suppressionHints: retrievalPlan.suppressionHints,
      shapingPipelineEntered: true,
      supportObjectAttempted: false,
      renderContractAttempted: false,
      bypassReason: "abstention_final_fallback",
      typedValueUsed: false,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected: params.supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      targetedRetrievalAttempted: false,
      targetedRetrievalReason: null,
      targetedFieldsRequested: [],
      targetedRetrievalSatisfied: false,
      supportObjectsBuilt: 0,
      supportObjectType: null,
      supportNormalizationFailures: [],
      renderContractSelected: null,
      renderContractFallbackReason: null,
      subjectBindingStatus: (params.subjectBindingStatus as CanonicalSubjectBindingStatus | undefined) ?? undefined,
      subjectBindingReason: params.subjectBindingReason ?? null,
      temporalEventIdentityStatus: null,
      temporalGranularityStatus: null,
      atomicUnitCount: atomicUnits.length,
      atomicUnitTypes
    };
  }
  if (params.renderedSupport) {
    const selectedFamily =
      effectivePredicateFamily === "temporal_event_fact"
        ? "temporal"
        : effectivePredicateFamily === "list_set" || effectivePredicateFamily === "commonality"
          ? "list_set"
          : effectivePredicateFamily === "profile_state" ||
              effectivePredicateFamily === "relationship_state" ||
              effectivePredicateFamily === "counterfactual" ||
              params.renderedSupport.supportObjectType === "CollectionSetSupport" ||
              params.renderedSupport.supportObjectType === "CollectionInferenceSupport" ||
              params.renderedSupport.supportObjectType === "ProfileInferenceSupport" ||
              params.renderedSupport.supportObjectType === "PreferenceChoiceSupport" ||
              params.renderedSupport.supportObjectType === "CounterfactualCareerSupport"
            ? "report"
            : "exact_detail";
    return {
      ...traceMetadata,
      selectedFamily,
      shapingMode: params.renderedSupport.shapingMode,
      retrievalPlanFamily: retrievalPlan.family,
      retrievalPlanLane: retrievalPlan.lane,
      retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
      retrievalPlanCandidatePools: retrievalPlan.candidatePools,
      retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
      retrievalPlanSubjectNames: retrievalPlan.subjectNames,
      retrievalPlanTargetedFields: retrievalPlan.targetedFields,
      retrievalPlanRequiredFields: retrievalPlan.requiredFields,
      retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
      retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
      retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
      retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
      retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
      retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
      retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
      ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
      suppressionHints: retrievalPlan.suppressionHints,
      shapingPipelineEntered: true,
      supportObjectAttempted: true,
      renderContractAttempted: true,
      bypassReason: null,
      typedValueUsed: params.renderedSupport.typedValueUsed,
      generatedProseUsed: params.renderedSupport.generatedProseUsed,
      runtimeResynthesisUsed: params.renderedSupport.runtimeResynthesisUsed,
      supportRowsSelected: params.renderedSupport.supportRowsSelected,
      supportTextsSelected: params.renderedSupport.supportTextsSelected,
      supportSelectionMode: params.renderedSupport.supportSelectionMode,
      targetedRetrievalAttempted: params.renderedSupport.targetedRetrievalAttempted,
      targetedRetrievalReason: params.renderedSupport.targetedRetrievalReason,
      targetedFieldsRequested: params.renderedSupport.targetedFieldsRequested,
      targetedRetrievalSatisfied: params.renderedSupport.targetedRetrievalSatisfied,
      supportObjectsBuilt: params.renderedSupport.supportObjectsBuilt,
      supportObjectType: params.renderedSupport.supportObjectType,
      supportNormalizationFailures: params.renderedSupport.supportNormalizationFailures,
      renderContractSelected: params.renderedSupport.renderContractSelected,
      renderContractFallbackReason: params.renderedSupport.renderContractFallbackReason,
      subjectBindingStatus: params.renderedSupport.subjectBindingStatus,
      subjectBindingReason: params.renderedSupport.subjectBindingReason,
      temporalEventIdentityStatus: params.renderedSupport.temporalEventIdentityStatus,
      temporalGranularityStatus: params.renderedSupport.temporalGranularityStatus,
      relativeAnchorStatus: params.renderedSupport.relativeAnchorStatus,
      selectedEventKey: params.renderedSupport.selectedEventKey,
      selectedEventType: params.renderedSupport.selectedEventType,
      selectedTimeGranularity: params.renderedSupport.selectedTimeGranularity,
      typedSetEntryCount: params.renderedSupport.typedSetEntryCount,
      typedSetEntryType: params.renderedSupport.typedSetEntryType,
      exactDetailSource: params.renderedSupport.exactDetailSource,
      atomicUnitCount: atomicUnits.length,
      atomicUnitTypes
    };
  }
  if (effectivePredicateFamily === "temporal_event_fact" || params.storedCanonical?.kind === "temporal_fact") {
    return {
      ...traceMetadata,
      selectedFamily: "temporal",
      shapingMode: params.storedCanonical?.eventKey || params.storedCanonical?.timeGranularity ? "typed_temporal_event" : "temporal_text_fallback",
      retrievalPlanFamily: retrievalPlan.family,
      retrievalPlanLane: retrievalPlan.lane,
      retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
      retrievalPlanCandidatePools: retrievalPlan.candidatePools,
      retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
      retrievalPlanSubjectNames: retrievalPlan.subjectNames,
      retrievalPlanTargetedFields: retrievalPlan.targetedFields,
      retrievalPlanRequiredFields: retrievalPlan.requiredFields,
      retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
      retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
      retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
      retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
      retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
      retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
      retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
      ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
      suppressionHints: retrievalPlan.suppressionHints,
      shapingPipelineEntered: false,
      supportObjectAttempted: false,
      renderContractAttempted: false,
      bypassReason: "temporal_support_contract_not_entered",
      typedValueUsed: Boolean(
        params.storedCanonical?.eventKey ||
        params.storedCanonical?.timeGranularity ||
        typeof params.storedCanonical?.answerYear === "number"
      ),
      generatedProseUsed: /\bbetween\b/iu.test(params.finalClaimText),
      runtimeResynthesisUsed: false,
      supportRowsSelected: params.supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      targetedRetrievalAttempted: false,
      targetedRetrievalReason: null,
      targetedFieldsRequested: [],
      targetedRetrievalSatisfied: false,
      supportObjectsBuilt: 0,
      supportObjectType: null,
      supportNormalizationFailures: [],
      renderContractSelected: null,
      renderContractFallbackReason: null,
      subjectBindingStatus: (params.subjectBindingStatus as CanonicalSubjectBindingStatus | undefined) ?? undefined,
      subjectBindingReason: params.subjectBindingReason ?? null,
      temporalEventIdentityStatus: params.storedCanonical?.eventKey ? "resolved" : "missing",
      temporalGranularityStatus: params.storedCanonical?.timeGranularity ?? "unknown",
      selectedEventKey: params.storedCanonical?.eventKey ?? null,
      selectedEventType: params.storedCanonical?.eventType ?? null,
      selectedTimeGranularity: params.storedCanonical?.timeGranularity ?? null,
      atomicUnitCount: atomicUnits.length,
      atomicUnitTypes
    };
  }
  if (effectivePredicateFamily === "list_set" || effectivePredicateFamily === "commonality" || params.storedCanonical?.kind === "set") {
    return {
      ...traceMetadata,
      selectedFamily: "list_set",
      shapingMode: (params.storedCanonical?.typedSetEntryValues?.length ?? 0) > 0 ? "typed_set_entries" : "mixed_string_set",
      retrievalPlanFamily: retrievalPlan.family,
      retrievalPlanLane: retrievalPlan.lane,
      retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
      retrievalPlanCandidatePools: retrievalPlan.candidatePools,
      retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
      retrievalPlanSubjectNames: retrievalPlan.subjectNames,
      retrievalPlanTargetedFields: retrievalPlan.targetedFields,
      retrievalPlanRequiredFields: retrievalPlan.requiredFields,
      retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
      retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
      retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
      retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
      retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
      retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
      retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
      ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
      suppressionHints: retrievalPlan.suppressionHints,
      shapingPipelineEntered: false,
      supportObjectAttempted: false,
      renderContractAttempted: false,
      bypassReason: "list_set_support_contract_not_entered",
      typedValueUsed: (params.storedCanonical?.typedSetEntryValues?.length ?? 0) > 0,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected: params.supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      supportObjectsBuilt: 0,
      supportObjectType: null,
      supportNormalizationFailures: [],
      renderContractSelected: null,
      renderContractFallbackReason: null,
      typedSetEntryCount: params.storedCanonical?.typedSetEntryValues?.length ?? 0,
      typedSetEntryType: params.storedCanonical?.typedSetEntryType ?? null,
      atomicUnitCount: atomicUnits.length,
      atomicUnitTypes
    };
  }
  return {
    ...traceMetadata,
    selectedFamily: "exact_detail",
    shapingMode:
      params.storedCanonical && params.storedCanonical.kind !== "abstention"
        ? "stored_canonical_fact"
        : params.exactDetailCandidateStrongSupport && normalize(params.exactDetailCandidateText)
          ? "support_span_extraction"
          : "stored_canonical_fact",
    retrievalPlanFamily: retrievalPlan.family,
    retrievalPlanLane: retrievalPlan.lane,
    retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
    retrievalPlanCandidatePools: retrievalPlan.candidatePools,
    retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
    retrievalPlanSubjectNames: retrievalPlan.subjectNames,
    retrievalPlanTargetedFields: retrievalPlan.targetedFields,
    retrievalPlanRequiredFields: retrievalPlan.requiredFields,
    retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
    retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
    retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
    retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
    retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
    retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
    retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
    ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
    suppressionHints: retrievalPlan.suppressionHints,
    shapingPipelineEntered: false,
    supportObjectAttempted: false,
    renderContractAttempted: false,
    bypassReason: "direct_detail_contract_not_entered",
    typedValueUsed: Boolean(params.storedCanonical && params.storedCanonical.kind !== "abstention"),
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected: params.supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    supportObjectsBuilt: 0,
    supportObjectType: null,
    supportNormalizationFailures: [],
    renderContractSelected: null,
    renderContractFallbackReason: null,
    atomicUnitCount: atomicUnits.length,
    atomicUnitTypes
  };
}

export function adjudicateCanonicalClaim(input: CanonicalAdjudicationInput): CanonicalAdjudicationResult | null {
  const predicateFamily = inferPredicateFamily(input.queryText, input.exactDetailFamily);
  const strictExactFamilies = new Set([
    "realization",
    "allergy_safe_pets",
    "social_exclusion",
    "hobbies",
    "goals",
    "favorite_books",
    "shop",
    "country",
    "symbolic_gifts",
    "deceased_people",
    "bands",
    "favorite_band",
    "favorite_dj",
    "bird_type",
    "meat_preference",
    "project_type",
    "car",
    "purchased_items",
    "broken_items",
    "plural_names",
    "team",
    "role",
    "advice"
  ]);
  const strictExactFamily = strictExactFamilies.has(input.exactDetailFamily);
  const subjectBinding = resolveCanonicalSubjectBinding({
    queryText: input.queryText,
    results: input.results,
    subjectMatch: input.assessment.subjectMatch,
    matchedParticipants: input.assessment.matchedParticipants,
    missingParticipants: input.assessment.missingParticipants,
    foreignParticipants: input.assessment.foreignParticipants
  });
  const subjectEntityId = subjectBinding.subjectEntityId ?? detectSubjectEntityId(input.results);
  const storedCanonical = input.storedCanonical ?? null;
  const supportStrength = inferSupportStrength(input.assessment.confidence, input.assessment.sufficiency);
  const preferred = canonicalClaimForFamily(input, predicateFamily);
  const claimText = normalize(preferred.claimText);
  const timeScopeKind = inferTimeScopeKind(input.queryText, claimText);
  const abstainReason = inferAbstainReason(input, predicateFamily);
  const validity = inferValidity(input.results);
  const strongExact = Boolean(
    input.exactDetailCandidateStrongSupport &&
    (input.exactDetailCandidatePredicateFit ?? true) &&
    normalize(input.exactDetailCandidateText)
  );
  const storedBindingPromoted = shouldPromoteStoredSubjectBinding({
    queryText: input.queryText,
    storedCanonical,
    canonicalSubjectBindingStatus: storedCanonical?.subjectBindingStatus ?? subjectBinding.status,
    foreignParticipants: input.assessment.foreignParticipants
  });
  const initialCanonicalSubjectBindingStatus = storedBindingPromoted ? "resolved" : storedCanonical?.subjectBindingStatus ?? subjectBinding.status;
  const subjectBindingReasonFromStoredPromotion = storedBindingPromoted
    ? "Stored canonical subject matched the explicit named query anchor."
    : subjectBinding.reason;
  const subjectPlan = buildCanonicalSubjectPlan({
    queryText: input.queryText,
    matchedParticipants: input.assessment.matchedParticipants,
    missingParticipants: input.assessment.missingParticipants,
    foreignParticipants: input.assessment.foreignParticipants,
    subjectEntityId: storedCanonical?.subjectEntityId ?? subjectEntityId,
    canonicalSubjectName: storedCanonical?.canonicalSubjectName ?? subjectBinding.canonicalName,
    pairSubjectEntityId: storedCanonical?.pairSubjectEntityId ?? null,
    pairSubjectName: storedCanonical?.pairSubjectName ?? null,
    bindingStatus: initialCanonicalSubjectBindingStatus,
    candidateEntityIds: subjectBinding.candidateEntityIds,
    candidateNames: subjectBinding.candidateNames
  });
  const subjectPlanPromoted =
    initialCanonicalSubjectBindingStatus !== "resolved" &&
    subjectPlan.kind === "single_subject" &&
    Boolean(subjectPlan.canonicalSubjectName) &&
    input.assessment.foreignParticipants.length === 0;
  const temporalSubjectBindingPromoted = shouldPromoteExplicitTemporalSubjectBinding({
    queryText: input.queryText,
    predicateFamily,
    canonicalSubjectBindingStatus: initialCanonicalSubjectBindingStatus,
    subjectPlan
  });
  const explicitSingleSubjectBindingPromoted = shouldPromoteExplicitSingleSubjectBinding({
    queryText: input.queryText,
    predicateFamily,
    canonicalSubjectBindingStatus: initialCanonicalSubjectBindingStatus,
    subjectPlan
  });
  const canonicalSubjectBindingStatus =
    subjectPlanPromoted || temporalSubjectBindingPromoted || explicitSingleSubjectBindingPromoted
      ? "resolved"
      : initialCanonicalSubjectBindingStatus;
  const effectiveSubjectBindingReason = subjectPlanPromoted
    ? subjectPlan.reason
    : temporalSubjectBindingPromoted
      ? `Explicit temporal subject anchor ${subjectPlan.canonicalSubjectName} promoted binding before temporal shaping.`
      : explicitSingleSubjectBindingPromoted
        ? `Explicit subject anchor ${subjectPlan.canonicalSubjectName} promoted binding before ${predicateFamily} shaping.`
      : subjectBindingReasonFromStoredPromotion;
  const storedClaimText =
    storedCanonical?.kind === "set"
      ? normalize(
          renderStoredCanonicalSetValues(
            storedCanonical.predicateFamily,
            (storedCanonical.typedSetEntryValues?.length ?? 0) > 0
              ? storedCanonical.typedSetEntryValues ?? []
              : storedCanonical.objectValues ?? [],
            subjectPlan.kind === "pair_subject"
          )
        )
      : normalize(storedCanonical?.objectValue);
  const preferDerivedClaimOverStored =
    Boolean(claimText) &&
    (
      shouldPreferDerivedTemporalOverStored({
        claimText,
        storedCanonical
      }) ||
      (storedCanonical?.kind === "set" && predicateFamily === "commonality")
    );
  const strongStoredCanonical =
    storedCanonical !== null &&
    storedCanonical.kind !== "abstention" &&
    storedClaimText.length > 0;
  const requiresResolvedSubject = requiresResolvedSubjectBinding(input.queryText, predicateFamily, input.exactDetailFamily);
  const subjectPlanResolved =
    subjectPlan.kind === "single_subject" ||
    subjectPlan.kind === "pair_subject";
  const unresolvedStoredSubject =
    storedCanonical !== null &&
    requiresResolvedSubject &&
    !subjectPlanResolved &&
    canonicalSubjectBindingStatus === "unresolved";
  const strongCanonicalClaim = claimText.length > 0 && claimText !== normalize(input.abstentionClaimText);
  const subjectBindingMissing =
    (!subjectPlanResolved && canonicalSubjectBindingStatus === "ambiguous") ||
    (!subjectPlanResolved &&
      canonicalSubjectBindingStatus !== "resolved" &&
      (input.assessment.subjectMatch === "mixed" || input.assessment.subjectMatch === "mismatched"));
  const shouldUseCanonicalPath =
    (strongStoredCanonical && !unresolvedStoredSubject) ||
    storedCanonical?.kind === "abstention" ||
    unresolvedStoredSubject ||
    strongCanonicalClaim ||
    strongExact ||
    strictExactFamily ||
    predicateFamily === "ownership_binding" ||
    subjectBindingMissing ||
    (predicateFamily === "counterfactual" && input.assessment.sufficiency !== "supported");
  if (!shouldUseCanonicalPath) {
    return null;
  }
  const shouldAbstain =
    storedCanonical?.kind === "abstention" ||
    (unresolvedStoredSubject && !strongCanonicalClaim) ||
    !strongCanonicalClaim &&
    (
      subjectBindingMissing ||
      (strictExactFamily && input.assessment.sufficiency !== "supported") ||
      predicateFamily === "ownership_binding" ||
      predicateFamily === "counterfactual" ||
      (predicateFamily === "profile_state" && input.assessment.sufficiency === "contradicted")
    ) &&
    !strongExact;
  const effectiveAbstainReason =
    unresolvedStoredSubject
      ? "insufficient_subject_binding"
      : abstainReason;
  const shouldAttemptInferentialReportRescue =
    shouldAbstain &&
    (
      predicateFamily === "profile_state" ||
      predicateFamily === "relationship_state" ||
      predicateFamily === "counterfactual" ||
      predicateFamily === "narrative_profile" ||
      storedCanonical?.kind === "report" ||
      Boolean(storedCanonical?.reportKind) ||
      isCanonicalCollectionQuery(input.queryText)
    );
  const abstentionRescueSupport =
    shouldAttemptInferentialReportRescue
      ? renderCanonicalReportSupport({
          queryText: input.queryText,
          predicateFamily,
          storedCanonical,
          fallbackSummary: normalize(claimText) || normalize(input.abstentionClaimText),
          results: input.results
        })
      : null;

  const bundle = {
    subjectEntityId: storedCanonical?.subjectEntityId ?? subjectEntityId,
    canonicalSubjectName: storedCanonical?.canonicalSubjectName ?? subjectBinding.canonicalName,
    subjectBindingStatus: canonicalSubjectBindingStatus,
    subjectPlan,
    pairGraphPlan: storedCanonical?.pairGraphPlan ?? null,
    predicateFamily: storedCanonical?.predicateFamily ?? predicateFamily,
    provenanceRows: input.results,
    evidenceItems: input.evidence,
    supportStrength: storedCanonical?.supportStrength ?? supportStrength,
    timeScopeKind: storedCanonical?.timeScopeKind ?? timeScopeKind,
    canonicalReadTier: storedCanonical ? "canonical_graph" : shouldAbstain ? "structured_abstention" : "episodic_fallback",
    temporalValidity: inferTemporalValidityWindow({
      storedCanonical,
      claimText,
      timeScopeKind: storedCanonical?.timeScopeKind ?? timeScopeKind,
      validFrom: storedCanonical?.validFrom ?? validity.validFrom,
      validUntil: storedCanonical?.validUntil ?? validity.validUntil
    }),
    ownerSourceTable: storedCanonical?.sourceTable ?? (shouldAbstain ? "runtime_abstention" : "runtime_adjudication")
  } as const;

  if (shouldAbstain && !abstentionRescueSupport?.claimText) {
    const abstainBundle = {
      topClaim: normalize(input.abstentionClaimText) || "Unknown.",
      claimKind: "abstention" as const,
      subjectPlan: bundle.subjectPlan,
      predicatePlan: bundle.predicateFamily,
      timePlan: bundle.temporalValidity,
      evidenceBundle: input.evidence,
      fallbackBlockedReason: "canonical_abstention",
      reasoningChain: buildReasoningChain({
        queryText: input.queryText,
        predicateFamily: bundle.predicateFamily,
        timeScopeKind: bundle.timeScopeKind,
        topClaim: normalize(input.abstentionClaimText) || "Unknown.",
        subjectNames: bundle.subjectPlan.kind === "pair_subject"
          ? [bundle.subjectPlan.canonicalSubjectName ?? "", bundle.subjectPlan.pairSubjectName ?? ""]
          : [bundle.subjectPlan.canonicalSubjectName ?? ""],
        results: input.results,
        canonicalSupport: [
          bundle.predicateFamily,
          bundle.supportStrength,
          storedCanonical?.sourceTable ?? "runtime_adjudication"
        ],
        abstainReason: storedCanonical?.abstainReason ?? effectiveAbstainReason,
        exclusionClauses: ["snippet_override_blocked"]
      })
    };
    return {
      bundle,
      canonical: {
        kind: "abstention",
        subjectEntityId: bundle.subjectEntityId,
        canonicalSubjectName: bundle.canonicalSubjectName,
        predicateFamily: bundle.predicateFamily,
        abstainReason: storedCanonical?.abstainReason ?? effectiveAbstainReason,
        timeScopeKind: bundle.timeScopeKind,
        provenanceRows: input.results,
        supportStrength: bundle.supportStrength,
        confidence: storedCanonical?.confidence ?? input.assessment.confidence,
        status: "abstained",
        validFrom: storedCanonical?.validFrom ?? validity.validFrom,
        validUntil: storedCanonical?.validUntil ?? validity.validUntil
      },
      formatted: {
        claimText: abstainBundle.topClaim,
        finalClaimSource: "canonical_abstention",
        answerBundle: abstainBundle,
        shapingTrace: buildCanonicalShapingTrace({
          queryText: input.queryText,
          results: input.results,
          predicateFamily,
          storedCanonical,
          subjectBindingStatus: canonicalSubjectBindingStatus,
          subjectBindingReason: effectiveSubjectBindingReason,
          exactDetailCandidateText: input.exactDetailCandidateText,
          exactDetailCandidateStrongSupport: input.exactDetailCandidateStrongSupport,
          finalClaimText: abstainBundle.topClaim,
          supportRowsSelected: input.results.length,
          shouldAbstain: true,
          finalClaimSource: "canonical_abstention",
          preferDerivedTemporalOverStored: preferDerivedClaimOverStored,
          earlyExitReason: "canonical_abstention",
          renderedSupport: null
        })
      }
    };
  }

  const preferredFinalClaimText =
    normalize(abstentionRescueSupport?.claimText) ||
    (strongStoredCanonical && !preferDerivedClaimOverStored
      ? storedClaimText
      : strongCanonicalClaim
        ? claimText
        : normalize(input.exactDetailCandidateText));
  if (!preferredFinalClaimText) {
    return null;
  }
  const listSetSupport =
    (predicateFamily === "list_set" || predicateFamily === "commonality" || storedCanonical?.kind === "set")
      ? buildListSetSupport({
          queryText: input.queryText,
          predicateFamily,
          results: input.results,
          storedCanonical,
          finalClaimText: preferredFinalClaimText,
          subjectPlan
        })
      : null;
  const storedCanonicalHasTypedSetEntries =
    storedCanonical?.kind === "set" && (storedCanonical.typedSetEntryValues?.length ?? 0) > 0;
  const preferStoredCanonicalSetText =
    storedCanonical?.kind === "set" &&
    !storedCanonicalHasTypedSetEntries &&
    (listSetSupport?.typedEntries.length ?? 0) === 0 &&
    Boolean(storedClaimText);
  const renderPlan = buildAnswerRetrievalPlan({
    queryText: input.queryText,
    predicateFamily,
    reportKind: storedCanonical?.reportKind,
    subjectEntityHints: input.results
      .map((result) => {
        const subjectEntityId = result.provenance.subject_entity_id;
        return typeof subjectEntityId === "string" && subjectEntityId.trim() ? subjectEntityId.trim() : null;
      })
      .filter((value): value is string => Boolean(value))
  });
  const shouldUseTemporalRenderContract =
    renderPlan.family === "temporal" &&
    (predicateFamily === "temporal_event_fact" || storedCanonical?.kind === "temporal_fact");
  const temporalSupport =
    shouldUseTemporalRenderContract
      ? buildTemporalEventSupport({
          queryText: input.queryText,
          storedCanonical,
          fallbackClaimText: preferredFinalClaimText,
          results: input.results,
          subjectBindingStatus: canonicalSubjectBindingStatus,
          subjectBindingReason: effectiveSubjectBindingReason
        })
      : null;
  const renderedTemporalSupport =
    temporalSupport
      ? renderTemporalEventSupport(
          input.queryText,
          temporalSupport,
          input.results.length
        )
      : null;
  const preferredTemporalDirectRender =
    shouldUseTemporalRenderContract &&
    preferred.source === "canonical_temporal" &&
    normalize(input.derived.temporal) === preferredFinalClaimText &&
    !requiresTypedTemporalSupportContract(preferredFinalClaimText) &&
    !shouldPreferTypedTemporalSupportContract({
      directClaimText: preferredFinalClaimText,
      renderedSupport: renderedTemporalSupport
    }) &&
    (
      preferDerivedClaimOverStored ||
      /\bbetween\b/iu.test(preferredFinalClaimText) ||
      /\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/u.test(preferredFinalClaimText)
    );
  const shouldUseListSetSupportRenderContract =
    !preferStoredCanonicalSetText &&
    !preferredTemporalDirectRender &&
    !shouldUseTemporalRenderContract &&
    shouldUseListSetRenderContractPolicy({
      predicateFamily,
      storedCanonical,
      listSetEntryCount: (listSetSupport?.typedEntries.length ?? 0) + (listSetSupport?.fallbackEntries.length ?? 0)
    });
  const shouldUseReportRenderContract =
    !preferStoredCanonicalSetText &&
    !preferredTemporalDirectRender &&
    !shouldUseTemporalRenderContract &&
    !shouldUseListSetSupportRenderContract &&
    (
      renderPlan.family === "report" ||
      predicateFamily === "profile_state" ||
      predicateFamily === "relationship_state" ||
      predicateFamily === "counterfactual" ||
      storedCanonical?.kind === "report" ||
      Boolean(storedCanonical?.reportKind)
    );
  const shouldUseDirectDetailRenderContract =
    !preferStoredCanonicalSetText &&
    !preferredTemporalDirectRender &&
    !shouldUseTemporalRenderContract &&
    !shouldUseListSetSupportRenderContract &&
    !shouldUseReportRenderContract &&
    (
      preferred.source === "canonical_exact_detail" ||
      (storedCanonical?.kind === "fact" && predicateFamily !== "profile_state")
    );
  const promotedExactDetailCandidate = derivePromotedExactDetailSupportCandidate(input);
  const renderedSupport =
    abstentionRescueSupport
      ? abstentionRescueSupport
      : preferredTemporalDirectRender
        ? null
      : shouldUseTemporalRenderContract
      ? renderedTemporalSupport
      : shouldUseListSetSupportRenderContract && listSetSupport
        ? renderListSetSupport(listSetSupport, input.results.length)
        : shouldUseReportRenderContract
          ? renderCanonicalReportSupport({
              queryText: input.queryText,
              predicateFamily,
              storedCanonical,
              fallbackSummary: preferredFinalClaimText,
              results: input.results
            })
      : shouldUseDirectDetailRenderContract
          ? renderDirectDetailSupport(
            buildDirectDetailSupport({
              finalClaimText: preferredFinalClaimText,
              exactDetailCandidate: promotedExactDetailCandidate
            }),
            input.results.length
          )
          : null;
  const finalClaimText =
    preferredTemporalDirectRender
      ? normalizeDerivedTemporalDirectClaim(preferredFinalClaimText)
      : normalize(renderedSupport?.claimText) || preferredFinalClaimText;
  const renderedCanonicalSource = inferCanonicalSourceFromRenderedSupport({
    predicateFamily,
    renderedSupport
  });

  const canonicalKind =
    storedCanonical?.kind ??
    (predicateFamily === "temporal_event_fact"
      ? "temporal_fact"
      : predicateFamily === "list_set" || predicateFamily === "commonality"
        ? "set"
        : predicateFamily === "profile_state" || predicateFamily === "relationship_state"
          ? "state"
        : "fact");
  const claimKindCanonicalKind = canonicalKind === "abstention" ? "fact" : canonicalKind;
  const answerBundle: CanonicalAnswerBundle = {
    topClaim: finalClaimText,
    claimKind: inferClaimKind(predicateFamily, false, claimKindCanonicalKind),
    subjectPlan: bundle.subjectPlan,
    predicatePlan: bundle.predicateFamily,
    timePlan: bundle.temporalValidity,
    evidenceBundle: input.evidence,
    fallbackBlockedReason: storedCanonical ? "canonical_graph_precedence" : strongCanonicalClaim ? "runtime_canonical_precedence" : null,
    reasoningChain: buildReasoningChain({
      queryText: input.queryText,
      predicateFamily: bundle.predicateFamily,
      timeScopeKind: bundle.timeScopeKind,
      topClaim: finalClaimText,
      subjectNames: bundle.subjectPlan.kind === "pair_subject"
        ? [bundle.subjectPlan.canonicalSubjectName ?? "", bundle.subjectPlan.pairSubjectName ?? ""]
        : [bundle.subjectPlan.canonicalSubjectName ?? ""],
      results: input.results,
      canonicalSupport: [
        bundle.predicateFamily,
        bundle.supportStrength,
        storedCanonical?.sourceTable ?? "runtime_adjudication",
        ...(bundle.pairGraphPlan?.relationshipJoinKinds ?? [])
      ],
      exclusionClauses: [
        "top_snippet_blocked",
        ...(bundle.pairGraphPlan?.pairPlanUsed ? ["foreign_subjects_excluded"] : [])
      ]
    })
  };
  const finalClaimSource =
    renderedCanonicalSource ??
    (storedCanonical
      ? storedCanonical.kind === "temporal_fact"
        ? "canonical_temporal"
        : storedCanonical.kind === "state"
          ? "canonical_profile"
          : storedCanonical.kind === "set"
            ? "canonical_list_set"
            : storedCanonical.kind === "abstention"
              ? renderedSupport?.supportObjectType === "ListSetSupport"
                ? "canonical_list_set"
                : renderedSupport?.supportObjectType === "CollectionSetSupport" ||
                    renderedSupport?.supportObjectType === "CollectionInferenceSupport" ||
                    renderedSupport?.supportObjectType === "ProfileInferenceSupport" ||
                    renderedSupport?.supportObjectType === "PreferenceChoiceSupport" ||
                    renderedSupport?.supportObjectType === "CounterfactualCareerSupport"
                  ? predicateFamily === "counterfactual"
                    ? "canonical_counterfactual"
                    : "canonical_profile"
                  : "canonical_generic"
              : "canonical_exact_detail"
      : preferred.source === "canonical_abstention"
        ? predicateFamily === "temporal_event_fact"
          ? "canonical_temporal"
          : predicateFamily === "commonality"
            ? "canonical_commonality"
            : predicateFamily === "profile_state"
              ? "canonical_profile"
              : predicateFamily === "counterfactual"
                ? "canonical_counterfactual"
                : "canonical_generic"
        : preferred.source);

  return {
    bundle,
      canonical:
      canonicalKind === "state"
        ? {
            kind: "state",
            subjectEntityId: bundle.subjectEntityId,
            canonicalSubjectName: bundle.canonicalSubjectName,
            predicateFamily: bundle.predicateFamily,
            objectValue: finalClaimText,
            timeScopeKind: bundle.timeScopeKind,
            provenanceRows: input.results,
            supportStrength: bundle.supportStrength,
            confidence: storedCanonical?.confidence ?? input.assessment.confidence,
            status: "supported",
            validFrom: storedCanonical?.validFrom ?? validity.validFrom,
            validUntil: storedCanonical?.validUntil ?? validity.validUntil
          }
        : canonicalKind === "temporal_fact"
          ? {
              kind: "temporal_fact",
              subjectEntityId: bundle.subjectEntityId,
              canonicalSubjectName: bundle.canonicalSubjectName,
              predicateFamily: bundle.predicateFamily,
              objectValue: finalClaimText,
              anchorText:
                storedCanonical?.kind === "temporal_fact"
                  ? storedCanonical.objectValue ?? finalClaimText
                  : bundle.timeScopeKind === "anchored_relative" || bundle.timeScopeKind === "range"
                    ? finalClaimText
                    : null,
              timeScopeKind: bundle.timeScopeKind,
              provenanceRows: input.results,
              supportStrength: bundle.supportStrength,
              confidence: storedCanonical?.confidence ?? input.assessment.confidence,
              status: "supported",
              validFrom: storedCanonical?.validFrom ?? validity.validFrom,
              validUntil: storedCanonical?.validUntil ?? validity.validUntil
            }
          : canonicalKind === "set"
            ? {
                kind: "set",
                subjectEntityId: bundle.subjectEntityId,
                canonicalSubjectName: bundle.canonicalSubjectName,
                predicateFamily: bundle.predicateFamily,
                objectValues: storedCanonical?.kind === "set" ? (storedCanonical.objectValues ?? parseCanonicalSetValues(finalClaimText)) : parseCanonicalSetValues(finalClaimText),
                timeScopeKind: bundle.timeScopeKind,
                provenanceRows: input.results,
                supportStrength: bundle.supportStrength,
                confidence: storedCanonical?.confidence ?? input.assessment.confidence,
                status: "supported",
                validFrom: storedCanonical?.validFrom ?? validity.validFrom,
                validUntil: storedCanonical?.validUntil ?? validity.validUntil
              }
        : {
            kind: "fact",
            subjectEntityId: bundle.subjectEntityId,
            canonicalSubjectName: bundle.canonicalSubjectName,
            predicateFamily: bundle.predicateFamily,
            objectValue: finalClaimText,
            timeScopeKind: bundle.timeScopeKind,
            provenanceRows: input.results,
            supportStrength: bundle.supportStrength,
            confidence: storedCanonical?.confidence ?? input.assessment.confidence,
            status: "supported",
            validFrom: storedCanonical?.validFrom ?? validity.validFrom,
            validUntil: storedCanonical?.validUntil ?? validity.validUntil
          },
      formatted: {
        claimText: finalClaimText,
        finalClaimSource,
      answerBundle,
      shapingTrace: buildCanonicalShapingTrace({
        queryText: input.queryText,
        results: input.results,
        predicateFamily,
        storedCanonical,
        subjectBindingStatus: canonicalSubjectBindingStatus,
        subjectBindingReason: effectiveSubjectBindingReason,
        exactDetailCandidateText: input.exactDetailCandidateText,
        exactDetailCandidateStrongSupport: input.exactDetailCandidateStrongSupport,
        finalClaimText,
        supportRowsSelected: input.results.length,
        shouldAbstain: false,
        finalClaimSource,
        preferDerivedTemporalOverStored: preferDerivedClaimOverStored,
        earlyExitReason:
          preferredTemporalDirectRender
            ? "direct_temporal_claim_selected"
            : shouldUseListSetSupportRenderContract
              ? "structured_set_selected"
              : shouldUseReportRenderContract
                ? "structured_report_selected"
                : shouldUseDirectDetailRenderContract
                  ? "direct_detail_selected"
                  : null,
        renderedSupport
      })
    }
  };
}

export function runCanonicalAdjudication(input: CanonicalAdjudicationRequest): CanonicalAdjudicationResult | null {
  return adjudicateCanonicalClaim(input as CanonicalAdjudicationInput);
}

function buildRuntimeExactDetailShapingTrace(
  family: AnswerShapingTrace["selectedFamily"],
  exactDetailCandidate: ExactDetailClaimCandidate | null | undefined,
  supportRowsSelected: number
): AnswerShapingTrace {
  const rendered = renderDirectDetailSupport(
    buildDirectDetailSupport({
      finalClaimText: exactDetailCandidate?.text ?? null,
      exactDetailCandidate: exactDetailCandidate ?? null
    }),
    supportRowsSelected
  );
  return {
    selectedFamily: family,
    shapingMode: rendered.shapingMode,
    shapingPipelineEntered: true,
    supportObjectAttempted: true,
    renderContractAttempted: true,
    bypassReason: null,
    typedValueUsed: rendered.typedValueUsed,
    generatedProseUsed: rendered.generatedProseUsed,
    runtimeResynthesisUsed: rendered.runtimeResynthesisUsed,
    supportRowsSelected: rendered.supportRowsSelected,
    supportTextsSelected: rendered.supportTextsSelected,
    supportSelectionMode: rendered.supportSelectionMode,
    supportObjectsBuilt: rendered.supportObjectsBuilt,
    supportObjectType: rendered.supportObjectType,
    supportNormalizationFailures: rendered.supportNormalizationFailures,
    renderContractSelected: rendered.renderContractSelected,
    renderContractFallbackReason: rendered.renderContractFallbackReason,
    exactDetailSource: rendered.exactDetailSource
  };
}

export function effectiveCanonicalFinalClaimSource(params: {
  readonly winner: string | null | undefined;
  readonly canonicalAdjudication: CanonicalAdjudicationResult | null;
}): string | undefined {
  const canonicalSource = params.canonicalAdjudication?.formatted.finalClaimSource;
  const shapingTrace = params.canonicalAdjudication?.formatted.shapingTrace;
  if (!canonicalSource) {
    return undefined;
  }
  if (params.winner === "canonical_report" && shapingTrace?.selectedFamily === "report") {
    if (shapingTrace.supportObjectType === "CounterfactualCareerSupport") {
      return "canonical_counterfactual";
    }
    if (
      shapingTrace.supportObjectType === "CollectionSetSupport" ||
      shapingTrace.supportObjectType === "CollectionInferenceSupport" ||
      shapingTrace.supportObjectType === "ProfileInferenceSupport" ||
      shapingTrace.supportObjectType === "PreferenceChoiceSupport"
    ) {
      return "canonical_profile";
    }
    return "canonical_report";
  }
  if (params.winner === "canonical_list_set" && shapingTrace?.selectedFamily === "list_set") {
    return "canonical_list_set";
  }
  if (params.winner === "canonical_temporal" && shapingTrace?.selectedFamily === "temporal") {
    return "canonical_temporal";
  }
  return canonicalSource;
}

export function shouldSuppressGenericFallbackAfterOwnerResolution(params: {
  readonly winner: string | null | undefined;
  readonly suppressedOwners: readonly { readonly owner: string; readonly reason?: string | null }[] | null | undefined;
}): boolean {
  if (params.winner) {
    return false;
  }
  return (params.suppressedOwners ?? []).some(
    (entry) => entry.owner === "top_snippet" && entry.reason === "planner_typed_lane_incomplete"
  );
}

export function resolveAnswerShapingTrace(params: {
  readonly family: AnswerShapingTrace["selectedFamily"];
  readonly winner: string | null | undefined;
  readonly canonicalAdjudication: CanonicalAdjudicationResult | null;
  readonly narrativeAdjudication: CanonicalAdjudicationResult | null;
  readonly runtimeRetrievalPlan?: AnswerRetrievalPlan | null;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
  readonly supportRowsSelected: number;
  readonly claimText?: string | null;
  readonly plannerTargetedBackfillApplied?: boolean;
  readonly plannerTargetedBackfillReason?: string;
  readonly plannerTargetedBackfillSubqueries?: readonly string[];
  readonly plannerTargetedBackfillSatisfied?: boolean;
}): AnswerShapingTrace {
  const plannerTraceContext =
    params.canonicalAdjudication?.formatted.shapingTrace ?? params.narrativeAdjudication?.formatted.shapingTrace ?? null;
  const withPlannerTraceContext = (trace: AnswerShapingTrace): AnswerShapingTrace => ({
    ...trace,
    retrievalPlanFamily:
      trace.retrievalPlanFamily ?? plannerTraceContext?.retrievalPlanFamily ?? params.runtimeRetrievalPlan?.family,
    retrievalPlanLane:
      trace.retrievalPlanLane ?? plannerTraceContext?.retrievalPlanLane ?? params.runtimeRetrievalPlan?.lane,
    retrievalPlanResolvedSubjectEntityId:
      trace.retrievalPlanResolvedSubjectEntityId ??
      plannerTraceContext?.retrievalPlanResolvedSubjectEntityId ??
      params.runtimeRetrievalPlan?.resolvedSubjectEntityId,
    retrievalPlanCandidatePools:
      trace.retrievalPlanCandidatePools ?? plannerTraceContext?.retrievalPlanCandidatePools ?? params.runtimeRetrievalPlan?.candidatePools,
    retrievalPlanSuppressionPools:
      trace.retrievalPlanSuppressionPools ?? plannerTraceContext?.retrievalPlanSuppressionPools ?? params.runtimeRetrievalPlan?.suppressionPools,
    retrievalPlanRequiredFields:
      trace.retrievalPlanRequiredFields ?? plannerTraceContext?.retrievalPlanRequiredFields ?? params.runtimeRetrievalPlan?.requiredFields,
    retrievalPlanTargetedBackfill:
      trace.retrievalPlanTargetedBackfill ?? plannerTraceContext?.retrievalPlanTargetedBackfill ?? params.runtimeRetrievalPlan?.targetedBackfill,
    retrievalPlanTargetedBackfillRequests:
      trace.retrievalPlanTargetedBackfillRequests ??
      plannerTraceContext?.retrievalPlanTargetedBackfillRequests ??
      params.runtimeRetrievalPlan?.targetedBackfillRequests,
    retrievalPlanQueryExpansionTerms:
      trace.retrievalPlanQueryExpansionTerms ??
      plannerTraceContext?.retrievalPlanQueryExpansionTerms ??
      params.runtimeRetrievalPlan?.queryExpansionTerms,
    retrievalPlanBannedExpansionTerms:
      trace.retrievalPlanBannedExpansionTerms ??
      plannerTraceContext?.retrievalPlanBannedExpansionTerms ??
      params.runtimeRetrievalPlan?.bannedExpansionTerms,
    retrievalPlanFamilyConfidence:
      trace.retrievalPlanFamilyConfidence ??
      plannerTraceContext?.retrievalPlanFamilyConfidence ??
      params.runtimeRetrievalPlan?.familyConfidence,
    retrievalPlanSupportCompletenessTarget:
      trace.retrievalPlanSupportCompletenessTarget ??
      plannerTraceContext?.retrievalPlanSupportCompletenessTarget ??
      params.runtimeRetrievalPlan?.supportCompletenessTarget,
    retrievalPlanRescuePolicy:
      trace.retrievalPlanRescuePolicy ?? plannerTraceContext?.retrievalPlanRescuePolicy ?? params.runtimeRetrievalPlan?.rescuePolicy,
    ownerEligibilityHints:
      trace.ownerEligibilityHints ?? plannerTraceContext?.ownerEligibilityHints ?? params.runtimeRetrievalPlan?.ownerEligibilityHints,
    suppressionHints:
      trace.suppressionHints ?? plannerTraceContext?.suppressionHints ?? params.runtimeRetrievalPlan?.suppressionHints,
    plannerTargetedBackfillApplied:
      trace.plannerTargetedBackfillApplied === true || params.plannerTargetedBackfillApplied === true
        ? true
        : trace.plannerTargetedBackfillApplied ?? params.plannerTargetedBackfillApplied,
    plannerTargetedBackfillReason:
      trace.plannerTargetedBackfillReason ?? params.plannerTargetedBackfillReason,
    plannerTargetedBackfillSubqueries:
      trace.plannerTargetedBackfillSubqueries ?? params.plannerTargetedBackfillSubqueries,
    plannerTargetedBackfillSatisfied:
      trace.plannerTargetedBackfillSatisfied === true || params.plannerTargetedBackfillSatisfied === true
        ? true
        : trace.plannerTargetedBackfillSatisfied ?? params.plannerTargetedBackfillSatisfied
  });
  if (params.winner === "canonical_report" || params.winner === "canonical_narrative") {
    const canonicalReportTrace =
      params.canonicalAdjudication?.formatted.finalClaimSource === "canonical_profile" ||
      params.canonicalAdjudication?.formatted.finalClaimSource === "canonical_counterfactual" ||
      params.canonicalAdjudication?.formatted.finalClaimSource === "canonical_report" ||
      params.canonicalAdjudication?.formatted.shapingTrace?.selectedFamily === "report"
        ? params.canonicalAdjudication.formatted.shapingTrace
        : null;
    return canonicalReportTrace ?? params.narrativeAdjudication?.formatted.shapingTrace ?? withPlannerTraceContext({
      selectedFamily: "report",
      shapingMode: "stored_report_summary",
      shapingPipelineEntered: false,
      supportObjectAttempted: false,
      renderContractAttempted: false,
      bypassReason: "report_render_contract_not_entered",
      typedValueUsed: false,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected: params.supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      supportObjectsBuilt: 0,
      supportObjectType: null,
      supportNormalizationFailures: [],
      renderContractSelected: null,
      renderContractFallbackReason: null
    });
  }
  if (
    params.winner === "canonical_temporal" ||
    params.winner === "canonical_list_set" ||
    params.winner === "canonical_exact_detail" ||
    params.winner === "canonical_abstention"
  ) {
    return params.canonicalAdjudication?.formatted.shapingTrace ?? withPlannerTraceContext({
      selectedFamily: params.family,
      shapingMode: params.winner === "canonical_abstention" ? "abstention" : "stored_canonical_fact",
      shapingPipelineEntered: false,
      supportObjectAttempted: false,
      renderContractAttempted: false,
      bypassReason:
        params.winner === "canonical_temporal"
          ? "temporal_support_contract_not_entered"
          : params.winner === "canonical_list_set"
            ? "list_set_support_contract_not_entered"
            : params.winner === "canonical_exact_detail"
              ? "direct_detail_contract_not_entered"
              : "abstention_final_fallback",
      typedValueUsed: false,
      generatedProseUsed: false,
      runtimeResynthesisUsed: false,
      supportRowsSelected: params.supportRowsSelected,
      supportTextsSelected: 0,
      supportSelectionMode: null,
      supportObjectsBuilt: 0,
      supportObjectType: null,
      supportNormalizationFailures: [],
      renderContractSelected: null,
      renderContractFallbackReason: null
    });
  }
  if (params.winner === "runtime_exact_detail") {
    return withPlannerTraceContext(
      buildRuntimeExactDetailShapingTrace(params.family, params.exactDetailCandidate, params.supportRowsSelected)
    );
  }
  if (params.winner === "top_snippet") {
    const rendered = renderSnippetFactSupport(
      buildSnippetFactSupport({
        finalClaimText: params.claimText ?? null
      }),
      params.supportRowsSelected
    );
    return withPlannerTraceContext({
      selectedFamily: params.family,
      shapingMode: rendered.shapingMode,
      shapingPipelineEntered: true,
      supportObjectAttempted: true,
      renderContractAttempted: true,
      bypassReason: null,
      targetedRetrievalAttempted: rendered.targetedRetrievalAttempted,
      targetedRetrievalReason: rendered.targetedRetrievalReason,
      typedValueUsed: rendered.typedValueUsed,
      generatedProseUsed: rendered.generatedProseUsed,
      runtimeResynthesisUsed: rendered.runtimeResynthesisUsed,
      supportRowsSelected: rendered.supportRowsSelected,
      supportTextsSelected: rendered.supportTextsSelected,
      supportSelectionMode: rendered.supportSelectionMode,
      supportObjectsBuilt: rendered.supportObjectsBuilt,
      supportObjectType: rendered.supportObjectType,
      supportNormalizationFailures: rendered.supportNormalizationFailures,
      renderContractSelected: rendered.renderContractSelected,
      renderContractFallbackReason: rendered.renderContractFallbackReason
    });
  }
  return withPlannerTraceContext({
    selectedFamily: params.family,
    shapingMode: "stored_canonical_fact",
    shapingPipelineEntered: false,
    supportObjectAttempted: false,
    renderContractAttempted: false,
    bypassReason: "generic_shaping_pipeline_not_entered",
    typedValueUsed: false,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected: params.supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    supportObjectsBuilt: 0,
    supportObjectType: null,
    supportNormalizationFailures: [],
    renderContractSelected: null,
    renderContractFallbackReason: null
  });
}
