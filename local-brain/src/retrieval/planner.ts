import type {
  RecallIntent,
  RecallQueryClass,
  RecallPlan,
  RecallQuery,
  TemporalDescendantLayer,
  TemporalLayerBudgetMap,
  TemporalQueryLayer
} from "./types.js";
import { isConstraintQuery, isHierarchyTraversalQuery } from "./query-signals.js";

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

const PLANNER_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "around",
  "as",
  "at",
  "after",
  "back",
  "be",
  "both",
  "by",
  "did",
  "decide",
  "decided",
  "do",
  "does",
  "doing",
  "done",
  "during",
  "end",
  "each",
  "find",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "like",
  "likely",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "show",
  "she",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "use",
  "uses",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "why",
  "you",
  "your"
]);

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function expandLexicalVariants(term: string): readonly string[] {
  const normalized = term.toLowerCase();
  if (normalized === "activities" || normalized === "activity") {
    return ["activity", "sport"];
  }

  if (normalized === "movies" || normalized === "movie") {
    return ["movie", "film"];
  }

  if (normalized === "watch" || normalized === "watched" || normalized === "watching" || normalized === "saw" || normalized === "seen") {
    return ["watch", "watched", "saw", "seen"];
  }

  if (normalized === "leave" || normalized === "left" || normalized === "leaving" || normalized === "departed" || normalized === "returned") {
    return ["leave", "left", "departed", "returned"];
  }

  if (normalized === "stored" || normalized === "storage" || normalized === "store" || normalized === "stored_at") {
    return ["stored", "storage", "store"];
  }

  if (normalized === "things" || normalized === "stuff" || normalized === "belongings" || normalized === "possessions") {
    return ["things", "stuff", "possessions"];
  }

  if (normalized === "skills" || normalized === "skill") {
    return ["skill", "capability", "proficiency"];
  }

  if (normalized === "routine" || normalized === "routines" || normalized === "habit" || normalized === "habits") {
    return ["routine", "routines", "habit", "habits", "cadence", "weekly"];
  }

  if (normalized === "decision" || normalized === "decisions") {
    return ["decision", "decided", "choice"];
  }

  if (normalized === "constraint" || normalized === "constraints" || normalized === "rule" || normalized === "rules") {
    return ["constraint", "rule", "policy"];
  }

  if (normalized === "style" || normalized === "styles" || normalized === "style_spec" || normalized === "style_specs") {
    return ["style", "style spec", "work style", "response style", "format", "concise"];
  }

  if (normalized === "blocker" || normalized === "blockers" || normalized === "dietary" || normalized === "allergy" || normalized === "allergies") {
    return ["blocker", "blockers", "dietary", "allergy", "allergic", "never", "absolute", "peanut"];
  }

  if (normalized === "pdf" || normalized === "pdfs") {
    return ["pdf", "pdfs", "upload", "uploads", "chunk", "chunking", "50mb"];
  }

  if (normalized === "protocol" || normalized === "protocols") {
    return ["protocol", "policy", "rule", "rules", "mandatory"];
  }

  if (normalized === "signoff" || normalized === "sign-off" || normalized === "owner" || normalized === "ownership") {
    return ["signoff", "sign-off", "owner", "ownership", "approval", "role"];
  }

  if (normalized === "concurrency" || normalized === "concurrent") {
    return ["concurrency", "concurrent", "worker", "workers", "high-concurrency", "parallel"];
  }

  if (normalized === "python" || normalized === "rust") {
    return [normalized, "worker", "workers", "high-concurrency"];
  }

  if (normalized === "goal" || normalized === "goals") {
    return ["goal", "goals", "aim", "intent"];
  }

  if (normalized === "plan" || normalized === "plans") {
    return ["plan", "plans", "planning", "going to", "will"];
  }

  if (normalized === "destress" || normalized === "de-stress" || normalized === "distress") {
    return ["stress"];
  }

  if (normalized === "identity" || normalized === "identities") {
    return ["identity"];
  }

  return [term];
}

