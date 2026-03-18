import type { FragmentRecord, SceneRecord, TimeGranularity } from "../types.js";

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
}

function inferTimeAnchor(text: string, fallbackOccurredAt: string, capturedAt: string): TimeAnchor {
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
        isRelativeTime: false
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
        isRelativeTime: false
      };
    }
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
            isRelativeTime: true
          };
        }
      }

      return {
        occurredAt: fallbackOccurredAt,
        timeExpressionText: expression,
        timeGranularity: "relative_duration",
        timeConfidence: 0.55,
        isRelativeTime: true
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
      isRelativeTime: true
    };
  }

  return {
    occurredAt: fallbackOccurredAt,
    timeGranularity: "unknown",
    timeConfidence: 0.2,
    isRelativeTime: false
  };
}

function isMetadataParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return true;
  }

  if (/^#\s+/u.test(trimmed)) {
    return true;
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

  for (const paragraph of paragraphs) {
    const charStart = normalized.indexOf(paragraph, cursor);
    const safeStart = charStart >= 0 ? charStart : cursor;
    const charEnd = safeStart + paragraph.length;
    const timeAnchor = inferTimeAnchor(paragraph, occurredAt, capturedAt);

    scenes.push({
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
      isRelativeTime: timeAnchor.isRelativeTime
    });

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
