import type { RecallIntent, RecallPlan, RecallQuery } from "./types.js";

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function expandYearHint(year: string): { readonly start: string; readonly end: string } {
  return {
    start: `${year}-01-01T00:00:00.000Z`,
    end: `${year}-12-31T23:59:59.999Z`
  };
}

function containsTemporalQuestion(queryText: string): boolean {
  return /\b(what was i doing|who was i with|where was i|when was i|back in|at that time)\b/i.test(queryText) || /\b(during|around)\b/i.test(queryText);
}

function containsHistoricalCue(queryText: string): boolean {
  return /\b(what was i doing|who was i with|where was i|when was i|back in|during|at that time|then)\b/i.test(queryText);
}

export function planRecallQuery(query: RecallQuery): RecallPlan {
  const queryText = query.query.trim();
  const yearHints = uniqueSorted(queryText.match(/\b(19\d{2}|20\d{2})\b/g) ?? []);
  const hasExplicitWindow = Boolean(query.timeStart || query.timeEnd);
  const hasTemporalCue = containsTemporalQuestion(queryText) || containsHistoricalCue(queryText) || yearHints.length > 0 || hasExplicitWindow;

  const inferredWindow = !hasExplicitWindow && yearHints.length > 0 ? expandYearHint(yearHints[0]) : undefined;
  const intent: RecallIntent = hasTemporalCue ? (yearHints.length > 0 || hasExplicitWindow ? "complex" : "hybrid") : "simple";

  return {
    intent,
    temporalFocus: hasTemporalCue,
    inferredTimeStart: inferredWindow?.start,
    inferredTimeEnd: inferredWindow?.end,
    yearHints,
    branchPreference: hasTemporalCue ? "episodic_then_temporal" : "lexical_first",
    candidateLimitMultiplier: hasTemporalCue ? 5 : 4,
    episodicWeight: hasTemporalCue ? 1.2 : 1,
    temporalSummaryWeight: hasTemporalCue ? 1.1 : 1
  };
}
