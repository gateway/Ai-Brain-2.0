import { deriveAspirationReportSummaryFromTexts } from "../canonical-memory/narrative-reader.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function inferSpecificIdentityAnswerValue(text: string): string | null {
  const normalized = normalize(text);
  if (!normalized) {
    return null;
  }
  if (/\btransgender woman\b/iu.test(normalized)) {
    return "Transgender woman";
  }
  if (/\btransgender man\b/iu.test(normalized)) {
    return "Transgender man";
  }
  if (/\btransgender\b/iu.test(normalized)) {
    return "Transgender";
  }
  if (/\bnonbinary\b/iu.test(normalized)) {
    return "Nonbinary";
  }
  if (/\bqueer\b/iu.test(normalized)) {
    return "Queer";
  }
  return null;
}

export function derivePreferredAspirationSummary(queryText: string, texts: readonly string[]): string | null {
  return normalize(deriveAspirationReportSummaryFromTexts(queryText, texts)) || null;
}

export function selectPreferredProfileAnswerValue(params: {
  readonly reportKind: string;
  readonly queryText: string;
  readonly cleanedStructuredAnswerValue: string | null;
  readonly inferredAnswerValue: string | null;
  readonly queryBoundSummary: string | null;
  readonly prefersInferredIdentityValue: boolean;
}): string | null {
  const prefersQueryBoundSummary =
    params.reportKind === "career_report" ||
    params.reportKind === "education_report" ||
    params.reportKind === "pet_care_report" ||
    params.reportKind === "aspiration_report" ||
    params.reportKind === "travel_report";
  const prefersInferredRelationshipValue =
    params.reportKind === "relationship_report" ||
    /\brelationship status\b|\bsingle\b|\bdating\b|\bin a relationship\b|\bseeing someone\b/iu.test(params.queryText);
  const prefersInferredAspirationValue = params.reportKind === "aspiration_report";
  return (
    (prefersInferredAspirationValue
      ? (params.queryBoundSummary ?? params.inferredAnswerValue)
      : prefersInferredRelationshipValue || params.prefersInferredIdentityValue
        ? params.inferredAnswerValue
        : params.cleanedStructuredAnswerValue) ??
    (prefersInferredRelationshipValue || params.prefersInferredIdentityValue
      ? params.cleanedStructuredAnswerValue
      : params.inferredAnswerValue) ??
    (prefersInferredAspirationValue ? params.cleanedStructuredAnswerValue : null) ??
    (prefersQueryBoundSummary ? params.queryBoundSummary : null)
  );
}
