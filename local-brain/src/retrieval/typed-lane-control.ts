import { buildListSetSupport } from "./support-objects.js";
import { evaluateTypedContractCompleteness } from "./typed-contract-completeness.js";
import { buildPlannerBackfillSubjectPlan } from "./typed-backfill-policy.js";
import type { ExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import type { RecallResult } from "../types.js";
import type {
  AnswerRetrievalPlan,
  ExactDetailClaimCandidate,
  RecallResponse,
  RecallTypedLaneDescentStage
} from "./types.js";

export function shouldTriggerTypedLaneConditionalDescent(params: {
  readonly stage: RecallTypedLaneDescentStage | null;
  readonly nextStage: RecallTypedLaneDescentStage | null;
  readonly queryText: string;
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly subjectHints: readonly string[];
  readonly exactDetailFamily: ExactDetailQuestionFamily;
  readonly exactDetailCandidate: ExactDetailClaimCandidate | null;
  readonly exactDetailExtractionEnabled: boolean;
  readonly queryModeHint: string;
  readonly stopOnFirstSufficient?: boolean;
  readonly contractSatisfied?: boolean;
  readonly hasStrongExactDetailSupportCandidate: (
    queryText: string,
    candidate: ExactDetailClaimCandidate | null
  ) => boolean;
  readonly exactDetailCandidateNeedsSubtypeRescue: (
    queryText: string,
    candidate: ExactDetailClaimCandidate | null
  ) => boolean;
}): boolean {
  if (!params.stage || !params.nextStage || params.stage === "memory_candidate") {
    return false;
  }
  if (
    params.stopOnFirstSufficient === true &&
    params.contractSatisfied === true
  ) {
    return false;
  }
  if (
    params.stopOnFirstSufficient === true &&
    params.hasStrongExactDetailSupportCandidate(params.queryText, params.exactDetailCandidate) &&
    !params.exactDetailCandidateNeedsSubtypeRescue(params.queryText, params.exactDetailCandidate)
  ) {
    return false;
  }
  if (
    params.stopOnFirstSufficient === true &&
    hasSufficientStructuredSupportForConditionalDescent({
      queryText: params.queryText,
      retrievalPlan: params.retrievalPlan,
      answerAssessment: params.answerAssessment,
      results: params.results,
      exactDetailCandidate: params.exactDetailCandidate
    })
  ) {
    return false;
  }
  if (!params.answerAssessment) {
    return true;
  }
  if (params.answerAssessment.sufficiency !== "supported") {
    return true;
  }
  if (params.results.length < 2) {
    return true;
  }
  if (
    params.subjectHints.length > 0 &&
    (params.answerAssessment.subjectMatch === "mismatched" ||
      params.answerAssessment.subjectMatch === "mixed" ||
      params.answerAssessment.matchedParticipants.length === 0)
  ) {
    return true;
  }
  if (
    params.exactDetailExtractionEnabled &&
    !params.exactDetailCandidate &&
    (params.queryModeHint === "exact_detail" || params.queryModeHint === "current_state")
  ) {
    return true;
  }
  if (
    params.exactDetailFamily !== "generic" &&
    !params.exactDetailCandidate &&
    (params.queryModeHint === "exact_detail" || params.results.length < 4)
  ) {
    return true;
  }
  return false;
}

function hasSufficientStructuredSupportForConditionalDescent(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly results: readonly RecallResult[];
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}): boolean {
  const { answerAssessment, queryText, retrievalPlan, results } = params;
  if (!answerAssessment || answerAssessment.sufficiency === "contradicted") {
    return false;
  }
  if (
    answerAssessment.subjectMatch === "mismatched" ||
    (answerAssessment.subjectMatch === "mixed" && answerAssessment.matchedParticipants.length === 0)
  ) {
    return false;
  }
  const typedContract = evaluateTypedContractCompleteness({
    queryText,
    retrievalPlan,
    results,
    exactDetailText: params.exactDetailCandidate?.text,
    answerAssessment
  });
  if (typedContract) {
    return typedContract.stopEligible;
  }
  if (retrievalPlan.family !== "list_set") {
    return false;
  }
  const subjectPlan = buildPlannerBackfillSubjectPlan(queryText, retrievalPlan, []);
  const support = buildListSetSupport({
    queryText,
    predicateFamily: "list_set",
    results,
    finalClaimText: null,
    subjectPlan
  });
  return support.typedEntries.length > 0;
}
