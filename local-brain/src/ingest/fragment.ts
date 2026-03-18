import type { FragmentRecord, SceneRecord } from "../types.js";

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
  const scenes = splitIntoScenes(text, occurredAt);
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
        occurredAt: inferOccurredAt(fragmentText, scene.occurredAt),
        importanceScore: inferImportance(fragmentText),
        tags: inferTags(fragmentText)
      });

      fragmentIndex += 1;
      cursor = charEnd;
    }
  }

  return fragments;
}

export function splitIntoScenes(text: string, occurredAt: string): SceneRecord[] {
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

    scenes.push({
      sceneIndex,
      text: paragraph,
      charStart: safeStart,
      charEnd,
      occurredAt: inferOccurredAt(paragraph, occurredAt),
      sceneKind: "paragraph"
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