function tokenizeQuery(queryText: string): readonly string[] {
  return queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [];
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

type InferredTemporalWindow = {
  readonly start?: string;
  readonly end?: string;
  readonly granularity: "none" | "day" | "month" | "year" | "broad";
};

function normalizeReferenceNow(referenceNow?: string): Date {
  const parsed = referenceNow ? new Date(referenceNow) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function shiftTemporalWindow(
  window: InferredTemporalWindow,
  quantity: number,
  unit: string
): InferredTemporalWindow | null {
  if (!window.start || !window.end) {
    return null;
  }

  const shiftedStart = shiftDate(new Date(window.start), quantity, unit);
  const shiftedEnd = shiftDate(new Date(window.end), quantity, unit);
  return {
    start: shiftedStart.toISOString(),
    end: shiftedEnd.toISOString(),
    granularity: window.granularity
  };
}

function expandRelativeLocalDay(offsetDays: number, referenceNow?: string): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);

  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandRelativeLocalWeek(offsetWeeks: number, referenceNow?: string): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dayOfWeek = start.getDay();
  start.setDate(start.getDate() - dayOfWeek + offsetWeeks * 7);

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandRelativeLocalMonth(offsetMonths: number, referenceNow?: string): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const start = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + offsetMonths + 1, 0, 23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandRelativeLocalYear(offsetYears: number, referenceNow?: string): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const start = new Date(now.getFullYear() + offsetYears, 0, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear() + offsetYears, 11, 31, 23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function parseMonthName(monthName: string): number | undefined {
  return MONTH_LOOKUP.get(monthName.toLowerCase());
}

function expandRelativeLocalWeekend(offsetWeeks: number, referenceNow?: string): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dayOfWeek = start.getDay();
  const saturdayOffset = dayOfWeek === 6 ? 0 : 6 - dayOfWeek;
  start.setDate(start.getDate() + saturdayOffset + offsetWeeks * 7);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandCurrentPeriodToReference(
  unit: "week" | "month" | "year",
  referenceNow?: string
): { readonly start: string; readonly end: string } {
  const now = normalizeReferenceNow(referenceNow);
  const end = new Date(now);

  if (unit === "week") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay());
    return {
      start: start.toISOString(),
      end: end.toISOString()
    };
  }

  if (unit === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return {
      start: start.toISOString(),
      end: end.toISOString()
    };
  }

  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function expandEarlierCurrentPeriodToReference(
  unit: "week" | "month" | "year",
  referenceNow?: string
): { readonly start: string; readonly end: string } {
  // "Earlier this month/week/year" is still anchored to the current reference instant.
  // The planner should open the window from the start of the current period through "now",
  // not truncate it to an arbitrary midpoint.
  return expandCurrentPeriodToReference(unit, referenceNow);
}

function seasonWindow(
  season: "spring" | "summer" | "fall" | "autumn" | "winter",
  year: number
): { readonly start: string; readonly end: string } {
  switch (season) {
    case "spring":
      return {
        start: new Date(Date.UTC(year, 2, 1, 0, 0, 0, 0)).toISOString(),
        end: new Date(Date.UTC(year, 4, 31, 23, 59, 59, 999)).toISOString()
      };
    case "summer":
      return {
        start: new Date(Date.UTC(year, 5, 1, 0, 0, 0, 0)).toISOString(),
        end: new Date(Date.UTC(year, 7, 31, 23, 59, 59, 999)).toISOString()
      };
    case "fall":
    case "autumn":
      return {
        start: new Date(Date.UTC(year, 8, 1, 0, 0, 0, 0)).toISOString(),
        end: new Date(Date.UTC(year, 10, 30, 23, 59, 59, 999)).toISOString()
      };
    case "winter":
    default:
      return {
        start: new Date(Date.UTC(year, 11, 1, 0, 0, 0, 0)).toISOString(),
        end: new Date(Date.UTC(year + 1, 1, 28, 23, 59, 59, 999)).toISOString()
      };
  }
}

function parseNumericWord(value: string): number | null {
  const normalized = value.toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  switch (normalized) {
    case "one":
      return 1;
    case "two":
      return 2;
    case "three":
      return 3;
    case "four":
      return 4;
    case "five":
      return 5;
    default:
      return null;
  }
}

function shiftDate(base: Date, quantity: number, unit: string): Date {
  const shifted = new Date(base);
  switch (unit) {
    case "day":
    case "days":
      shifted.setDate(shifted.getDate() + quantity);
      break;
    case "week":
    case "weeks":
      shifted.setDate(shifted.getDate() + quantity * 7);
      break;
    case "month":
    case "months":
      shifted.setMonth(shifted.getMonth() + quantity);
      break;
    case "year":
    case "years":
      shifted.setFullYear(shifted.getFullYear() + quantity);
      break;
    default:
      break;
  }
  return shifted;
}

function inferBaseTemporalWindow(queryText: string, yearHints: readonly string[], referenceNow?: string): InferredTemporalWindow {
  const sinceDayMonthYearMatch = queryText.match(
    /\bsince\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(19\d{2}|20\d{2})\b/i
  );
  if (sinceDayMonthYearMatch) {
    const monthIndex = parseMonthName(sinceDayMonthYearMatch[1]);
    if (monthIndex !== undefined) {
      const start = expandDayHint(sinceDayMonthYearMatch[3], monthIndex, Number(sinceDayMonthYearMatch[2]));
      return {
        start: start.start,
        end: normalizeReferenceNow(referenceNow).toISOString(),
        granularity: "broad"
      };
    }
  }

  const sinceMonthYearMatch = queryText.match(
    /\bsince\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(19\d{2}|20\d{2})\b/i
  );
  if (sinceMonthYearMatch) {
    const monthIndex = parseMonthName(sinceMonthYearMatch[1]);
    if (monthIndex !== undefined) {
      const start = expandMonthHint(sinceMonthYearMatch[2], monthIndex);
      return {
        start: start.start,
        end: normalizeReferenceNow(referenceNow).toISOString(),
        granularity: "broad"
      };
    }
  }

  const sinceYearMatch = queryText.match(/\bsince\s+(19\d{2}|20\d{2})\b/i);
  if (sinceYearMatch) {
    const start = expandYearHint(sinceYearMatch[1]);
    return {
      start: start.start,
      end: normalizeReferenceNow(referenceNow).toISOString(),
      granularity: "broad"
    };
  }

  if (/\byesterday\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalDay(-1, referenceNow),
      granularity: "day"
    };
  }

  if (/\b(?:today|tonight)\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalDay(0, referenceNow),
      granularity: "day"
    };
  }

  if (/\blast\s+night\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalDay(-1, referenceNow),
      granularity: "day"
    };
  }

  if (/\bthis\s+weekend\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalWeekend(0, referenceNow),
      granularity: "broad"
    };
  }

  if (/\blast\s+weekend\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalWeekend(-1, referenceNow),
      granularity: "broad"
    };
  }

  if (/\b(?:the\s+)?weekend\s+before\s+last\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalWeekend(-2, referenceNow),
      granularity: "broad"
    };
  }

  const weekendsAgoMatch = queryText.match(/\b(one|two|three|four|five|\d+)\s+weekends?\s+ago\b/i);
  if (weekendsAgoMatch) {
    const quantity = parseNumericWord(weekendsAgoMatch[1] ?? "");
    if (quantity !== null && quantity > 0) {
      return {
        ...expandRelativeLocalWeekend(-quantity, referenceNow),
        granularity: "broad"
      };
    }
  }

  if (/\bearlier\s+this\s+week\b/i.test(queryText)) {
    return {
      ...expandEarlierCurrentPeriodToReference("week", referenceNow),
      granularity: "broad"
    };
  }

  if (/\bearlier\s+this\s+month\b/i.test(queryText)) {
    return {
      ...expandEarlierCurrentPeriodToReference("month", referenceNow),
      granularity: "month"
    };
  }

  if (/\bearlier\s+this\s+year\b/i.test(queryText)) {
    return {
      ...expandEarlierCurrentPeriodToReference("year", referenceNow),
      granularity: "year"
    };
  }

  if (/\bthis\s+week\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalWeek(0, referenceNow),
      granularity: "broad"
    };
  }

  if (/\blast\s+week\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalWeek(-1, referenceNow),
      granularity: "broad"
    };
  }

  if (/\bthis\s+month\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalMonth(0, referenceNow),
      granularity: "month"
    };
  }

  if (/\blast\s+month\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalMonth(-1, referenceNow),
      granularity: "month"
    };
  }

  if (/\bthis\s+year\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalYear(0, referenceNow),
      granularity: "year"
    };
  }

  if (/\blast\s+year\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalYear(-1, referenceNow),
      granularity: "year"
    };
  }

  const agoMatch = queryText.match(/\b(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/i);
  if (agoMatch) {
    const quantity = Number(agoMatch[1]);
    const unit = agoMatch[2].toLowerCase();
    const now = normalizeReferenceNow(referenceNow);
    const anchor = shiftDate(now, -quantity, unit);
    if (unit.startsWith("day")) {
      return {
        ...expandDayHint(String(anchor.getUTCFullYear()), anchor.getUTCMonth(), anchor.getUTCDate()),
        granularity: "day"
      };
    }
    if (unit.startsWith("week")) {
      return {
        ...expandRelativeLocalWeek(-quantity, referenceNow),
        granularity: "broad"
      };
    }
    if (unit.startsWith("month")) {
      return {
        ...expandMonthHint(String(anchor.getUTCFullYear()), anchor.getUTCMonth()),
        granularity: "month"
      };
    }
    return {
      ...expandYearHint(String(anchor.getUTCFullYear())),
      granularity: "year"
    };
  }

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

  const explicitSeasonMatch = queryText.match(/\b(spring|summer|fall|autumn|winter)\s+(19\d{2}|20\d{2})\b/i);
  if (explicitSeasonMatch) {
    return {
      ...seasonWindow(explicitSeasonMatch[1].toLowerCase() as "spring" | "summer" | "fall" | "autumn" | "winter", Number(explicitSeasonMatch[2])),
      granularity: "broad"
    };
  }

  const relativeSeasonMatch = queryText.match(/\b(this|last)\s+(spring|summer|fall|autumn|winter)\b/i);
  if (relativeSeasonMatch) {
    const now = normalizeReferenceNow(referenceNow);
    const year = relativeSeasonMatch[1].toLowerCase() === "last" ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    return {
      ...seasonWindow(relativeSeasonMatch[2].toLowerCase() as "spring" | "summer" | "fall" | "autumn" | "winter", year),
      granularity: "broad"
    };
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

function inferComplexRelativeTemporalWindow(
  queryText: string,
  yearHints: readonly string[],
  referenceNow?: string
): InferredTemporalWindow | null {
  const normalized = queryText.trim();
  if (!normalized) {
    return null;
  }

  const beforeAfterMatch = normalized.match(
    /\b(one|two|three|four|five|\d+)\s+(day|days|week|weeks|month|months|year|years)\s+(after|before)\s+(.+?)\??$/i
  );
  if (beforeAfterMatch) {
    const quantity = parseNumericWord(beforeAfterMatch[1] ?? "");
    const unit = (beforeAfterMatch[2] ?? "").toLowerCase();
    const direction = (beforeAfterMatch[3] ?? "").toLowerCase() === "after" ? 1 : -1;
    const anchorText = (beforeAfterMatch[4] ?? "").trim();
    const anchorWindow = inferBaseTemporalWindow(anchorText, yearHints, referenceNow);
    if (quantity !== null && quantity > 0 && anchorWindow.start && anchorWindow.end) {
      return shiftTemporalWindow(anchorWindow, direction * quantity, unit);
    }
  }

  const anchoredSamePeriodMatch = normalized.match(/\b(?:later|earlier)\s+that\s+(night|morning|afternoon|evening|day|week|month|year|weekend)\b/i);
  if (anchoredSamePeriodMatch) {
    const stripped = normalized.replace(/\b(?:later|earlier)\s+that\s+(night|morning|afternoon|evening|day|week|month|year|weekend)\b/iu, " ");
    const anchorWindow = inferBaseTemporalWindow(stripped, yearHints, referenceNow);
    if (anchorWindow.start && anchorWindow.end) {
      return anchorWindow;
    }
  }

  return null;
}

function inferTemporalWindow(queryText: string, yearHints: readonly string[], referenceNow?: string): InferredTemporalWindow {
  const complexWindow = inferComplexRelativeTemporalWindow(queryText, yearHints, referenceNow);
  if (complexWindow) {
    return complexWindow;
  }

  return inferBaseTemporalWindow(queryText, yearHints, referenceNow);
}

function containsTemporalQuestion(queryText: string): boolean {
  return (
    /\b(what was i doing|who was i with|where was i|when was i|back in|at that time)\b/i.test(queryText) ||
    /\bwhat\s+did\s+.+\s+do\s+(?:today|yesterday|tonight)\b/i.test(queryText) ||
    /\bwhat\s+happened\s+(?:today|yesterday|that\s+day)\b/i.test(queryText) ||
    /\b(?:last|this)\s+(?:week|month|year|night|weekend|spring|summer|fall|autumn|winter)\b/i.test(queryText) ||
    /\bearlier\s+this\s+(?:week|month|year)\b/i.test(queryText) ||
    /\b(?:one|two|three|four|five|\d+)\s+weekends?\s+ago\b/i.test(queryText) ||
    /\bweekend\s+before\s+last\b/i.test(queryText) ||
    /\b(?:one|two|three|four|five|\d+)\s+(?:day|days|week|weeks|month|months|year|years)\s+(?:after|before)\b/i.test(queryText) ||
    /\b(?:that|later\s+that)\s+(?:night|morning|afternoon|evening)\b/i.test(queryText) ||
    /\b(?:later|earlier)\s+that\s+(?:day|week|month|year|weekend)\b/i.test(queryText) ||
    /\bwho\s+was\s+.+\s+with\s+on\b/i.test(queryText) ||
    /\bwhere\s+did\s+.+\s+go\s+on\b/i.test(queryText) ||
    /\b(during|around)\b/i.test(queryText)
  );
}

function containsHistoricalCue(queryText: string): boolean {
  return /\b(what was i doing|who was i with|where was i|when was i|back in|during|at time|at that time|then)\b/i.test(queryText);
}

function containsExplicitDateCue(queryText: string): boolean {
  return (
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(queryText) ||
    tokenizeQuery(queryText).some((token) => /^(19\d{2}|20\d{2})$/.test(token))
  );
}

function isTemporalDetailQueryText(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const hasTemporalCue =
    /^\s*when\b/i.test(normalized) ||
    /\bwhen\s+(?:did|was|were|has|have)\b/i.test(normalized) ||
    /\bon\s+[A-Z][a-z]+\s+\d{1,2}(?:,\s*|\s+)\d{4}\b/.test(normalized) ||
    /\bon\s+\d{4}-\d{2}-\d{2}\b/.test(normalized) ||
    /\b(today|yesterday|tonight|this\s+(?:day|week|month|year|weekend)|that\s+(?:day|night|morning|afternoon|evening)|last\s+(?:day|week|month|year|weekend|night))\b/i.test(normalized) ||
    /\b(?:one|two|three|four|five|\d+)\s+(?:day|days|week|weeks|month|months|year|years)\s+(?:after|before)\b/i.test(normalized) ||
    /\b(19\d{2}|20\d{2})\b/.test(normalized);

  if (!hasTemporalCue) {
    return false;
  }

  return (
    /\bhow\s+much\b/i.test(normalized) ||
    /\bhow\s+many\b/i.test(normalized) ||
    /\bwhat\s+time\b/i.test(normalized) ||
    /\bwhen\s+exactly\b/i.test(normalized) ||
    /^\s*when\b/i.test(normalized) ||
    /\bwhen\s+(?:did|was|were|has|have)\b/i.test(normalized) ||
    /\bwho\s+was\s+.+\s+with\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\b/i.test(normalized) ||
    /\bwhere\s+was\s+.+\b/i.test(normalized) ||
    /\b(?:after|before)\b.+\bon\b/i.test(normalized) ||
    /\b(?:later\s+that|that)\s+(?:night|morning|afternoon|evening)\b/i.test(normalized) ||
    /\bwhich\s+\w+\b/i.test(normalized) ||
    /\bexact\b/i.test(normalized) ||
    /\b(?:cost|price|amount|paid|pay|spent|spend|invoice|receipt|fee|fees)\b/i.test(normalized)
  );
}

function isWhyLikeQuery(queryText: string): boolean {
  return /\bwhy\b/i.test(queryText) || /\brationale\b/i.test(queryText);
}

function isGraphMultiHopQuery(queryText: string): boolean {
  return (
    isHierarchyTraversalQuery(queryText) ||
    /\bthrough\b/i.test(queryText) ||
    /\bconnected\s+to\b/i.test(queryText) ||
    /\bexpand\b/i.test(queryText) ||
    /\bgraph\b/i.test(queryText) ||
    /\bin\s+common\b/i.test(queryText) ||
    /\b(?:what|how)\s+do\s+.+\s+and\s+.+\s+both\b/i.test(queryText) ||
    /\bwhich\s+places?\b.*\bhas\b/i.test(queryText) ||
    /\bpartner\b/i.test(queryText)
  );
}

function inferQueryClass(
  queryText: string,
  temporalFocus: boolean,
  temporalGranularity: "none" | "day" | "month" | "year" | "broad"
): RecallQueryClass {
  if (isWhyLikeQuery(queryText)) {
    return "causal";
  }

  if (isGraphMultiHopQuery(queryText)) {
    return "graph_multi_hop";
  }

  if (isTemporalDetailQueryText(queryText)) {
    return "temporal_detail";
  }

  if (isConstraintQuery(queryText)) {
    return "direct_fact";
  }

  if (temporalFocus || temporalGranularity !== "none") {
    return "temporal_summary";
  }

  return "direct_fact";
}

function isCodeOrVersionToken(token: string): boolean {
  return /[-.:]/.test(token) || (/\d/.test(token) && /[A-Za-z]/.test(token));
}

function buildDescendantBudgets(intent: RecallIntent): TemporalLayerBudgetMap {
  if (intent === "complex") {
    return {
      session: 0,
      day: 8,
      week: 4,
      month: 2,
      year: 0,
      profile: 0
    };
  }

  if (intent === "hybrid") {
    return {
      session: 0,
      day: 4,
      week: 2,
      month: 1,
      year: 0,
      profile: 0
    };
  }

  return {
    session: 0,
    day: 2,
    week: 0,
    month: 0,
    year: 0,
    profile: 0
  };
}

function buildAncestorBudgets(intent: RecallIntent): TemporalLayerBudgetMap {
  if (intent === "complex") {
    return {
      session: 0,
      day: 2,
      week: 2,
      month: 2,
      year: 1,
      profile: 0
    };
  }

  if (intent === "hybrid") {
    return {
      session: 0,
      day: 1,
      week: 1,
      month: 1,
      year: 0,
      profile: 0
    };
  }

  return {
    session: 0,
    day: 1,
    week: 0,
    month: 0,
    year: 0,
    profile: 0
  };
}

function extractLexicalTerms(queryText: string, temporalFocus: boolean): readonly string[] {
  const tokens = tokenizeQuery(queryText);
  const scored = new Map<
    string,
    {
      readonly term: string;
      readonly score: number;
      readonly position: number;
    }
  >();

  tokens.forEach((token, index) => {
    const normalized = token.toLowerCase();
    const isMonth = MONTH_LOOKUP.has(normalized);
    const isYear = /^\d{4}$/.test(token);
    const isCodeOrVersion = isCodeOrVersionToken(token);
    const isAcronym = /^[A-Z0-9]{2,}$/.test(token);
    const isCapitalized = /^[A-Z][a-z]+$/.test(token);

    if (PLANNER_STOP_WORDS.has(normalized)) {
      return;
    }

    if (temporalFocus && (isMonth || isYear)) {
      return;
    }

    if (temporalFocus && /^\d{1,2}$/.test(token)) {
      return;
    }

    if (!isCodeOrVersion && !isAcronym && normalized.length < 3) {
      return;
    }

    let score = 1;
    if (isCodeOrVersion) {
      score += 6;
    }
    if (isAcronym) {
      score += 5;
    }
    if (isCapitalized && !isMonth) {
      score += 4;
    }
    if (!temporalFocus && isYear) {
      score += 2;
    }
    if (/^(trip|travel|itinerary|flight|flights|hotel|kyoto|tokyo|japan|dinner|dinners|breakfast|lunch|redesign|graph|relationship|timeline|preference|coffee|spicy|sweet)$/i.test(token)) {
      score += 2;
    }

    const existing = scored.get(normalized);
    if (!existing || score > existing.score || (score === existing.score && index < existing.position)) {
      scored.set(normalized, {
        term: token,
        score,
        position: index
      });
    }
  });

  const budget = temporalFocus ? 4 : 4;

  const baseTerms = [...scored.values()]
    .sort((left, right) => (right.score - left.score) || (left.position - right.position))
    .slice(0, budget)
    .map((item) => item.term);

  return [...new Set(baseTerms.flatMap((term) => expandLexicalVariants(term)))].slice(0, 6);
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

function descendantExpansionOrderForGranularity(
  granularity: "none" | "day" | "month" | "year" | "broad"
): readonly TemporalDescendantLayer[] {
  if (granularity === "year" || granularity === "broad") {
    return ["month", "week", "day"];
  }

  if (granularity === "month") {
    return ["week", "day"];
  }

  if (granularity === "none") {
    return ["day"];
  }

  return [];
}

function inferExplicitWindowGranularity(timeStart?: string, timeEnd?: string): "none" | "day" | "month" | "year" | "broad" {
  if (!timeStart || !timeEnd) {
    return "none";
  }

  const start = Date.parse(timeStart);
  const end = Date.parse(timeEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return "broad";
  }

  const durationDays = (end - start) / (1000 * 60 * 60 * 24);
  if (durationDays <= 1.1) {
    return "day";
  }
  if (durationDays <= 45) {
    return "month";
  }
  if (durationDays <= 370) {
    return "year";
  }
  return "broad";
}

export function planRecallQuery(query: RecallQuery): RecallPlan {
  const queryText = query.query.trim();
  const tokenizedQuery = tokenizeQuery(queryText);
  const yearHints = uniqueSorted(tokenizedQuery.filter((token) => /^(19\d{2}|20\d{2})$/.test(token)));
  const hasExplicitWindow = Boolean(query.timeStart || query.timeEnd);
  const hasTemporalCue =
    containsTemporalQuestion(queryText) ||
    containsHistoricalCue(queryText) ||
    containsExplicitDateCue(queryText) ||
    yearHints.length > 0 ||
    hasExplicitWindow;

  const inferredWindow = !hasExplicitWindow
    ? inferTemporalWindow(queryText, yearHints, query.referenceNow)
    : {
        start: query.timeStart,
        end: query.timeEnd,
        granularity: inferExplicitWindowGranularity(query.timeStart, query.timeEnd)
      };
  const temporalGranularity = inferredWindow.granularity;
  const hasSpecificTimeWindow = temporalGranularity === "day" || temporalGranularity === "month" || temporalGranularity === "year" || temporalGranularity === "broad";
  const queryClass = inferQueryClass(queryText, hasTemporalCue, temporalGranularity);
  const hierarchyFocus = isHierarchyTraversalQuery(queryText);
  const intent: RecallIntent =
    queryClass === "causal" || queryClass === "graph_multi_hop" || queryClass === "temporal_detail"
      ? "complex"
      : hasTemporalCue
        ? (hasSpecificTimeWindow ? "complex" : "hybrid")
        : "simple";
  const isNarrowWindow = temporalGranularity === "day" || temporalGranularity === "month";
  const isBroadTemporal = temporalGranularity === "year" || temporalGranularity === "broad";
  const targetLayers = targetLayersForGranularity(intent, temporalGranularity);
  const descendantExpansionOrder = descendantExpansionOrderForGranularity(temporalGranularity);
  const lexicalTerms = extractLexicalTerms(queryText, hasTemporalCue);
  const ancestorLayerBudgets = buildAncestorBudgets(intent);
  const descendantLayerBudgets = buildDescendantBudgets(intent);

  return {
    intent,
    queryClass,
    temporalFocus: hasTemporalCue,
    leafEvidenceRequired:
      queryClass === "causal" || queryClass === "temporal_detail" || (queryClass === "graph_multi_hop" && !hierarchyFocus),
    inferredTimeStart: inferredWindow?.start,
    inferredTimeEnd: inferredWindow?.end,
    yearHints,
    lexicalTerms,
    targetLayers,
    descendantExpansionOrder,
    maxTemporalDepth: targetLayers.length,
    hierarchyExpansionBudget: queryClass === "graph_multi_hop" ? 8 : queryClass === "causal" ? 6 : 4,
    graphHopBudget: queryClass === "graph_multi_hop" ? 3 : queryClass === "causal" ? 2 : 1,
    ancestorLayerBudgets,
    descendantLayerBudgets,
    supportMemberBudget: intent === "complex" ? 8 : intent === "hybrid" ? 6 : 3,
    temporalSufficiencyEpisodicThreshold: intent === "complex" ? 4 : intent === "hybrid" ? 3 : 2,
    temporalSufficiencyTemporalThreshold: intent === "complex" ? 1 : intent === "hybrid" ? 1 : 0,
    temporalSupportMaxTokens: intent === "complex" ? 180 : intent === "hybrid" ? 120 : 80,
    branchPreference: hasTemporalCue ? "episodic_then_temporal" : "lexical_first",
    candidateLimitMultiplier: !hasTemporalCue ? 4 : isNarrowWindow ? 4 : isBroadTemporal ? 6 : 5,
    episodicWeight: !hasTemporalCue ? 1 : isNarrowWindow ? 1.35 : isBroadTemporal ? 1.05 : 1.2,
    temporalSummaryWeight: !hasTemporalCue ? 1 : isNarrowWindow ? 1.05 : isBroadTemporal ? 1.3 : 1.15
  };
}
