import type {
  RecallIntent,
  RecallPlan,
  RecallQuery,
  TemporalDescendantLayer,
  TemporalLayerBudgetMap,
  TemporalQueryLayer
} from "./types.js";

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
  "back",
  "be",
  "by",
  "did",
  "do",
  "does",
  "doing",
  "during",
  "find",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
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
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "who",
  "with",
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

  if (normalized === "goal" || normalized === "goals") {
    return ["goal", "goals", "aim", "intent"];
  }

  if (normalized === "plan" || normalized === "plans") {
    return ["plan", "plans", "planning", "going to", "will"];
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

function expandRelativeLocalDay(offsetDays: number): { readonly start: string; readonly end: string } {
  const now = new Date();
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

function parseMonthName(monthName: string): number | undefined {
  return MONTH_LOOKUP.get(monthName.toLowerCase());
}

function inferTemporalWindow(queryText: string, yearHints: readonly string[]): {
  readonly start?: string;
  readonly end?: string;
  readonly granularity: "none" | "day" | "month" | "year" | "broad";
} {
  if (/\byesterday\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalDay(-1),
      granularity: "day"
    };
  }

  if (/\b(?:today|tonight)\b/i.test(queryText)) {
    return {
      ...expandRelativeLocalDay(0),
      granularity: "day"
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
  return (
    /\b(what was i doing|who was i with|where was i|when was i|back in|at that time)\b/i.test(queryText) ||
    /\bwhat\s+did\s+.+\s+do\s+(?:today|yesterday|tonight)\b/i.test(queryText) ||
    /\bwhat\s+happened\s+(?:today|yesterday|that\s+day)\b/i.test(queryText) ||
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

  const inferredWindow = !hasExplicitWindow ? inferTemporalWindow(queryText, yearHints) : { granularity: "broad" as const };
  const temporalGranularity = inferredWindow.granularity;
  const hasSpecificTimeWindow = temporalGranularity === "day" || temporalGranularity === "month" || temporalGranularity === "year" || temporalGranularity === "broad";
  const intent: RecallIntent = hasTemporalCue ? (hasSpecificTimeWindow ? "complex" : "hybrid") : "simple";
  const isNarrowWindow = temporalGranularity === "day" || temporalGranularity === "month";
  const isBroadTemporal = temporalGranularity === "year" || temporalGranularity === "broad";
  const targetLayers = targetLayersForGranularity(intent, temporalGranularity);
  const descendantExpansionOrder = descendantExpansionOrderForGranularity(temporalGranularity);
  const lexicalTerms = extractLexicalTerms(queryText, hasTemporalCue);
  const ancestorLayerBudgets = buildAncestorBudgets(intent);
  const descendantLayerBudgets = buildDescendantBudgets(intent);

  return {
    intent,
    temporalFocus: hasTemporalCue,
    inferredTimeStart: inferredWindow?.start,
    inferredTimeEnd: inferredWindow?.end,
    yearHints,
    lexicalTerms,
    targetLayers,
    descendantExpansionOrder,
    maxTemporalDepth: targetLayers.length,
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
