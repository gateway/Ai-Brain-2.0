export function isRelationshipStyleExactQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const relationshipCue =
    /\b(with|together|shared|met|joined|visited|travel(?:ed|led)?|trip|dinner(?:s)?|lunch|breakfast|stayed|spent)\b/i.test(lower) ||
    /\bwho was i with\b/i.test(lower) ||
    /\bwhere was i with\b/i.test(lower);

  if (!relationshipCue) {
    return false;
  }

  const properNouns = normalized.match(/\b[A-Z][a-z]+\b/g) ?? [];
  const yearHints = normalized.match(/\b(19\d{2}|20\d{2})\b/g) ?? [];

  return properNouns.length >= 2 || yearHints.length > 0 || /\bwho was i with\b/i.test(lower);
}

export function isPrecisionLexicalQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const tokens = normalized.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [];
  if (tokens.length === 0) {
    return false;
  }

  if (
    /\bCVE-\d{4}-\d+\b/i.test(normalized) ||
    /\b(?:sha|hash)\s+[a-f0-9]{5,}\b/i.test(normalized) ||
    /\bport\s+\d{2,5}\b/i.test(normalized) ||
    /\bv?\d+\.\d+(?:\.\d+)?\b/i.test(normalized)
  ) {
    return true;
  }

  const highSignalTokens = tokens.filter((token) => {
    if (/^[A-Z0-9]{2,}$/.test(token)) {
      return true;
    }

    if (/[-.:]/.test(token) || (/\d/.test(token) && /[A-Za-z]/.test(token))) {
      return true;
    }

    return false;
  });

  if (highSignalTokens.length > 0) {
    return true;
  }

  const nonStopLower = tokens
    .map((token) => token.toLowerCase())
    .filter((token) => !["what", "when", "where", "who", "was", "were", "doing", "tell", "show", "find", "the", "and", "for", "with", "in", "on", "at"].includes(token));

  return nonStopLower.length > 0 && nonStopLower.length <= 3 && !/\b(what|when|where|who)\b/i.test(normalized);
}
