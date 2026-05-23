import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import type { ExactDetailClaimCandidate } from "./types.js";

const EXACT_DETAIL_COLOR_PATTERN =
  /\b(black|white|blue|red|green|yellow|orange|purple|pink|brown|gray|grey|gold|silver|blonde|blond|auburn)\b/giu;

const EXACT_DETAIL_QUERY_FIT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from", "had", "has", "have",
  "he", "her", "his", "how", "i", "if", "in", "into", "is", "it", "its", "me", "month", "my", "of", "on",
  "or", "our", "she", "that", "the", "their", "them", "they", "this", "to", "was", "were", "what", "when",
  "where", "which", "who", "why", "with", "would", "year", "years"
]);

function normalizeWhitespace(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeCountryAnswer(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }
  if (/^(?:us|u\.s\.?|usa|united states(?: of america)?)$/iu.test(normalized)) {
    return "United States";
  }
  return normalized;
}

function normalizeExactDetailValueForQuery(_queryText: string, rawValue: string): string {
  return normalizeWhitespace(rawValue)
    .replace(/^[\s:;,.!?'"“”‘’]+|[\s:;,.!?'"“”‘’]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function containsInterrogativePromptCue(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  if (/\?\s*$/u.test(normalized)) {
    return true;
  }
  return /\b(?:what|why|how|who|when|where)\b[^.!?\n]{0,80}\?/iu.test(normalized);
}

function exactDetailColorQueryRequiresHairContext(queryText: string): boolean {
  return /\bhair\b|\bdy(?:e|ed|ing)\b/iu.test(queryText);
}

function exactDetailTextHasHairColorContext(text: string): boolean {
  return (
    /\bhair\b/iu.test(text) &&
    /\b(?:color|colour|dy(?:e|ed|ing)|chose|choose|chosen|picked|went with|decided on)\b/iu.test(text)
  );
}

export function extractExactDetailColorValues(text: string, queryText: string): readonly string[] {
  const requiresHairContext = exactDetailColorQueryRequiresHairContext(queryText);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length > 0);
  const values = new Set<string>();
  for (const sentence of sentences.length > 0 ? sentences : [normalizeWhitespace(text)]) {
    if (requiresHairContext && !exactDetailTextHasHairColorContext(sentence)) {
      continue;
    }
    for (const match of sentence.matchAll(EXACT_DETAIL_COLOR_PATTERN)) {
      const value = normalizeExactDetailValueForQuery(queryText, match[1] ?? "");
      if (value) {
        values.add(value);
      }
    }
  }
  return [...values];
}

