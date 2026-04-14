function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function ordinalDay(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function formatUtcMonthDayOrdinal(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long" })} ${ordinalDay(date.getUTCDate())}`;
}

function formatUtcRangeEndLabel(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return ordinalDay(end.getUTCDate());
  }
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
  return sameMonth ? ordinalDay(end.getUTCDate()) : formatUtcMonthDayOrdinal(endIso);
}

function computePriorWeekRange(sourceReferenceInstant: string): { startIso: string; endIso: string } | null {
  const anchor = new Date(sourceReferenceInstant);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const end = new Date(anchor.getTime() - anchor.getUTCDay() * 24 * 60 * 60 * 1000);
  end.setUTCHours(12, 0, 0, 0);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  start.setUTCHours(12, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function computePriorWeekendRange(sourceReferenceInstant: string): { startIso: string; endIso: string } | null {
  const week = computePriorWeekRange(sourceReferenceInstant);
  if (!week) {
    return null;
  }
  const end = new Date(week.endIso);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function formatUtcDayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

export function formatUtcDayLabelMonthFirst(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

export function formatUtcMonthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric"
  });
}

const WEEKDAY_LOOKUP = new Map<string, number>([
  ["sun", 0],
  ["sunday", 0],
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6]
]);

function previousWeekdayIso(occurredAt: string, weekdayToken: string): string | null {
  const targetWeekday = WEEKDAY_LOOKUP.get(weekdayToken.toLowerCase());
  if (targetWeekday === undefined) {
    return null;
  }

  const current = new Date(occurredAt);
  if (Number.isNaN(current.getTime())) {
    return null;
  }

  const currentWeekday = current.getUTCDay();
  let deltaDays = (currentWeekday - targetWeekday + 7) % 7;
  if (deltaDays === 0) {
    deltaDays = 7;
  }

  return new Date(current.getTime() - deltaDays * 24 * 60 * 60 * 1000).toISOString();
}

