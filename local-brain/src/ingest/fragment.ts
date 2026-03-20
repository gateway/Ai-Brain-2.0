import type { FragmentRecord, SceneRecord, TimeAnchorBasis, TimeGranularity } from "../types.js";

const SENTENCE_SPLIT = /(?<=[.!?])\s+/u;
const MONTH_INDEX = new Map<string, number>([
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clampPositiveInteger(value: string): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.round(numeric);
}

function approximateQuantity(raw: string): number | null {
  const normalized = raw.toLowerCase();
  if (/^\d+$/u.test(normalized)) {
    return clampPositiveInteger(normalized);
  }

  if (normalized === "few" || normalized === "a few") {
    return 3;
  }

  if (normalized === "couple" || normalized === "a couple") {
    return 2;
  }

  if (normalized === "several") {
    return 4;
  }

  return null;
}

function shiftIsoDate(isoString: string, amount: number, unit: "days" | "weeks" | "months" | "years"): string | null {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const shifted = new Date(date);
  if (unit === "days") {
    shifted.setUTCDate(shifted.getUTCDate() - amount);
  } else if (unit === "weeks") {
    shifted.setUTCDate(shifted.getUTCDate() - amount * 7);
  } else if (unit === "months") {
    shifted.setUTCMonth(shifted.getUTCMonth() - amount);
  } else {
    shifted.setUTCFullYear(shifted.getUTCFullYear() - amount);
  }

  return shifted.toISOString();
}

interface TimeAnchor {
  readonly occurredAt: string;
  readonly timeExpressionText?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly timeGranularity: TimeGranularity;
  readonly timeConfidence: number;
  readonly isRelativeTime: boolean;
  readonly anchorBasis: TimeAnchorBasis;
  readonly anchorSceneIndex?: number;
  readonly anchorConfidence: number;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + diff);
  return startOfUtcDay(shifted);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function addUtcDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function addUtcMonths(date: Date, months: number): Date {
  const shifted = new Date(date);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted;
}

function addUtcYears(date: Date, years: number): Date {
  const shifted = new Date(date);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted;
}

function anchorDateFromIso(isoString: string): Date | null {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? null : date;
}

function periodBoundsFromShift(anchor: Date, amount: number, unit: "days" | "weeks" | "months" | "years", direction: -1 | 1): {
  readonly occurredAt: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly timeGranularity: TimeGranularity;
} | null {
  if (unit === "days") {
    const targetStart = startOfUtcDay(addUtcDays(anchor, direction * amount));
    const targetEnd = addUtcDays(targetStart, 1);
    return {
      occurredAt: targetStart.toISOString(),
      timeStart: targetStart.toISOString(),
      timeEnd: targetEnd.toISOString(),
      timeGranularity: "day"
    };
  }

  if (unit === "weeks") {
    const targetStart = startOfUtcWeek(addUtcDays(anchor, direction * amount * 7));
    const targetEnd = addUtcDays(targetStart, 7);
    return {
      occurredAt: targetStart.toISOString(),
      timeStart: targetStart.toISOString(),
      timeEnd: targetEnd.toISOString(),
      timeGranularity: "week"
    };
  }

  if (unit === "months") {
    const targetStart = startOfUtcMonth(addUtcMonths(anchor, direction * amount));
    const targetEnd = startOfUtcMonth(addUtcMonths(targetStart, 1));
    return {
      occurredAt: targetStart.toISOString(),
      timeStart: targetStart.toISOString(),
      timeEnd: targetEnd.toISOString(),
      timeGranularity: "month"
    };
  }

  const targetStart = startOfUtcYear(addUtcYears(anchor, direction * amount));
  const targetEnd = startOfUtcYear(addUtcYears(targetStart, 1));
  return {
    occurredAt: targetStart.toISOString(),
    timeStart: targetStart.toISOString(),
    timeEnd: targetEnd.toISOString(),
    timeGranularity: "year"
  };
}

function weekdayBoundsFromAnchor(anchor: Date, weekdayIndex: number, modifier: "last" | "next" | "this"): {
  readonly occurredAt: string;
  readonly timeStart: string;
  readonly timeEnd: string;
} {
  const base = startOfUtcDay(anchor);
  const currentWeekday = base.getUTCDay();
  const normalizedCurrent = currentWeekday === 0 ? 7 : currentWeekday;
  const normalizedTarget = weekdayIndex === 0 ? 7 : weekdayIndex;
  let diff = normalizedTarget - normalizedCurrent;

  if (modifier === "last") {
    diff = diff >= 0 ? diff - 7 : diff;
  } else if (modifier === "next") {
    diff = diff <= 0 ? diff + 7 : diff;
  }

  const targetStart = addUtcDays(base, diff);
  const targetEnd = addUtcDays(targetStart, 1);
  return {
    occurredAt: targetStart.toISOString(),
    timeStart: targetStart.toISOString(),
    timeEnd: targetEnd.toISOString()
  };
}

function inferTimeAnchor(
  text: string,
  fallbackOccurredAt: string,
  capturedAt: string,
  priorScene?: SceneRecord
): TimeAnchor {
  const priorAnchorIso = priorScene?.timeStart ?? priorScene?.occurredAt ?? null;
  const priorAnchorDate = priorAnchorIso ? anchorDateFromIso(priorAnchorIso) : null;
  const capturedAnchorDate = anchorDateFromIso(capturedAt);
  const monthDayYearMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i
  );

  if (monthDayYearMatch) {
    const month = MONTH_INDEX.get(monthDayYearMatch[1].toLowerCase());
    const day = Number(monthDayYearMatch[2]);
    const year = Number(monthDayYearMatch[3]);

    if (month !== undefined && Number.isFinite(day) && day >= 1 && day <= 31 && Number.isFinite(year)) {
      const timeStart = new Date(Date.UTC(year, month, day)).toISOString();
      const timeEnd = new Date(Date.UTC(year, month, day + 1)).toISOString();
      return {
        occurredAt: timeStart,
        timeExpressionText: monthDayYearMatch[0],
        timeStart,
        timeEnd,
        timeGranularity: "day",
        timeConfidence: 0.98,
        isRelativeTime: false,
        anchorBasis: "explicit",
        anchorConfidence: 0.98
      };
    }
  }

  const monthYearMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );

  if (monthYearMatch) {
    const month = MONTH_INDEX.get(monthYearMatch[1].toLowerCase());
    const year = Number(monthYearMatch[2]);

    if (month !== undefined && Number.isFinite(year)) {
      const timeStart = new Date(Date.UTC(year, month, 1)).toISOString();
      const timeEnd = new Date(Date.UTC(year, month + 1, 1)).toISOString();
      return {
        occurredAt: timeStart,
        timeExpressionText: monthYearMatch[0],
        timeStart,
        timeEnd,
        timeGranularity: "month",
        timeConfidence: 0.96,
        isRelativeTime: false,
        anchorBasis: "explicit",
        anchorConfidence: 0.96
      };
    }
  }

  const yearMatch = text.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/u);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (Number.isFinite(year)) {
      const timeStart = new Date(Date.UTC(year, 0, 1)).toISOString();
      const timeEnd = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
      return {
        occurredAt: timeStart,
        timeExpressionText: yearMatch[1],
        timeStart,
        timeEnd,
        timeGranularity: "year",
        timeConfidence: 0.92,
        isRelativeTime: false,
        anchorBasis: "explicit",
        anchorConfidence: 0.92
      };
    }
  }

  const weekdayMatch = text.match(/\b(last|next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu);
  if (weekdayMatch && capturedAnchorDate) {
    const weekdayOrder = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekdayIndex = weekdayOrder.indexOf((weekdayMatch[2] ?? "").toLowerCase());
    if (weekdayIndex >= 0) {
      const bounds = weekdayBoundsFromAnchor(capturedAnchorDate, weekdayIndex, weekdayMatch[1].toLowerCase() as "last" | "next" | "this");
      return {
        occurredAt: bounds.occurredAt,
        timeExpressionText: weekdayMatch[0],
        timeStart: bounds.timeStart,
        timeEnd: bounds.timeEnd,
        timeGranularity: "day",
        timeConfidence: 0.88,
        isRelativeTime: true,
        anchorBasis: "captured_at",
        anchorConfidence: 0.88
      };
    }
  }

  const relativeShiftMatch = text.match(
    /\b(?:(\d+|few|a few|couple|a couple|several)\s+(day|days|week|weeks|month|months|year|years)\s+(ago|later|after|before))\b/iu
  );
  if (relativeShiftMatch) {
    const quantity = approximateQuantity(relativeShiftMatch[1] ?? "");
    const unit = (relativeShiftMatch[2] ?? "").toLowerCase();
    const directionToken = (relativeShiftMatch[3] ?? "").toLowerCase();
    const normalizedUnit = unit.startsWith("day")
      ? "days"
      : unit.startsWith("week")
        ? "weeks"
        : unit.startsWith("month")
          ? "months"
          : "years";
    const anchorBasis: TimeAnchorBasis = priorAnchorDate ? "prior_scene" : "captured_at";
    const anchorDate = priorAnchorDate ?? capturedAnchorDate;
    const direction: -1 | 1 = directionToken === "ago" || directionToken === "before" ? -1 : 1;

    if (quantity && anchorDate) {
      const period = periodBoundsFromShift(anchorDate, quantity, normalizedUnit, direction);
      if (period) {
        return {
          ...period,
          timeExpressionText: relativeShiftMatch[0],
          timeConfidence: priorAnchorDate ? 0.84 : 0.74,
          isRelativeTime: true,
          anchorBasis,
          anchorSceneIndex: priorScene?.sceneIndex,
          anchorConfidence: priorAnchorDate ? 0.86 : 0.74
        };
      }
    }
  }

  const relativeThisYearMatch = text.match(/\b(earlier|later)\s+that\s+year\b/iu);
  if (relativeThisYearMatch && priorAnchorDate) {
    const anchorYearStart = startOfUtcYear(priorAnchorDate);
    const targetStart =
      relativeThisYearMatch[1].toLowerCase() === "earlier"
        ? anchorYearStart
        : startOfUtcMonth(addUtcMonths(priorAnchorDate, 6));
    const targetEnd =
      relativeThisYearMatch[1].toLowerCase() === "earlier"
        ? startOfUtcMonth(addUtcMonths(anchorYearStart, 6))
        : startOfUtcYear(addUtcYears(anchorYearStart, 1));

    return {
      occurredAt: targetStart.toISOString(),
      timeExpressionText: relativeThisYearMatch[0],
      timeStart: targetStart.toISOString(),
      timeEnd: targetEnd.toISOString(),
      timeGranularity: "year",
      timeConfidence: 0.62,
      isRelativeTime: true,
      anchorBasis: "prior_scene",
      anchorSceneIndex: priorScene?.sceneIndex,
      anchorConfidence: 0.72
    };
  }

  const durationMatch = text.match(
    /\b(?:for|about|for about|for around|been here for|been doing that for|working for)\s+(?:(about|around)\s+)?(\d+|few|a few|couple|a couple|several)\s+(day|days|week|weeks|month|months|year|years)\b/iu
  );
  if (durationMatch) {
    const quantity = approximateQuantity(durationMatch[2] ?? "");
    const unit = (durationMatch[3] ?? "").toLowerCase();
    const expression = durationMatch[0];
    const isPresentAnchored = /\b(?:been here|been doing that|for .* now|just recently|recently)\b/iu.test(text);

    if (quantity) {
      const normalizedUnit = unit.startsWith("day")
        ? "days"
        : unit.startsWith("week")
          ? "weeks"
          : unit.startsWith("month")
            ? "months"
            : "years";

      if (isPresentAnchored) {
        const timeStart = shiftIsoDate(capturedAt, quantity, normalizedUnit);
        if (timeStart) {
          return {
            occurredAt: timeStart,
            timeExpressionText: expression,
            timeStart,
            timeEnd: capturedAt,
            timeGranularity: "relative_duration",
            timeConfidence: 0.7,
            isRelativeTime: true,
            anchorBasis: "captured_at",
            anchorConfidence: 0.7
          };
        }
      }

      return {
        occurredAt: fallbackOccurredAt,
        timeExpressionText: expression,
        timeGranularity: "relative_duration",
        timeConfidence: 0.55,
        isRelativeTime: true,
        anchorBasis: "fallback",
        anchorConfidence: 0.4
      };
    }
  }

  const recentMatch = text.match(/\b(just recently|recently)\b/iu);
  if (recentMatch) {
    const timeStart = shiftIsoDate(capturedAt, 30, "days");
    return {
      occurredAt: timeStart ?? fallbackOccurredAt,
      timeExpressionText: recentMatch[1],
      timeStart: timeStart ?? undefined,
      timeEnd: capturedAt,
      timeGranularity: "relative_recent",
      timeConfidence: 0.4,
      isRelativeTime: true,
      anchorBasis: "captured_at",
      anchorConfidence: 0.4
    };
  }

  return {
    occurredAt: fallbackOccurredAt,
    timeGranularity: "unknown",
    timeConfidence: 0.2,
    isRelativeTime: false,
    anchorBasis: "fallback",
    anchorConfidence: 0.2
  };
}

function isMetadataParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return true;
  }

  if (/^#\s+/u.test(trimmed)) {
    return !/^#\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+[—-]\s+/u.test(trimmed);
  }

  const lines = trimmed
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return true;
  }

  return lines.every((line) => /^(Captured|Namespace intent|Source channel)\s*:/iu.test(line));
}

export function splitIntoFragments(text: string, occurredAt: string, capturedAt = occurredAt): FragmentRecord[] {
  const scenes = splitIntoScenes(text, occurredAt, capturedAt);
  const fragments: FragmentRecord[] = [];
  let fragmentIndex = 0;

  for (const scene of scenes) {
    const sentences = scene.text
      .split(SENTENCE_SPLIT)
      .map((sentence) => normalizeWhitespace(sentence))
      .filter(Boolean);

    if (sentences.length === 0) {
      continue;
    }

    let cursor = scene.charStart ?? 0;
    for (let i = 0; i < sentences.length; i += 3) {
      const fragmentText = sentences.slice(i, i + 3).join(" ").trim();
      if (!fragmentText) {
        continue;
      }

      const charStart = text.indexOf(fragmentText, cursor);
      const safeStart = charStart >= 0 ? charStart : cursor;
      const charEnd = safeStart + fragmentText.length;

      fragments.push({
        fragmentIndex,
        sceneIndex: scene.sceneIndex,
        text: fragmentText,
        charStart: safeStart,
        charEnd,
        occurredAt: inferTimeAnchor(fragmentText, scene.occurredAt, capturedAt).occurredAt,
        importanceScore: inferImportance(fragmentText),
        tags: inferTags(fragmentText)
      });

      fragmentIndex += 1;
      cursor = charEnd;
    }
  }

  return fragments;
}

