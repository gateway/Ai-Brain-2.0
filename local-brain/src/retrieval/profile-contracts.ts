import {
  buildProfileInferenceSupport,
  renderProfileInferenceSupport
} from "./support-objects.js";
import {
  inferPreferenceProfileValues,
  inferProfileTraitJudgmentValue
} from "./typed-support-extractors.js";
import type { RecallResult } from "../types.js";
import type {
  RecallResponse,
  TypedContractName,
  TypedContractCompleteness
} from "./types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function evaluateIdentityProfileContractCompleteness(params: {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness {
  const support = buildProfileInferenceSupport({
    reportKind: "profile_report",
    queryText: params.queryText,
    fallbackSummary: null,
    results: params.results
  });
  const rendered = renderProfileInferenceSupport(params.queryText, support);
  const combinedIdentityText = normalize([
    support.answerValue,
    support.runtimeClaimText,
    support.fallbackSummary,
    rendered.claimText,
    ...support.supportTexts
  ].filter(Boolean).join(" "));
  const hasIdentitySignal =
    /\b(?:transgender|trans woman|trans man|nonbinary|gender identity|queer)\b/iu.test(combinedIdentityText);
  const subjectSafe = Boolean(
    params.answerAssessment &&
      params.answerAssessment.sufficiency === "supported" &&
      params.answerAssessment.subjectMatch !== "mismatched" &&
      (
        params.answerAssessment.subjectMatch !== "mixed" ||
        params.answerAssessment.matchedParticipants.length > 0
      )
  );
  const complete = hasIdentitySignal;
  return {
    contract: "identity_profile",
    requiredFields: ["identity_support"],
    resolvedFields: complete ? ["identity_support"] : [],
    missingFields: complete ? [] : ["identity_support"],
    complete,
    stopEligible: complete && subjectSafe,
    completenessScore: complete ? 1 : combinedIdentityText.length > 0 ? 0.5 : 0,
    backfillReason: complete ? null : "profile_support_missing"
  };
}

function isSubjectSafe(
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

export function evaluateScalarProfileContractCompleteness(params: {
  readonly contract: Extract<TypedContractName, "relationship_profile" | "preference_profile">;
  readonly reportKind: "relationship_report" | "preference_report";
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness {
  const support = buildProfileInferenceSupport({
    reportKind: params.reportKind,
    queryText: params.queryText,
    fallbackSummary: null,
    results: params.results
  });
  const rendered = renderProfileInferenceSupport(params.queryText, support);
  const claimText = normalize(rendered.claimText ?? support.answerValue ?? support.runtimeClaimText ?? support.fallbackSummary);
  const rawSupportText = normalize(params.results.map((result) => result.content).join(" "));
  const explicitPreferenceValues =
    params.contract === "preference_profile"
      ? inferPreferenceProfileValues({
          queryText: params.queryText,
          texts: [...support.supportTexts, ...params.results.map((result) => result.content)]
        })
      : [];
  const complete =
    params.contract === "relationship_profile"
      ? (
          claimText.length > 0 ||
          /\b(single|dating|married|engaged|divorced|separated|in a relationship)\b/iu.test(rawSupportText)
        )
      : (
          explicitPreferenceValues.length > 0 ||
          (
            claimText.length > 0 &&
            !/^none\.?$/iu.test(claimText) &&
            support.supportCompletenessScore >= 0.65
          )
        );
  const requiredField = params.contract === "relationship_profile" ? "relationship_status" : "preference_value";
  return {
    contract: params.contract,
    requiredFields: [requiredField],
    resolvedFields: complete ? [requiredField] : [],
    missingFields: complete ? [] : [requiredField],
    complete,
    stopEligible: complete && isSubjectSafe(params.answerAssessment),
    completenessScore: complete ? 1 : support.supportCompletenessScore,
    backfillReason: complete ? null : `${requiredField}_missing`
  };
}

export function evaluateReasonedProfileJudgmentCompleteness(params: {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness {
  const support = buildProfileInferenceSupport({
    reportKind: "career_report",
    queryText: params.queryText,
    fallbackSummary: null,
    results: params.results
  });
  const rendered = renderProfileInferenceSupport(params.queryText, support);
  const reasoningText = normalize(
    [
      rendered.claimText,
      support.inferredReasonText,
      support.answerValue,
      support.runtimeClaimText,
      support.fallbackSummary,
      ...support.supportTexts
    ].filter(Boolean).join(" ")
  );
  const counterfactualSupportQuery =
    /\bif\b[^?!.]{0,120}\bhadn'?t\b[^?!.]{0,120}\bsupport\b/iu.test(params.queryText) ||
    /\bwithout support\b/iu.test(params.queryText);
  const hasCareerCue = /\b(counseling|counsell?ing|mental health|therapy|therapist|writing|career|job|field)\b/iu.test(reasoningText);
  const hasJudgmentCue = /^yes\b|^likely\b|^no\b/iu.test(reasoningText) || /\bwould\b|\blikely\b|\bunlikely\b/iu.test(reasoningText);
  const hasCounterfactualSupportCue =
    /\b(support|supported|supportive|helped|guidance|growing up|journey|without)\b/iu.test(reasoningText);
  const complete =
    reasoningText.length > 0 &&
    hasCareerCue &&
    hasJudgmentCue &&
    (!counterfactualSupportQuery || hasCounterfactualSupportCue);
  return {
    contract: "reasoned_profile_judgment",
    requiredFields: ["judgment_reason"],
    resolvedFields: complete ? ["judgment_reason"] : [],
    missingFields: complete ? [] : ["judgment_reason"],
    complete,
    stopEligible: complete && isSubjectSafe(params.answerAssessment),
    completenessScore: complete ? 1 : support.supportCompletenessScore,
    backfillReason: complete ? null : "judgment_reason_missing"
  };
}

export function evaluateProfileTraitJudgmentCompleteness(params: {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): TypedContractCompleteness {
  const support = buildProfileInferenceSupport({
    reportKind: "preference_report",
    queryText: params.queryText,
    fallbackSummary: null,
    results: params.results
  });
  const rendered = renderProfileInferenceSupport(params.queryText, support);
  const reasoningText = normalize(
    [
      rendered.claimText,
      support.answerValue,
      support.inferredReasonText,
      support.runtimeClaimText,
      support.fallbackSummary,
      ...support.supportTexts
    ].filter(Boolean).join(" ")
  );
  const inferredValue = inferProfileTraitJudgmentValue({
    queryText: params.queryText,
    texts: [reasoningText, ...support.supportTexts, ...params.results.map((result) => result.content)]
  });
  const complete =
    Boolean(inferredValue) ||
    (
      reasoningText.length > 0 &&
      (
        /\b(likely yes|likely no|yes|no|religious|personality|trait|progressive|liberal|conservative|moderate)\b/iu.test(reasoningText) ||
        support.supportCompletenessScore >= 0.8
      )
    );
  return {
    contract: "profile_trait_judgment",
    requiredFields: ["judgment_reason"],
    resolvedFields: complete ? ["judgment_reason"] : [],
    missingFields: complete ? [] : ["judgment_reason"],
    complete,
    stopEligible: complete && isSubjectSafe(params.answerAssessment),
    completenessScore: complete ? 1 : support.supportCompletenessScore,
    backfillReason: complete ? null : "judgment_reason_missing"
  };
}
