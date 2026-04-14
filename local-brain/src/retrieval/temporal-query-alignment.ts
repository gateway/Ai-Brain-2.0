import {
  extractAnchoredQuerySurfaceNames
} from "./query-subjects.js";

const TEMPORAL_QUERY_ALIGNMENT_STOPWORDS = new Set([
  "what",
  "when",
  "which",
  "year",
  "month",
  "date",
  "day",
  "time",
  "did",
  "does",
  "do",
  "was",
  "were",
  "is",
  "are",
  "in",
  "on",
  "at",
  "for",
  "to",
  "of",
  "the",
  "a",
  "an",
  "his",
  "her",
  "their",
  "there",
  "with",
  "from",
  "next",
  "last",
  "this",
  "that",
  "during",
  "around",
  "about",
  "before",
  "after",
  "into",
  "over",
  "under",
  "early",
  "late",
  "recently"
]);

const TEMPORAL_OBJECT_ALIGNMENT_STOPWORDS = new Set([
  ...TEMPORAL_QUERY_ALIGNMENT_STOPWORDS,
  "job",
  "game",
  "points",
  "score",
  "store",
  "festival",
  "group",
  "doctor",
  "appointment",
  "trip",
  "meeting",
  "conference",
  "workshop"
]);

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeLower(value)).filter(Boolean))];
}

function subjectIgnoreTerms(queryText: string): Set<string> {
  const names = extractAnchoredQuerySurfaceNames(queryText);
  const ignored = new Set<string>();
  for (const name of names) {
    for (const token of normalizeLower(name).split(/[^a-z0-9+]+/u).filter(Boolean)) {
      ignored.add(token);
    }
  }
  return ignored;
}

export function extractTemporalQueryAlignmentTokens(queryText: string): readonly string[] {
  const ignored = subjectIgnoreTerms(queryText);
  return uniqueNormalized(
    queryText
      .replace(/[^\p{L}\p{N}\s+]/gu, " ")
      .split(/\s+/u)
      .map((token) => normalizeLower(token).replace(/[^a-z0-9+]/gu, ""))
      .filter(
        (token) =>
          token.length >= 3 &&
          !TEMPORAL_QUERY_ALIGNMENT_STOPWORDS.has(token) &&
          !ignored.has(token)
      )
  );
}

export function temporalQueryAlignmentCount(queryText: string, text: string): number {
  const normalizedText = normalizeLower(text);
  if (!normalizedText) {
    return 0;
  }
  const tokens = extractTemporalQueryAlignmentTokens(queryText);
  if (tokens.length === 0) {
    return 0;
  }
  return tokens.filter((token) => normalizedText.includes(token)).length;
}

export function isTemporalQueryTextAligned(queryText: string, text: string): boolean {
  const tokens = extractTemporalQueryAlignmentTokens(queryText);
  if (tokens.length === 0) {
    return false;
  }
  const matchCount = temporalQueryAlignmentCount(queryText, text);
  return tokens.length === 1 ? matchCount >= 1 : matchCount >= Math.min(2, tokens.length);
}

export function extractTemporalQueryObjectTokens(queryText: string): readonly string[] {
  const ignored = subjectIgnoreTerms(queryText);
  const candidates: string[] = [];
  for (const pattern of [
    /\b(?:at|in|from)\s+([^?.,!;]+)/giu,
    /\bas\s+(?:a|an)\s+([^?.,!;]+)/giu
  ]) {
    for (const match of queryText.matchAll(pattern)) {
      const phrase = normalizeLower(match[1]);
      if (!phrase) {
        continue;
      }
      for (const token of phrase.split(/[^a-z0-9+]+/u).filter(Boolean)) {
        if (
          token.length >= 3 &&
          !ignored.has(token) &&
          !TEMPORAL_OBJECT_ALIGNMENT_STOPWORDS.has(token)
        ) {
          candidates.push(token);
        }
      }
    }
  }
  return uniqueNormalized(candidates);
}

export function temporalQueryObjectAlignmentCount(queryText: string, text: string): number {
  const normalizedText = normalizeLower(text);
  if (!normalizedText) {
    return 0;
  }
  const tokens = extractTemporalQueryObjectTokens(queryText);
  if (tokens.length === 0) {
    return 0;
  }
  return tokens.filter((token) => normalizedText.includes(token)).length;
}
