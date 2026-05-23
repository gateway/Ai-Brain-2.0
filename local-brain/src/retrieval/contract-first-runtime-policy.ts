import type { RecallResult } from "../types.js";
import { evaluateTypedContractCompleteness } from "./typed-contract-completeness.js";
import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import {
  buildTypedCompletionFollowupSubqueries,
  buildTypedContractBackfillSubqueries,
  type PlannerTargetedBackfillNeed
} from "./typed-backfill-policy.js";
import type {
  AnswerRetrievalPlan,
  ExactDetailClaimCandidate,
  RecallResponse
} from "./types.js";

export interface ContractFirstPlannerBackfillDecision {
  readonly mode: "typed_contract" | "generic_default" | "disabled";
  readonly reason: string;
  readonly subqueries: readonly string[];
  readonly followupSubqueries: readonly string[] | null;
  readonly suppressGenericWidening: boolean;
}

function shouldSuppressGenericWideningForExactDetail(queryText: string, retrievalPlan: AnswerRetrievalPlan): boolean {
  if (retrievalPlan.family !== "exact_detail") {
    return false;
  }
  return [
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
  ].includes(inferExactDetailQuestionFamily(queryText));
}

function hasSubjectSafeSupport(
  answerAssessment: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null | undefined
): boolean {
  return Boolean(
    answerAssessment &&
      answerAssessment.sufficiency === "supported" &&
      answerAssessment.subjectMatch !== "mismatched" &&
      (
        answerAssessment.subjectMatch !== "mixed" ||
        answerAssessment.matchedParticipants.length > 0
      )
  );
}

export function buildContractFirstPlannerBackfillDecision(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly subjectHints: readonly string[];
  readonly plannerBackfillNeed: PlannerTargetedBackfillNeed;
  readonly forceContractBackfill?: boolean;
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
  readonly buildGenericSubqueries: (reason: string | null) => readonly string[];
}): ContractFirstPlannerBackfillDecision {
  const reason = params.plannerBackfillNeed.reason ?? "planner_targeted_backfill";
  if (!params.plannerBackfillNeed.needed && params.forceContractBackfill !== true) {
    return {
      mode: "disabled",
      reason,
      subqueries: [],
      followupSubqueries: null,
      suppressGenericWidening: false
    };
  }

  const typedSubqueries = buildTypedContractBackfillSubqueries({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    subjectHints: params.subjectHints,
    reason
  });
  const contractLocked =
    params.retrievalPlan.controllerIntent?.backfillMode === "contract_only" &&
    params.retrievalPlan.controllerIntent?.primaryTypedContract !== null;

  if (contractLocked) {
    return {
      mode: typedSubqueries?.length ? "typed_contract" : "disabled",
      reason,
      subqueries: typedSubqueries ?? [],
      followupSubqueries:
        typedSubqueries?.length
          ? buildTypedCompletionFollowupSubqueries({
              queryText: params.queryText,
              retrievalPlan: params.retrievalPlan,
              subjectHints: params.subjectHints,
              results: params.results,
              answerAssessment: params.answerAssessment
            })
          : null,
      suppressGenericWidening: true
    };
  }

  if (typedSubqueries?.length) {
    const exactDetailSuppressGeneric = shouldSuppressGenericWideningForExactDetail(
      params.queryText,
      params.retrievalPlan
    );
    return {
      mode: "typed_contract",
      reason,
      subqueries: typedSubqueries,
      followupSubqueries: buildTypedCompletionFollowupSubqueries({
        queryText: params.queryText,
        retrievalPlan: params.retrievalPlan,
        subjectHints: params.subjectHints,
        results: params.results,
        answerAssessment: params.answerAssessment
      }),
      suppressGenericWidening: exactDetailSuppressGeneric
    };
  }

  return {
    mode: "generic_default",
    reason,
    subqueries: params.buildGenericSubqueries(reason),
    followupSubqueries: null,
    suppressGenericWidening: false
  };
}

export function shouldSuppressTypedLaneDescentAfterContractSelection(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly exactDetailCandidate: ExactDetailClaimCandidate | null;
  readonly plannerTargetedBackfillApplied: boolean;
  readonly plannerTargetedBackfillReason?: string;
  readonly stopOnFirstSufficient?: boolean;
}): boolean {
  if (params.stopOnFirstSufficient !== true) {
    return false;
  }
  if (params.retrievalPlan.controllerIntent?.backfillMode !== "contract_only") {
    return false;
  }
  if (!params.retrievalPlan.controllerIntent?.primaryTypedContract) {
    return false;
  }
  if (!params.plannerTargetedBackfillApplied) {
    return false;
  }

  const completeness = evaluateTypedContractCompleteness({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results,
    exactDetailText: params.exactDetailCandidate?.text,
    answerAssessment: params.answerAssessment
  });
  if (!completeness) {
    return false;
  }
  if (!hasSubjectSafeSupport(params.answerAssessment)) {
    return (
      completeness.completenessScore === 0 &&
      [
        "book_list",
        "event_inventory",
        "location_history",
        "camping_location_history",
        "support_network"
      ].includes(completeness.contract)
    );
  }
  if (completeness.stopEligible) {
    return true;
  }

  const reason = params.plannerTargetedBackfillReason ?? "";
  return (
    completeness.completenessScore > 0 &&
    (
      reason.includes(completeness.contract) ||
      reason.includes("missing") ||
      reason.includes("targeted_backfill")
    )
  );
}
