import type {
  AnswerOwnerFamily,
  CandidatePoolSelection,
  PlannerAnswerKind,
  RetrievalPlanLane,
  RetrievalRescuePolicy,
  SuppressionPoolSelection,
  TypedContractName
} from "./types.js";

export type RetrievalControllerExpectedShape =
  | "temporal"
  | "scalar"
  | "reason"
  | "set"
  | "list"
  | "judgment"
  | "report";

export type RetrievalControllerSubjectArity = "none" | "single" | "pair";

export type RetrievalControllerContractLock =
  | "typed_first"
  | "report_first"
  | "exact_detail_first"
  | "abstention_only";

export type RetrievalControllerBackfillMode =
  | "contract_only"
  | "report_only"
  | "exact_detail_only"
  | "disabled";

export type RetrievalControllerNeighborhoodMode =
  | "enrichment_only"
  | "report_enrichment"
  | "exact_detail_enrichment"
  | "disabled";

export interface RetrievalControllerIntent {
  readonly family: AnswerOwnerFamily | "generic";
  readonly lane: RetrievalPlanLane;
  readonly answerKind: PlannerAnswerKind;
  readonly primaryTypedContract: TypedContractName | null;
  readonly expectedShape: RetrievalControllerExpectedShape;
  readonly subjectArity: RetrievalControllerSubjectArity;
  readonly contractLock: RetrievalControllerContractLock;
  readonly backfillMode: RetrievalControllerBackfillMode;
  readonly neighborhoodMode: RetrievalControllerNeighborhoodMode;
  readonly genericFamilyEligibleBeforeContractFailure: boolean;
}

export interface BoundedCandidateAssemblyPolicy {
  readonly candidatePools: readonly CandidatePoolSelection[];
  readonly suppressionPools: readonly SuppressionPoolSelection[];
  readonly ownerEligibilityHints: readonly string[];
  readonly suppressionHints: readonly string[];
  readonly familyConfidence: number;
  readonly supportCompletenessTarget: number;
  readonly rescuePolicy: RetrievalRescuePolicy;
}
