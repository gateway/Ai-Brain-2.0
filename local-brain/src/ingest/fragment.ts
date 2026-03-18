import type { FragmentRecord } from "../types.js";

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

function inferOccurredAt(text: string, fallbackOccurredAt: string): string {
  const monthYearMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );

  if (monthYearMatch) {
    const month = MONTH_INDEX.get(monthYearMatch[1].toLowerCase());
    const year = Number(monthYearMatch[2]);

    if (month !== undefined && Number.isFinite(year)) {
      return new Date(Date.UTC(year, month, 1)).toISOString();
    }
  }

  const yearMatch = text.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/u);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (Number.isFinite(year)) {
      return new Date(Date.UTC(year, 0, 1)).toISOString();
    }
  }

  return fallbackOccurredAt;
}

export function splitIntoFragments(text: string, occurredAt: string): FragmentRecord[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);

  const fragments: FragmentRecord[] = [];
  let cursor = 0;
  let fragmentIndex = 0;

  for (const paragraph of paragraphs) {
    const sentences = paragraph
      .split(SENTENCE_SPLIT)
      .map((sentence) => normalizeWhitespace(sentence))
      .filter(Boolean);

    if (sentences.length === 0) {
      continue;
    }

    for (let i = 0; i < sentences.length; i += 3) {
      const fragmentText = sentences.slice(i, i + 3).join(" ").trim();
      if (!fragmentText) {
        continue;
      }

      const charStart = normalized.indexOf(fragmentText, cursor);
      const safeStart = charStart >= 0 ? charStart : cursor;
      const charEnd = safeStart + fragmentText.length;

      fragments.push({
        fragmentIndex,
        text: fragmentText,
        charStart: safeStart,
        charEnd,
        occurredAt: inferOccurredAt(fragmentText, occurredAt),
        importanceScore: inferImportance(fragmentText),
        tags: inferTags(fragmentText)
      });

      fragmentIndex += 1;
      cursor = charEnd;
    }
  }

  return fragments;
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
