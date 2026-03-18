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
