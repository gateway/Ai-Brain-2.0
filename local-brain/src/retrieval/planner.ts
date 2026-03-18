import type { RecallIntent, RecallPlan, RecallQuery, TemporalQueryLayer } from "./types.js";

const MONTH_LOOKUP = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11]
]);

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function expandYearHint(year: string): { readonly start: string; readonly end: string } {
  return {
    start: `${year}-01-01T00:00:00.000Z`,
    end: `${year}-12-31T23:59:59.999Z`
  };
}

function expandMonthHint(year: string, monthIndex: number): { readonly start: string; readonly end: string } {
  const start = new Date(Date.UTC(Number(year), monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(Number(year), monthIndex + 1, 0, 23, 59, 59, 999));

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandDayHint(year: string, monthIndex: number, day: number): { readonly start: string; readonly end: string } {
  const start = new Date(Date.UTC(Number(year), monthIndex, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(Number(year), monthIndex, day, 23, 59, 59, 999));

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function parseMonthName(monthName: string): number | undefined {
  return MONTH_LOOKUP.get(monthName.toLowerCase());
}

function inferTemporalWindow(queryText: string, yearHints: readonly string[]): {
  readonly start?: string;
  readonly end?: string;
  readonly granularity: "none" | "day" | "month" | "year" | "broad";
} {
  const dayMonthYearMatch = queryText.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(19\d{2}|20\d{2})\b/i
  );
  if (dayMonthYearMatch) {
    const monthIndex = parseMonthName(dayMonthYearMatch[1]);
    if (monthIndex !== undefined) {
      return {
        ...expandDayHint(dayMonthYearMatch[3], monthIndex, Number(dayMonthYearMatch[2])),
        granularity: "day"
      };
    }
  }

  const monthYearMatch = queryText.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(19\d{2}|20\d{2})\b/i
  );
  if (monthYearMatch) {
    const monthIndex = parseMonthName(monthYearMatch[1]);
    if (monthIndex !== undefined) {
      return {
        ...expandMonthHint(monthYearMatch[2], monthIndex),
        granularity: "month"
      };
    }
  }

  if (yearHints.length > 0) {
    const year = yearHints[0];
    return {
      ...expandYearHint(year),
      granularity: "year"
    };
  }

  return {
    granularity: "none"
  };
}

function containsTemporalQuestion(queryText: string): boolean {
  return /\b(what was i doing|who was i with|where was i|when was i|back in|at that time)\b/i.test(queryText) || /\b(during|around)\b/i.test(queryText);
}

function containsHistoricalCue(queryText: string): boolean {
  return /\b(what was i doing|who was i with|where was i|when was i|back in|during|at time|at that time|then)\b/i.test(queryText);
}

function containsExplicitDateCue(queryText: string): boolean {
  return /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(queryText) || /\b(19\d{2}|20\d{2})\b/.test(queryText);
}

function targetLayersForGranularity(
  intent: RecallIntent,
  granularity: "none" | "day" | "month" | "year" | "broad"
): readonly TemporalQueryLayer[] {
  if (intent === "simple") {
    return [];
  }

  if (granularity === "day") {
    return ["day", "week", "month"];
  }

  if (granularity === "month") {
    return ["month", "week", "day"];
  }

  if (granularity === "year" || granularity === "broad") {
    return ["year", "month", "week", "day"];
  }

  return ["week", "day"];
}

export function planRecallQuery(query: RecallQuery): RecallPlan {
  const queryText = query.query.trim();
  const yearHints = uniqueSorted(queryText.match(/\b(19\d{2}|20\d{2})\b/g) ?? []);
  const hasExplicitWindow = Boolean(query.timeStart || query.timeEnd);
  const hasTemporalCue =
    containsTemporalQuestion(queryText) ||
    containsHistoricalCue(queryText) ||
    containsExplicitDateCue(queryText) ||
    yearHints.length > 0 ||
    hasExplicitWindow;

  const inferredWindow = !hasExplicitWindow ? inferTemporalWindow(queryText, yearHints) : { granularity: "broad" as const };
  const temporalGranularity = inferredWindow.granularity;
  const hasSpecificTimeWindow = temporalGranularity === "day" || temporalGranularity === "month" || temporalGranularity === "year" || temporalGranularity === "broad";
  const intent: RecallIntent = hasTemporalCue ? (hasSpecificTimeWindow ? "complex" : "hybrid") : "simple";
  const isNarrowWindow = temporalGranularity === "day" || temporalGranularity === "month";
  const isBroadTemporal = temporalGranularity === "year" || temporalGranularity === "broad";
  const targetLayers = targetLayersForGranularity(intent, temporalGranularity);

  return {
    intent,
    temporalFocus: hasTemporalCue,
    inferredTimeStart: inferredWindow?.start,
    inferredTimeEnd: inferredWindow?.end,
    yearHints,
    targetLayers,
    maxTemporalDepth: targetLayers.length,
    branchPreference: hasTemporalCue ? "episodic_then_temporal" : "lexical_first",
    candidateLimitMultiplier: !hasTemporalCue ? 4 : isNarrowWindow ? 4 : isBroadTemporal ? 6 : 5,
    episodicWeight: !hasTemporalCue ? 1 : isNarrowWindow ? 1.35 : isBroadTemporal ? 1.05 : 1.2,
    temporalSummaryWeight: !hasTemporalCue ? 1 : isNarrowWindow ? 1.05 : isBroadTemporal ? 1.3 : 1.15
  };
}
