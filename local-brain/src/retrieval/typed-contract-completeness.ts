import {
  inferCampingLocationCompletenessTarget,
} from "./location-history/camping.js";
import {
  evaluateIdentityProfileContractCompleteness,
  evaluateProfileTraitJudgmentCompleteness,
  evaluateReasonedProfileJudgmentCompleteness,
  evaluateScalarProfileContractCompleteness
} from "./profile-contracts.js";
import {
  inferActivityCompletenessTarget,
  inferSupportNetworkCompletenessTarget,
  inferPreferenceProfileValues
} from "./typed-support-extractors.js";
import {
  buildListSetSupport,
} from "./support-objects.js";
import {
  inferTypedContractRequiredField,
  resolveTypedContractFromPlan
} from "./typed-contract-registry.js";
import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import { hasSelfOwnedExactDetailOwnershipSupport } from "./self-owned-exact-detail.js";
import type { RecallResult } from "../types.js";
import type {
  AnswerRetrievalPlan,
  RecallResponse,
  SubjectPlan,
  TypedContractCompleteness,
  TypedContractName
} from "./types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isFirstPersonQueryText(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
}

function resultHasFirstPersonOwnershipCue(result: RecallResult): boolean {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const directSignals = [
    result.provenance.subject_name,
    result.provenance.speaker_name,
    result.provenance.transcript_speaker_name,
    metadata?.subject_name,
    metadata?.speaker_name,
    metadata?.primary_speaker_name
  ]
    .map((value) => (typeof value === "string" ? normalize(value).toLowerCase() : ""))
    .filter(Boolean);
  if (
    directSignals.some((signal) =>
      signal === "self" ||
      signal === "owner" ||
      signal.startsWith("self:") ||
      signal.startsWith("owner:")
    )
  ) {
    return true;
  }
  const sourceTexts = [
    result.content,
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : null,
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : null,
    typeof metadata?.full_source_text === "string" ? metadata.full_source_text : null
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return sourceTexts.some((text) =>
    /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(text)
  );
}

function hasSelfOwnedExactDetailSupport(queryText: string, results: readonly RecallResult[]): boolean {
  if (!isFirstPersonQueryText(queryText)) {
    return false;
  }
  return hasSelfOwnedExactDetailOwnershipSupport(queryText, results);
}

function isSubjectSafeForTypedContract(
  answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null
): boolean {
  return Boolean(
    answerAssessment &&
      answerAssessment.sufficiency !== "contradicted" &&
      answerAssessment.subjectMatch !== "mismatched" &&
      (
        answerAssessment.subjectMatch !== "mixed" ||
        answerAssessment.matchedParticipants.length > 0
      )
  );
}

function buildTypedContractSubjectPlan(
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "subjectNames">
): SubjectPlan {
  const pairNames = retrievalPlan.subjectNames.length >= 2 ? retrievalPlan.subjectNames.slice(0, 2) : [];
  if (pairNames.length >= 2) {
    return {
      kind: "pair_subject",
      subjectEntityId: null,
      canonicalSubjectName: pairNames[0] ?? null,
      pairSubjectEntityId: null,
      pairSubjectName: pairNames[1] ?? null,
      candidateEntityIds: [],
      candidateNames: pairNames,
      reason: `typed_contract_pair_subject:${pairNames.join("|")}`
    };
  }
  const subjectName = retrievalPlan.subjectNames[0] ?? null;
  return {
    kind: subjectName ? "single_subject" : "no_subject",
    subjectEntityId: null,
    canonicalSubjectName: subjectName,
    candidateEntityIds: [],
    candidateNames: subjectName ? [subjectName] : [],
    reason: subjectName ? "typed_contract_subject" : "typed_contract_no_subject"
  };
}

function inferListExpectedCount(queryText: string, contract: TypedContractName): number {
  if (contract === "camping_location_history") {
    return inferCampingLocationCompletenessTarget(queryText);
  }
  if (contract === "support_network") {
    return inferSupportNetworkCompletenessTarget(queryText);
  }
  if (contract === "event_inventory") {
    return inferActivityCompletenessTarget(queryText);
  }
  if (contract === "family_activity_inventory") {
    return inferActivityCompletenessTarget(queryText);
  }
  if (contract === "direct_destress_activity") {
    return Math.max(2, inferActivityCompletenessTarget(queryText));
  }
  if (contract === "made_item_pair_inventory") {
    return 1;
  }
  if (contract === "pet_inventory") {
    return /\bpets\b/iu.test(queryText) ? 2 : 1;
  }
  if (contract === "identity_profile") {
    return 1;
  }
  return 2;
}

function isGrowthBasedSetContract(queryText: string, contract: TypedContractName): boolean {
  if (contract === "book_list" || contract === "camping_location_history" || contract === "event_inventory") {
    return true;
  }
  return contract === "preference_profile" && /\bkids?\b|\bchildren\b/iu.test(queryText);
}

export function inferTypedContract(
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): TypedContractName | null {
  return resolveTypedContractFromPlan({ queryText, retrievalPlan });
}

function buildListContractCompleteness(params: {
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "subjectNames" | "controllerIntent">;
  readonly results: readonly RecallResult[];
  readonly contract: TypedContractName;
  readonly previousNormalizedItems?: readonly string[];
  readonly continuationAttempted?: boolean;
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness {
  const subjectPlan = buildTypedContractSubjectPlan(params.queryText, params.retrievalPlan);
  const support = buildListSetSupport({
    queryText: params.queryText,
    predicateFamily: "list_set",
    results: params.results,
    finalClaimText: null,
    subjectPlan
  });
  const childScopedPreferenceEntries =
    params.contract === "preference_profile" && /\bkids?\b|\bchildren\b/iu.test(params.queryText)
      ? inferPreferenceProfileValues({
          queryText: params.queryText,
          texts: params.results.map((result) => result.content)
        })
      : [];
  const typedEntries =
    childScopedPreferenceEntries.length > 0
      ? childScopedPreferenceEntries
      : support.typedEntries;
  const requiredField = inferTypedContractRequiredField(params.contract);
  const expectedCount = inferListExpectedCount(params.queryText, params.contract);
  const subjectSafe = isSubjectSafeForTypedContract(params.answerAssessment);
  const previousNormalizedItems = new Set((params.previousNormalizedItems ?? []).map((value) => normalize(value).toLowerCase()).filter(Boolean));
  const newItemCount = typedEntries.filter((entry) => !previousNormalizedItems.has(normalize(entry).toLowerCase())).length;
  const growthStopped = params.continuationAttempted === true && newItemCount === 0;
  const groundedItemCount = typedEntries.length;
  const growthBasedContract = isGrowthBasedSetContract(params.queryText, params.contract);
  const complete =
    growthBasedContract
      ? (
          groundedItemCount > 0 &&
          (
            growthStopped ||
            typedEntries.length >= expectedCount
          )
        )
      : typedEntries.length >= expectedCount;
  const resolvedFields =
    complete
      ? [requiredField]
      : [];
  const missingFields = resolvedFields.length > 0 ? [] : [requiredField];
  return {
    contract: params.contract,
    requiredFields: [requiredField],
    resolvedFields,
    missingFields,
    complete,
    stopEligible: complete && subjectSafe,
    completenessScore: Math.min(typedEntries.length / expectedCount, 1),
    backfillReason: complete ? null : `${requiredField}_missing`,
    normalizedItemCount: typedEntries.length,
    newItemCount,
    growthStopped,
    groundedItemCount
  };
}

export function evaluateTypedContractCompleteness(params: {
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "subjectNames" | "controllerIntent">;
  readonly results: readonly RecallResult[];
  readonly exactDetailText?: string | null;
  readonly previousNormalizedItems?: readonly string[];
  readonly continuationAttempted?: boolean;
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness | null {
  const contract = inferTypedContract(params.queryText, params.retrievalPlan);
  if (!contract) {
    return null;
  }
  if (contract === "identity_profile") {
    return evaluateIdentityProfileContractCompleteness({
      queryText: params.queryText,
      results: params.results,
      answerAssessment: params.answerAssessment
    });
  }
  if (contract === "reasoned_profile_judgment") {
    return evaluateReasonedProfileJudgmentCompleteness({
      queryText: params.queryText,
      results: params.results,
      answerAssessment: params.answerAssessment
    });
  }
  if (contract === "profile_trait_judgment") {
    return evaluateProfileTraitJudgmentCompleteness({
      queryText: params.queryText,
      results: params.results,
      answerAssessment: params.answerAssessment
    });
  }
  if (contract === "relationship_profile") {
    return evaluateScalarProfileContractCompleteness({
      contract,
      reportKind: "relationship_report",
      queryText: params.queryText,
      results: params.results,
      answerAssessment: params.answerAssessment
    });
  }
  if (contract === "preference_profile") {
    if (/\bkids?\b|\bchildren\b/iu.test(params.queryText)) {
      return buildListContractCompleteness({
        queryText: params.queryText,
        retrievalPlan: params.retrievalPlan,
        results: params.results,
        contract,
        previousNormalizedItems: params.previousNormalizedItems,
        continuationAttempted: params.continuationAttempted,
        answerAssessment: params.answerAssessment
      });
    }
    return evaluateScalarProfileContractCompleteness({
      contract,
      reportKind: "preference_report",
      queryText: params.queryText,
      results: params.results,
      answerAssessment: params.answerAssessment
    });
  }
  if (
    contract === "book_list" ||
    contract === "made_item_pair_inventory" ||
    contract === "pair_event_inventory" ||
    contract === "family_activity_inventory" ||
    contract === "inventory_list" ||
    contract === "made_item_inventory" ||
    contract === "location_history" ||
    contract === "camping_location_history" ||
    contract === "support_network" ||
    contract === "event_inventory" ||
    contract === "direct_destress_activity" ||
    contract === "pet_inventory"
  ) {
    return buildListContractCompleteness({
      queryText: params.queryText,
      retrievalPlan: params.retrievalPlan,
      results: params.results,
      contract,
      previousNormalizedItems: params.previousNormalizedItems,
      continuationAttempted: params.continuationAttempted,
      answerAssessment: params.answerAssessment
    });
  }

  const requiredField =
    contract === "direct_reason" || contract === "structured_direct_reason" || contract === "benefit_reason_slot"
      ? "causal_reason"
      : contract === "utterance_fact"
        ? "quoted_statement"
        : "exact_detail_support";
  const exactDetailResolved =
    normalize(params.exactDetailText).length > 0 ||
    (
      contract === "benefit_reason_slot" &&
      params.results.some((result) =>
        /\b(?:great for|motivated|inspired|helped|take away)\b/iu.test(result.content)
      )
    );
  const family = inferExactDetailQuestionFamily(params.queryText);
  const exactDetailFamilyEligibleForSelfOwnedStop =
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
    ].includes(family);
  const subjectSafe =
    isSubjectSafeForTypedContract(params.answerAssessment) ||
    (
      exactDetailResolved &&
      exactDetailFamilyEligibleForSelfOwnedStop &&
      hasSelfOwnedExactDetailSupport(params.queryText, params.results) &&
      params.answerAssessment?.subjectMatch !== "mismatched"
    );
  return {
    contract,
    requiredFields: [requiredField],
    resolvedFields: exactDetailResolved ? [requiredField] : [],
    missingFields: exactDetailResolved ? [] : [requiredField],
    complete: exactDetailResolved,
    stopEligible: exactDetailResolved && subjectSafe,
    completenessScore: exactDetailResolved ? 1 : 0,
    backfillReason: exactDetailResolved ? null : "exact_detail_support_missing"
  };
}
