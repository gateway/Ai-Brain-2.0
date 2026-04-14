export type AnswerShapingDiagnosis =
  | "wrong_owner"
  | "right_owner_wrong_shape"
  | "right_owner_incomplete_support"
  | "temporal_rendering_wrong"
  | "report_semantics_wrong"
  | "list_set_rendering_wrong"
  | "subject_binding_missing"
  | "honest_abstention_but_support_missing"
  | "not_applicable";

interface AnswerOwnerTraceLike {
  readonly family?: string | null;
  readonly winner?: string | null;
  readonly resolvedSubject?: {
    readonly bindingStatus?: string | null;
  } | null;
}

interface AnswerShapingTraceLike {
  readonly selectedFamily?: string | null;
  readonly shapingMode?: string | null;
  readonly shapingPipelineEntered?: boolean;
  readonly supportObjectAttempted?: boolean;
  readonly renderContractAttempted?: boolean;
  readonly bypassReason?: string | null;
  readonly typedValueUsed?: boolean;
  readonly runtimeResynthesisUsed?: boolean;
  readonly supportRowsSelected?: number;
  readonly supportObjectsBuilt?: number;
  readonly supportObjectType?: string | null;
  readonly supportNormalizationFailures?: readonly string[];
  readonly renderContractSelected?: string | null;
  readonly typedSetEntryCount?: number;
}

export function classifyAnswerShapingDiagnosis(params: {
  readonly question: string;
  readonly failureClass: string;
  readonly finalClaimSource: string | null;
  readonly answerOwnerTrace?: AnswerOwnerTraceLike | null;
  readonly answerShapingTrace?: AnswerShapingTraceLike | null;
}): AnswerShapingDiagnosis {
  const winner = params.answerOwnerTrace?.winner ?? params.finalClaimSource;
  const family = params.answerOwnerTrace?.family ?? params.answerShapingTrace?.selectedFamily ?? "generic";
  const bindingStatus = params.answerOwnerTrace?.resolvedSubject?.bindingStatus ?? null;
  const supportRowsSelected = params.answerShapingTrace?.supportRowsSelected ?? 0;
  const supportObjectsBuilt = params.answerShapingTrace?.supportObjectsBuilt ?? 0;
  const supportFailures = params.answerShapingTrace?.supportNormalizationFailures?.length ?? 0;
  const hasExplicitName = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/u.test(params.question);

  if (hasExplicitName && bindingStatus && bindingStatus !== "resolved") {
    return "subject_binding_missing";
  }
  if (params.failureClass === "abstention" || winner === "canonical_abstention") {
    return supportRowsSelected > 0 || supportObjectsBuilt > 0 ? "honest_abstention_but_support_missing" : "subject_binding_missing";
  }
  if (params.failureClass === "temporal" || winner === "canonical_temporal") {
    return "temporal_rendering_wrong";
  }
  if (winner === "canonical_report" || winner === "canonical_narrative") {
    if ((params.answerShapingTrace?.runtimeResynthesisUsed && supportRowsSelected <= 1) || supportFailures > 0) {
      return "right_owner_incomplete_support";
    }
    return "report_semantics_wrong";
  }
  if (winner === "canonical_list_set") {
    return params.answerShapingTrace?.typedSetEntryCount && params.answerShapingTrace.typedSetEntryCount > 0
      ? "list_set_rendering_wrong"
      : "wrong_owner";
  }
  if (
    winner === "top_snippet" ||
    (winner === "canonical_exact_detail" && (family === "report" || family === "temporal" || family === "list_set")) ||
    (winner === "runtime_exact_detail" && (family === "report" || family === "temporal" || family === "list_set"))
  ) {
    return "wrong_owner";
  }
  if (params.failureClass === "answer_shaping") {
    if ((params.answerShapingTrace?.runtimeResynthesisUsed && supportRowsSelected <= 1) || supportFailures > 0) {
      return "right_owner_incomplete_support";
    }
    if (winner === "runtime_exact_detail" || winner === "canonical_exact_detail") {
      return "right_owner_wrong_shape";
    }
  }
  if (winner === "runtime_exact_detail" || winner === "canonical_exact_detail") {
    return "right_owner_wrong_shape";
  }
  return "not_applicable";
}
