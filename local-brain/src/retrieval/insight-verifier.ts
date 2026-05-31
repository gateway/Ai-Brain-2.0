import type { InsightReport } from "./insight-types.js";

function textTerms(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/gu) ?? [])].slice(0, 20);
}

function hasSupportOverlap(text: string, supportText: string): boolean {
  const support = supportText.toLowerCase();
  return textTerms(text).some((term) => support.includes(term));
}

export function verifyInsightReport(report: InsightReport): InsightReport {
  const supportText = [
    ...report.sourceTrail.map((trail) => `${trail.sourceUri ?? ""} ${trail.artifactId ?? ""} ${trail.quote ?? ""}`),
    ...report.examples.map((example) => `${example.text} ${example.quote}`)
  ].join(" ");
  const unsupportedInsightClaimCount = report.observations.filter((observation) => !hasSupportOverlap(observation.text, supportText)).length;
  const unsupportedSuggestionCount = report.suggestions.filter((suggestion) => !hasSupportOverlap(suggestion.rationale, supportText) && suggestion.sourceTrail.length === 0).length;
  const supportChecks = report.observations.length + report.suggestions.length;
  const passedChecks = Math.max(0, supportChecks - unsupportedInsightClaimCount - unsupportedSuggestionCount);
  const citationFaithfulnessScore = supportChecks === 0 ? 0 : Number((passedChecks / supportChecks).toFixed(4));
  return {
    ...report,
    verification: {
      ...report.verification,
      unsupportedInsightClaimCount,
      unsupportedSuggestionCount,
      citationFaithfulnessScore
    }
  };
}