export function inferRelativeTemporalAnswerLabel(
  content: string,
  occurredAt: string | null | undefined,
  referenceNow?: string | null
): string | null {
  const anchorIso = occurredAt ?? referenceNow ?? null;
  if (!anchorIso) {
    return null;
  }

  const normalized = content.toLowerCase();
  const occurredTime = Date.parse(anchorIso);
  if (!Number.isFinite(occurredTime)) {
    return null;
  }

  const normalizedYearMatch = normalized.match(/\bnormalized year:\s*(\d{4})\b/i);
  if (normalizedYearMatch?.[1]) {
    return normalizedYearMatch[1];
  }

  if (/\byesterday\b/i.test(normalized) || /\blast night\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime - 24 * 60 * 60 * 1000).toISOString());
  }
  if (/\btoday\b/i.test(normalized) || /\btonight\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime).toISOString());
  }
  if (/\blast week\b/i.test(normalized) || /\bweek before\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime - 7 * 24 * 60 * 60 * 1000).toISOString());
  }
  const agoMatch = normalized.match(/\b(\d+)\s+days?\s+ago\b/i);
  if (agoMatch?.[1]) {
    const days = Number.parseInt(agoMatch[1], 10);
    if (Number.isFinite(days) && days > 0) {
      return formatUtcDayLabel(new Date(occurredTime - days * 24 * 60 * 60 * 1000).toISOString());
    }
  }
  const weeksAgoMatch = normalized.match(/\b(\d+|one|two|three|four)\s+weeks?\s+ago\b/i);
  if (weeksAgoMatch?.[1]) {
    const rawWeeks = weeksAgoMatch[1].toLowerCase();
    const weeks =
      rawWeeks === "one"
        ? 1
        : rawWeeks === "two"
          ? 2
          : rawWeeks === "three"
            ? 3
            : rawWeeks === "four"
              ? 4
              : Number.parseInt(rawWeeks, 10);
    if (Number.isFinite(weeks) && weeks > 0) {
      return formatUtcDayLabel(new Date(occurredTime - weeks * 7 * 24 * 60 * 60 * 1000).toISOString());
    }
  }
  if (/\blast year\b/i.test(normalized)) {
    return String(new Date(occurredTime).getUTCFullYear() - 1);
  }
  if (/\ba few days ago\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime - 3 * 24 * 60 * 60 * 1000).toISOString());
  }
  if (/\bthis year\b/i.test(normalized)) {
    return String(new Date(occurredTime).getUTCFullYear());
  }
  if (/\bthis month\b/i.test(normalized)) {
    return formatUtcMonthLabel(new Date(occurredTime).toISOString());
  }
  if (/\blast month\b/i.test(normalized)) {
    const current = new Date(occurredTime);
    return formatUtcMonthLabel(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 15, 12, 0, 0, 0)).toISOString());
  }
  if (/\bnext month\b/i.test(normalized)) {
    const current = new Date(occurredTime);
    return formatUtcMonthLabel(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 15, 12, 0, 0, 0)).toISOString());
  }
  const yearsAgoMatch = normalized.match(/\b(?:around\s+)?(\d+)\s+years?\s+ago\b/i);
  if (yearsAgoMatch?.[1]) {
    const years = Number.parseInt(yearsAgoMatch[1], 10);
    if (Number.isFinite(years) && years > 0) {
      return String(new Date(occurredTime).getUTCFullYear() - years);
    }
  }
  const wordYearsAgoMatch = normalized.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+ago\b/i);
  if (wordYearsAgoMatch?.[1]) {
    const yearsByWord: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10
    };
    const years = yearsByWord[wordYearsAgoMatch[1].toLowerCase()] ?? null;
    if (typeof years === "number") {
      return String(new Date(occurredTime).getUTCFullYear() - years);
    }
  }
  if (/\blast weekend\b/i.test(normalized) || /\b(?:the\s+)?weekend before\b/i.test(normalized)) {
    const resolved = previousWeekdayIso(anchorIso, "sun");
    if (resolved) {
      return formatUtcDayLabel(resolved);
    }
    return formatUtcDayLabel(new Date(occurredTime - 7 * 24 * 60 * 60 * 1000).toISOString());
  }
  const weekdayMatch = normalized.match(/\blast\s+(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  if (weekdayMatch?.[1]) {
    const resolved = previousWeekdayIso(anchorIso, weekdayMatch[1]);
    if (resolved) {
      return formatUtcDayLabel(resolved);
    }
  }
  return null;
}

export function extractRelativeTemporalCue(content: string): string | null {
  const normalized = normalizeWhitespace(content);
  if (!normalized) {
    return null;
  }

  return (
    normalized.match(/\b(?:one|two|three|four|\d+)\s+weekends?\s+before\b/iu)?.[0] ??
    normalized.match(/\b(?:the\s+)?weekend before\b/iu)?.[0] ??
    normalized.match(/\b(?:the\s+)?(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+before\b/iu)?.[0] ??
    normalized.match(/\blast weekend\b/iu)?.[0] ??
    normalized.match(/\b(?:the\s+)?week before\b/iu)?.[0] ??
    normalized.match(/\blast week\b/iu)?.[0] ??
    normalized.match(/\ba few days ago\b/iu)?.[0] ??
    normalized.match(/\bnext month\b/iu)?.[0] ??
    normalized.match(/\blast year\b/iu)?.[0] ??
    normalized.match(/\ba few years ago\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+years?\s+ago\b/iu)?.[0] ??
    normalized.match(/\byesterday\b/iu)?.[0] ??
    normalized.match(/\blast night\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|\d+)\s+weeks?\s+ago\b/iu)?.[0] ??
    normalized.match(/\b(?:one|two|three|four|\d+)\s+days?\s+ago\b/iu)?.[0] ??
    null
  );
}

export function deriveAnchoredRelativeTemporalClaimText(
  relativeCue: string | null,
  explicitLabel: string | null,
  sourceReferenceInstant: string | null | undefined
): string | null {
  if (!relativeCue || !sourceReferenceInstant) {
    return null;
  }

  const anchorLabel = formatUtcDayLabel(sourceReferenceInstant);
  const anchorLabelMonthFirst = formatUtcDayLabelMonthFirst(sourceReferenceInstant);
  const normalizedCue = normalizeWhitespace(relativeCue.toLowerCase());
  if (!normalizedCue) {
    return null;
  }

  if (/\b(?:one|two|three|four|\d+)\s+weekends?\s+before\b/iu.test(normalizedCue)) {
    return `${normalizedCue} ${anchorLabel}`;
  }
  if (normalizedCue === "last weekend" || normalizedCue === "the weekend before" || normalizedCue === "weekend before") {
    const weekendRange = computePriorWeekendRange(sourceReferenceInstant);
    if (weekendRange) {
      return `the weekend of ${formatUtcMonthDayOrdinal(weekendRange.startIso)} to ${formatUtcRangeEndLabel(weekendRange.startIso, weekendRange.endIso)}, ${new Date(weekendRange.endIso).getUTCFullYear()}`;
    }
    return `the weekend before ${anchorLabelMonthFirst}`;
  }
  if (/\b(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+before\b/iu.test(normalizedCue)) {
    return `${normalizedCue} ${anchorLabel}`;
  }
  if (normalizedCue === "last week" || normalizedCue === "the week before" || normalizedCue === "week before") {
    const weekRange = computePriorWeekRange(sourceReferenceInstant);
    if (weekRange) {
      return `the week of ${formatUtcMonthDayOrdinal(weekRange.startIso)} to ${formatUtcRangeEndLabel(weekRange.startIso, weekRange.endIso)}, ${new Date(weekRange.endIso).getUTCFullYear()}`;
    }
    return `the week before ${anchorLabelMonthFirst}`;
  }
  if (normalizedCue === "next month") {
    if (!explicitLabel) {
      return null;
    }
    return `early ${explicitLabel.replace(/^([A-Za-z]+)\s+(\d{4})$/u, "$1, $2")}`;
  }
  if (normalizedCue === "last year") {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (normalizedCue === "a few years ago") {
    return `a few years before ${new Date(sourceReferenceInstant).getUTCFullYear()}`;
  }
  if (/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+years?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? explicitLabel : `${normalizedCue} before ${new Date(sourceReferenceInstant).getUTCFullYear()}`;
  }
  if (normalizedCue === "yesterday" || normalizedCue === "last night") {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (normalizedCue === "a few days ago") {
    return `a few days before ${anchorLabelMonthFirst}`;
  }
  if (/\b(?:one|two|three|four|\d+)\s+weeks?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  if (/\b(?:one|two|three|four|\d+)\s+days?\s+ago\b/iu.test(normalizedCue)) {
    return explicitLabel ? `${normalizedCue}, which from ${anchorLabel} resolves to ${explicitLabel}` : `${normalizedCue} from ${anchorLabel}`;
  }
  return null;
}