function exactDetailQueryCueTerms(queryText: string): readonly string[] {
  return [...new Set(
    (queryText.match(/[A-Za-z][A-Za-z'’.-]{2,}/gu) ?? [])
      .map((term) => normalizeWhitespace(term).toLowerCase())
      .filter((term) => !EXACT_DETAIL_QUERY_FIT_STOP_WORDS.has(term))
  )];
}

function isSuspiciousExactDetailFragment(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return true;
  }
  if (containsInterrogativePromptCue(normalized)) {
    return true;
  }
  if (/^(?:for|to|with|about|because|since|after|before|during|into|onto)\b/iu.test(normalized)) {
    return true;
  }
  if (
    /\b(?:this|that|these|those)\b/iu.test(normalized) &&
    !/\b(?:month|year|week|team|country|project|book|painting|field|degree|agency|style)\b/iu.test(normalized)
  ) {
    return true;
  }
  if (/^(?:home|place|thing|stuff)\b/iu.test(normalized) && normalized.split(/\s+/u).length <= 6) {
    return true;
  }
  if (
    /^[a-z]/u.test(normalized) &&
    normalized.split(/\s+/u).length >= 4 &&
    !/\d/.test(normalized) &&
    !/\b[A-Z][A-Za-z0-9'’&.-]{2,}\b/u.test(normalized)
  ) {
    return true;
  }
  return false;
}

export function exactDetailCandidateFitsPredicate(params: {
  readonly queryText: string;
  readonly candidate: ExactDetailClaimCandidate | null | undefined;
  readonly extractedValueCount?: number;
}): boolean {
  const { queryText, candidate, extractedValueCount = 0 } = params;
  if (!candidate?.text) {
    return false;
  }
  const normalized = normalizeWhitespace(candidate.text);
  if (!normalized || containsInterrogativePromptCue(normalized)) {
    return false;
  }
  if (/^(?:none|unknown)\.?$/iu.test(normalized)) {
    return true;
  }

  const family = inferExactDetailQuestionFamily(queryText);
  if (family !== "generic") {
    if (extractedValueCount > 0) {
      return true;
    }
    if (isSuspiciousExactDetailFragment(normalized)) {
      return false;
    }
    if (
      family === "favorite_movie" ||
      family === "pastry_items" ||
      family === "underlying_condition" ||
      family === "endorsement_company" ||
      family === "preseason_challenge" ||
      family === "flower_type" ||
      family === "state" ||
      family === "inspiration_source"
    ) {
      return false;
    }
    if (family === "favorite_memory") {
      return /\b(?:favorite|best)\b[^.!?\n]{0,40}\bmemory\b|\b(?:favorite|best)\s+moment\b|\b(?:when|during)\b/u.test(normalized);
    }
    if (family === "team") {
      return (
        /\b[A-Z][A-Za-z0-9'’&.-]+(?:\s+[A-Z][A-Za-z0-9'’&.-]+){0,4}\b/u.test(normalized) ||
        /\b(?:team|club|company|employer|brand|sponsor|endorsement)\b/iu.test(normalized)
      );
    }
    if (family === "role") {
      return /\b(?:analyst|manager|director|engineer|counselor|teacher|chef|nurse|writer|coach|developer|owner|founder|assistant|administrator|professor|student|designer|strategist|consultant|architect|accountant|artist|photographer|barista|cashier|salesperson)\b/iu.test(
        normalized
      );
    }
    if (family === "shop") {
      return (
        /\b[A-Z][A-Za-z0-9'’&.-]+(?:\s+[A-Z][A-Za-z0-9'’&.-]+){0,4}\b/u.test(normalized) ||
        /\b(?:shop|store|market|boutique|cafe|coffee|bakery|mall|outlet)\b/iu.test(normalized)
      );
    }
    if (family === "country") {
      return Boolean(normalizeCountryAnswer(normalized));
    }
    if (family === "habit_start_activity") {
      return normalized.split(/\s+/u).length <= 5;
    }
    if (family === "advice") {
      return /\b(?:advice|told|advised|suggested|recommended)\b/iu.test(normalized);
    }
    if (family === "pet_name") {
      return /^[A-Z][A-Za-z0-9'’&.-]{1,40}$/u.test(candidate.text.trim());
    }
    if (family === "breed") {
      return /^[A-Za-z][A-Za-z0-9'’&/-]*(?:\s+[A-Za-z][A-Za-z0-9'’&/-]*){0,3}$/u.test(candidate.text.trim());
    }
    if (family === "brand" || family === "service_name") {
      return /^[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,3}$/u.test(candidate.text.trim());
    }
    if (family === "count") {
      return /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu.test(normalized);
    }
    if (family === "venue") {
      return (
        /\b(?:University|Ballroom|Yoga|IKEA|School|Hall|Center|Centre|Cafe|Caf[eé]|Institute)\b/u.test(candidate.text) ||
        /^[A-Z][A-Za-z0-9'’&(),.-]*(?:\s+[A-Z][A-Za-z0-9'’&(),.-]*){0,6}$/u.test(candidate.text.trim())
      );
    }
    if (family === "certification") {
      return /\bcertification\b/iu.test(normalized) || /^[A-Z][A-Za-z0-9'’& -]{2,80}$/u.test(candidate.text.trim());
    }
    if (family === "capacity") {
      return /\b\d+\s*(?:gb|tb)\b/iu.test(normalized);
    }
    if (family === "speed") {
      return /\b\d+\s*(?:mbps|gbps)\b/iu.test(normalized);
    }
    if (family === "time_of_day") {
      return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/iu.test(normalized);
    }
    if (family === "color") {
      return /^(?:black|white|blue|red|green|yellow|orange|purple|pink|brown|gray|grey|gold|silver|blonde|blond|auburn)$/iu.test(candidate.text.trim());
    }
    if (
      [
        "research_topic",
        "summer_adoption_plan",
        "temporary_job",
        "favorite_painting_style",
        "main_focus",
        "plural_names",
        "bands",
        "team",
        "role",
        "shop",
        "country",
        "symbolic_gifts",
        "favorite_band",
        "favorite_dj",
        "bird_type",
        "meat_preference",
        "project_type"
      ].includes(family)
    ) {
      return normalized.split(/\s+/u).length <= 8;
    }
    return false;
  }
  if (extractedValueCount > 0) {
    return true;
  }
  if (isSuspiciousExactDetailFragment(normalized)) {
    return false;
  }

  const lowered = normalized.toLowerCase();
  const cueHits = exactDetailQueryCueTerms(queryText).filter((term) => lowered.includes(term)).length;
  if (cueHits > 0) {
    return true;
  }
  if (
    /\b\d{1,4}\b/.test(normalized) ||
    /\b[A-Z][A-Za-z0-9'’&.-]{2,}(?:\s+[A-Z][A-Za-z0-9'’&.-]{2,}){0,4}\b/u.test(normalized)
  ) {
    return true;
  }
  return candidate.source === "episodic_leaf" && normalized.split(/\s+/u).length <= 3;
}

export function exactDetailCandidateFitsPredicateForTest(
  queryText: string,
  candidate: ExactDetailClaimCandidate | null | undefined
): boolean {
  return exactDetailCandidateFitsPredicate({ queryText, candidate });
}
