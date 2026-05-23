import type { RecallResult } from "../types.js";
import {
  type AnswerRetrievalPlan,
  type RecallResponse,
  type TypedContractCompleteness,
  type TypedContractName
} from "./types.js";
import { evaluateTypedContractCompleteness } from "./typed-contract-completeness.js";
import { typedContractContinuationPools } from "./typed-contract-registry.js";

export interface TypedCompletionState {
  readonly contract: TypedContractName | null;
  readonly completeness: TypedContractCompleteness | null;
  readonly satisfied: boolean;
  readonly wideningSuppressed: boolean;
  readonly backfillMode: "typed_completion" | "none";
  readonly earlyStopReason: string | null;
}

export interface ContractContinuationRequest {
  readonly selectedContract: TypedContractName;
  readonly missingFields: readonly string[];
  readonly allowedCandidatePools: readonly string[];
  readonly requiresPairBinding: boolean;
  readonly maxPasses: number;
  readonly maxDepth: number;
  readonly stopOnCompletion: boolean;
  readonly suppressGenericWidening: boolean;
}

export function buildContractContinuationRequest(
  completeness: TypedContractCompleteness | null | undefined
): ContractContinuationRequest | null {
  if (!completeness || completeness.complete) {
    return null;
  }
  return {
    selectedContract: completeness.contract,
    missingFields: completeness.missingFields.length > 0 ? completeness.missingFields : completeness.requiredFields,
    allowedCandidatePools: typedContractContinuationPools(completeness.contract),
    requiresPairBinding: ["book_recommendation_pair", "pair_event_inventory", "made_item_pair_inventory"].includes(completeness.contract),
    maxPasses: 1,
    maxDepth: 1,
    stopOnCompletion: true,
    suppressGenericWidening: true
  };
}

export function evaluateTypedCompletionState(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly exactDetailText?: string | null;
  readonly completenessOverride?: TypedContractCompleteness | null;
  readonly plannerBackfillApplied?: boolean;
  readonly plannerBackfillSubqueries?: readonly string[];
  readonly stopOnFirstSufficient?: boolean;
}): TypedCompletionState {
  const answerAssessment = params.answerAssessment;
  const completeness = params.completenessOverride ?? evaluateTypedContractCompleteness({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results,
    exactDetailText: params.exactDetailText,
    answerAssessment
  });
  const satisfied =
    params.stopOnFirstSufficient === true &&
    (
      completeness?.stopEligible === true ||
      (
        completeness?.complete === true &&
        answerAssessment?.sufficiency === "supported"
      )
    );
  const backfillMode =
    Boolean(params.plannerBackfillApplied) &&
    (params.plannerBackfillSubqueries?.length ?? 0) > 0 &&
    completeness !== null
      ? "typed_completion"
      : "none";
  const wideningSuppressed =
    satisfied ||
    Boolean(
      completeness &&
      params.retrievalPlan.controllerIntent?.backfillMode === "contract_only" &&
      answerAssessment?.subjectMatch !== "mismatched"
    );
  const earlyStopReason =
    satisfied
      ? "typed_contract_sufficient"
      : backfillMode === "typed_completion" && completeness && !completeness.complete
        ? "contract_locked_backfill_exhausted"
        : null;
  return {
    contract: completeness?.contract ?? null,
    completeness,
    satisfied,
    wideningSuppressed,
    backfillMode,
    earlyStopReason
  };
}
