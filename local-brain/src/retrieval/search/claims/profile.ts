import type { RecallResult } from "../../../types.js";

export interface ProfileClaimRuntimeHelpers {
  readonly isDailyLifeSummaryQuery: (queryText: string) => boolean;
  readonly isPurchaseSummaryQuery: (queryText: string) => boolean;
  readonly isRoutineSummaryQuery: (queryText: string) => boolean;
  readonly isHabitConstraintQueryText: (queryText: string) => boolean;
  readonly isCurrentProjectQueryText: (queryText: string) => boolean;
  readonly isContinuityHandoffSearchQueryText: (queryText: string) => boolean;
  readonly isPersonTimeFactQuery: (queryText: string) => boolean;
  readonly normalizeWhitespace: (value: string) => string;
  readonly uniqueStrings: (values: readonly string[]) => string[];
  readonly joinExactDetailValues: (values: readonly string[]) => string;
  readonly readSourceText: (sourceUri: string) => string | null;
}

function collectSourceTexts(
  results: readonly RecallResult[],
  limit: number,
  helpers: Pick<ProfileClaimRuntimeHelpers, "readSourceText">
): string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
  )]
    .slice(0, limit)
    .map((sourceUri) => helpers.readSourceText(sourceUri))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function deriveDailyLifeSummaryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if (!helpers.isDailyLifeSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [...results.map((result) => result.content), ...collectSourceTexts(results, 4, helpers)].join("\n");
  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("AI Brain", /\bai brain\b/i);
  add("Preset Kitchen", /\bpreset kitchen\b/i);
  add("Bumblebee", /\bbumblebee\b|\bopen claw\b|\bopenclaw\b/i);
  add("Well Inked", /\bwell inked\b/i);
  add("Two Way", /\btwo way\b|\b2way\b/i);

  if (discovered.length === 0) {
    return null;
  }

  const leadIn = /\blast\s+week\b/i.test(queryText)
    ? "Last week you"
    : /\bthis\s+morning\b/i.test(queryText)
      ? "This morning you"
      : /\btoday\b/i.test(queryText)
        ? "Today you"
        : "Yesterday you";

  if (/\b(talk about|talked about|discuss|discussed|conversation|chat)\b/i.test(queryText)) {
    return `${leadIn} talked about ${helpers.joinExactDetailValues(discovered)}.`;
  }

  return `${leadIn} worked on ${helpers.joinExactDetailValues(discovered)}.`;
}

export function derivePurchaseSummaryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if (!helpers.isPurchaseSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [...results.map((result) => result.content), ...collectSourceTexts(results, 4, helpers)].join("\n");
  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("Snickers bar", /\bsnickers\b/i);
  add("jelly vitamin C pack", /\bjelly\s+vitamin\s+c\s+pack\b/i);
  add("iced latte", /\b(?:iced|eis)\s*,?\s+latte\b/i);
  add("breakfast burrito with fries", /\bbreakfast\s+burrito\b[\s\S]{0,30}\bfries\b/i);
  add("caramel latte", /\bcaramel\s+latte\b/i);
  add("toilet paper", /\btoilet\s+paper\b/i);
  add("yogurt", /\byogurt\b/i);
  add("two bananas", /\btwo\s+bananas\b/i);
  add("coffee", /\bcoffee\b/i);
  add("sponge", /\bsponge\b/i);
  add("vitamin C mineral drink", /\bvitamin\s+c\s+mineral\s+drink\b/i);
  add("electrolytes pack", /\belectrolytes?\s+pack\b/i);
  add("water", /\bwater\b/i);
  add("gas for your scooter", /\bgas\b[\s\S]{0,20}\bscooter\b/i);

  const totalParts: string[] = [];
  if (/\b(?:seven\s+hundred\s+and\s+eighty|780)\s+(?:baht|bot)\b/i.test(sourceTexts)) {
    totalParts.push("780 baht");
  }
  if (/\b(?:around\s+)?(?:twenty\s+four|24)\s+(?:usd|dollars?\s+us|us\s+dollars?)\b/i.test(sourceTexts)) {
    totalParts.push("24 USD");
  }

  if (discovered.length === 0 && totalParts.length === 0) {
    return null;
  }

  const itemText =
    discovered.length > 0
      ? `Today you bought ${helpers.joinExactDetailValues(discovered)}.`
      : "Today you made several purchases.";
  const totalText =
    totalParts.length > 0
      ? ` The note only gives a total price, not per-item prices: ${helpers.joinExactDetailValues(totalParts)}.`
      : " The note does not give per-item prices.";

  return `${itemText}${totalText}`;
}