export function splitIntoScenes(text: string, occurredAt: string, capturedAt = occurredAt): SceneRecord[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter((paragraph) => !isMetadataParagraph(paragraph))
    .filter(Boolean);

  const scenes: SceneRecord[] = [];
  let cursor = 0;
  let sceneIndex = 0;
  let lastAnchoredScene: SceneRecord | undefined;

  for (const paragraph of paragraphs) {
    const charStart = normalized.indexOf(paragraph, cursor);
    const safeStart = charStart >= 0 ? charStart : cursor;
    const charEnd = safeStart + paragraph.length;
    const timeAnchor = inferTimeAnchor(paragraph, occurredAt, capturedAt, lastAnchoredScene);

    const scene: SceneRecord = {
      sceneIndex,
      text: paragraph,
      charStart: safeStart,
      charEnd,
      occurredAt: timeAnchor.occurredAt,
      sceneKind: "paragraph",
      timeExpressionText: timeAnchor.timeExpressionText,
      timeStart: timeAnchor.timeStart,
      timeEnd: timeAnchor.timeEnd,
      timeGranularity: timeAnchor.timeGranularity,
      timeConfidence: timeAnchor.timeConfidence,
      isRelativeTime: timeAnchor.isRelativeTime,
      anchorBasis: timeAnchor.anchorBasis,
      anchorSceneIndex: timeAnchor.anchorSceneIndex,
      anchorConfidence: timeAnchor.anchorConfidence
    };

    scenes.push(scene);

    if ((scene.timeGranularity && scene.timeGranularity !== "unknown") || scene.anchorBasis === "prior_scene") {
      lastAnchoredScene = scene;
    }

    sceneIndex += 1;
    cursor = charEnd;
  }

  return scenes;
}

function inferImportance(text: string): number {
  let score = 0.35;

  if (/\b(?:japan|tokyo|kyoto|june|2025|project|error|bug|deadline)\b/i.test(text)) {
    score += 0.2;
  }

  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/u.test(text)) {
    score += 0.15;
  }

  if (/\b(?:prefer|like|hate|always|never)\b/i.test(text)) {
    score += 0.15;
  }

  return Math.min(score, 1);
}

function inferTags(text: string): string[] {
  const tags = new Set<string>();

  if (/\b(?:prefer|like|hate)\b/i.test(text)) {
    tags.add("preference");
  }

  if (/\b(?:project|repo|spec|workflow)\b/i.test(text)) {
    tags.add("project");
  }

  if (/\b(?:japan|tokyo|kyoto|travel|trip)\b/i.test(text)) {
    tags.add("travel");
  }

  return [...tags];
}
