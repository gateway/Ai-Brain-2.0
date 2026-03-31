export type QueryEntityFocusMode =
  | "none"
  | "single_subject"
  | "primary_with_companion"
  | "shared_group"
  | "multi_subject";

export interface QueryEntityFocus {
  readonly mode: QueryEntityFocusMode;
  readonly allHints: readonly string[];
  readonly primaryHints: readonly string[];
  readonly companionHints: readonly string[];
}

const STOP_TERMS = new Set([
  "what",
  "where",
  "who",
  "when",
  "why",
  "which",
  "how",
  "is",
  "are",
  "was",
  "were",
  "did",
  "does",
  "do",
  "can",
  "could",
  "would",
  "should",
  "will",
  "tell",
  "me",
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "that",
  "this",
  "it",
  "likely",
  "besides",
  "both",
  "with",
  "without",
  "than",
  "versus",
  "vs",
  "compared",
  "compare",
  "from",
  "by",
  "at",
  "my",
  "your",
  "his",
  "her",
  "their",
  "our"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeEntity(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export function extractEntityNameHints(queryText: string): readonly string[] {
  const stopTerms = new Set([
    "what",
    "where",
    "who",
    "when",
    "why",
    "which",
    "how",
    "is",
    "are",
    "was",
    "were",
    "did",
    "does",
    "do",
    "can",
    "could",
    "would",
    "should",
    "will",
    "tell",
    "me",
    "ai",
    "brain",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday"
  ]);
  const matches = queryText.match(/\b[A-Z][a-z]+\b/gu) ?? [];
  return [...new Set(matches.map((value) => normalizeEntity(value)))].filter((value) => !stopTerms.has(value));
}

function extractNamedCapture(match: RegExpMatchArray, index: number): string | null {
  const value = match[index];
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeEntity(value);
  return normalized || null;
}

export function parseQueryEntityFocus(queryText: string): QueryEntityFocus {
  const allHints = extractEntityNameHints(queryText);
  if (allHints.length === 0) {
    return { mode: "none", allHints: [], primaryHints: [], companionHints: [] };
  }
  if (allHints.length === 1) {
    return { mode: "single_subject", allHints, primaryHints: allHints, companionHints: [] };
  }

  const bothMatch = queryText.match(/\bboth\s+([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)\b/u);
  if (bothMatch) {
    return {
      mode: "shared_group",
      allHints,
      primaryHints: [extractNamedCapture(bothMatch, 1), extractNamedCapture(bothMatch, 2)].filter(
        (value): value is string => typeof value === "string"
      ),
      companionHints: []
    };
  }

  const betweenMatch = queryText.match(/\bbetween\s+([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)\b/u);
  if (betweenMatch) {
    return {
      mode: "shared_group",
      allHints,
      primaryHints: [extractNamedCapture(betweenMatch, 1), extractNamedCapture(betweenMatch, 2)].filter(
        (value): value is string => typeof value === "string"
      ),
      companionHints: []
    };
  }

  const besidesMatch = queryText.match(/\bbesides\s+([A-Z][a-z]+)\b/u);
  if (besidesMatch) {
    const companion = extractNamedCapture(besidesMatch, 1);
    const primary = allHints.find((value) => value !== companion) ?? allHints[0]!;
    return {
      mode: "primary_with_companion",
      allHints,
      primaryHints: [primary],
      companionHints: companion ? [companion] : []
    };
  }

  if (allHints.length === 2 && /\b(?:with|without|than|versus|vs\.?|compared to)\b/iu.test(queryText)) {
    return {
      mode: "primary_with_companion",
      allHints,
      primaryHints: [allHints[0]!],
      companionHints: [allHints[1]!]
    };
  }

  return { mode: "multi_subject", allHints, primaryHints: [], companionHints: [] };
}

export function buildFocusedEntityQuery(queryText: string): string {
  const focus = parseQueryEntityFocus(queryText);
  const tokens = queryText.match(/[A-Za-z0-9']+/gu) ?? [];
  const entityTerms = new Set(focus.companionHints);
  for (const hint of focus.primaryHints) {
    entityTerms.add(hint);
  }
  const filteredTokens = tokens
    .map((token) => normalizeWhitespace(token).toLowerCase())
    .filter((token) => token.length > 0)
    .filter((token) => !STOP_TERMS.has(token))
    .filter((token) => !entityTerms.has(token));
  const combined = [...focus.primaryHints, ...filteredTokens];
  return [...new Set(combined)].join(" ").trim() || queryText;
}