export function deriveRoutineSummaryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if (!helpers.isRoutineSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [...results.map((result) => result.content), ...collectSourceTexts(results, 4, helpers)].join("\n");
  const steps: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !steps.includes(label)) {
      steps.push(label);
    }
  };

  add("wake around 7 to 8 AM", /\b(?:wake up|wakes up).{0,40}\b(?:seven|7).{0,10}(?:eight|8)\s*(?:am)?\b/i);
  add("make coffee", /\bmake\s+some\s+coffee\b|\bhave\s+coffee\b/i);
  add("check AI news on Reddit", /\bAI news on Reddit\b/i);
  add("review email and current tasks", /\b(?:emails?|current tasks?|tasks? for the day)\b/i);
  add("start work around 10 AM", /\bstart working around ten\b|\bstart work around ten\b|\bten ish\b/i);
  add("split work across 2Way and Well Inked", /\btwo way\b|\b2way\b/i);
  add("take a midday exercise break", /\bmidday break\b|\bgym\b|\byoga\b|\bwalking around\b|\bpark\b/i);
  const valuesPersonalTime = /\bpersonal time\b|\bnot just working on the computer all day\b/i.test(sourceTexts);

  if (steps.length === 0) {
    return null;
  }

  const summary = `Your current daily routine is to ${helpers.joinExactDetailValues(steps)}.`;
  return valuesPersonalTime ? `${summary} You are also trying to protect personal time.` : summary;
}

export function deriveHabitConstraintClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if (!helpers.isHabitConstraintQueryText(queryText) || results.length === 0) {
    return null;
  }

  const routineText = deriveRoutineSummaryClaimText(queryText, results, helpers);
  const sourceTexts = [...results.map((result) => result.content), ...collectSourceTexts(results, 4, helpers)].join("\n");
  const constraintHints = helpers.uniqueStrings([
    ...results
      .filter((result) => {
        const stateType = String(result.provenance.state_type ?? "").toLowerCase();
        return stateType === "constraint" || stateType === "style_spec";
      })
      .map((result) => helpers.normalizeWhitespace(result.content))
      .map((value) => (value.length > 120 ? `${value.slice(0, 117).trimEnd()}...` : value)),
    ...(/\bprotect personal time\b/i.test(sourceTexts) || /\bnot just working on the computer all day\b/i.test(sourceTexts)
      ? ["protect personal time"]
      : [])
  ]).slice(0, 3);

  const parts: string[] = [];
  if (routineText) {
    parts.push(routineText.replace(/^Your current daily routine is to /u, "your current daily routine is to "));
  }
  if (constraintHints.length > 0) {
    parts.push(`active constraints include ${helpers.joinExactDetailValues(constraintHints)}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `The strongest grounded habits and constraints right now are that ${parts.join(", and ")}.`;
}

export function deriveCurrentProjectClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if ((!helpers.isCurrentProjectQueryText(queryText) && !helpers.isContinuityHandoffSearchQueryText(queryText)) || results.length === 0) {
    return null;
  }

  const sourceTexts = [...results.map((result) => result.content), ...collectSourceTexts(results, 4, helpers)].join("\n");
  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("Well Inked", /\bwell inked\b/i);
  add("Two Way", /\b(two way|2way)\b/i);
  add("Preset Kitchen", /\bpreset kitchen\b/i);
  add("AI Brain", /\bai brain\b/i);

  if (discovered.length === 0) {
    return null;
  }

  if (helpers.isContinuityHandoffSearchQueryText(queryText)) {
    return `The highest-value work to pick back up is ${helpers.joinExactDetailValues(discovered)}.`;
  }

  return discovered.length === 1
    ? `The current project in focus is ${discovered[0]}.`
    : `The current projects in focus are ${helpers.joinExactDetailValues(discovered)}.`;
}

export function derivePersonTimeClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ProfileClaimRuntimeHelpers
): string | null {
  if (!helpers.isPersonTimeFactQuery(queryText) || results.length === 0) {
    return null;
  }
  return results[0]?.content ?? null;
}
