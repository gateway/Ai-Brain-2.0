const QUERY_NAME_STOP_WORDS = new Set([
  "What",
  "When",
  "Where",
  "Why",
  "Who",
  "Would",
  "Could",
  "Which",
  "How",
  "Did",
  "Does",
  "Is",
  "Are",
  "Was",
  "Were",
  "In",
  "On",
  "At",
  "From",
  "By",
  "Before",
  "After",
  "During",
  "Considering",
  "The",
  "A",
  "An",
  "Last",
  "This",
  "That",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function extractQuerySurfaceNames(queryText: string): readonly string[] {
  const matches = queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gu) ?? [];
  const names = matches
    .map((match) => {
      const parts = match.split(/\s+/u).filter(Boolean);
      while (parts.length > 0 && QUERY_NAME_STOP_WORDS.has(parts[0]!)) {
        parts.shift();
      }
      while (parts.length > 0 && QUERY_NAME_STOP_WORDS.has(parts[parts.length - 1]!)) {
        parts.pop();
      }
      if (parts.length === 0) {
        return null;
      }
      const normalized = normalizeWhitespace(parts.join(" "));
      return normalized.length > 0 ? normalized : null;
    })
    .filter((value): value is string => value !== null);
  return [...new Set(names)];
}

function sanitizeNameCandidate(candidate: string | null | undefined): string | null {
  const parts = String(candidate ?? "").split(/\s+/u).filter(Boolean);
  while (parts.length > 0 && QUERY_NAME_STOP_WORDS.has(parts[0]!)) {
    parts.shift();
  }
  while (parts.length > 0 && QUERY_NAME_STOP_WORDS.has(parts[parts.length - 1]!)) {
    parts.pop();
  }
  if (parts.length === 0) {
    return null;
  }
  const normalized = normalizeWhitespace(parts.join(" "));
  return normalized.length > 0 ? normalized : null;
}

export function extractPrimaryQuerySurfaceNames(queryText: string): readonly string[] {
  const patterns = [
    /\b(?:When did|When is|When was|What is|What does|What did|Why did|Why does|Why is|Why was|Who did|Who does|Who is|Who was|Does|Did|Is|Was|Would|Could)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:'s)?\b/u,
    /\bHow\s+long\s+(?:has|had|did)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:'s)?\b/u,
    /\b(?:What|Which|In which|On which|By which)\b(?:\s+[A-Za-z][A-Za-z+'/&-]*){1,8}\s+(?:has|have|does|did|is|was|would|could)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:'s)?\b/u,
    /\b(?:In|At|On|By|From)\s+(?:what|which)\b(?:\s+[A-Za-z][A-Za-z+'/&-]*){1,8}\s+(?:has|have|does|did|is|was|would|could)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:'s)?\b/u,
    /\b(?:What motivated|What inspired|How did|How does|What fields would|What plans does|What plans do|What kind of place does|What kind of place would)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:'s)?\b/u,
    /\bWhat\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:thinks?|thought|feels?|felt|wants?|wanted|likes?)\b/u,
    /\bthat\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})'s\b/u
  ];
  const names: string[] = [];
  for (const pattern of patterns) {
    const match = queryText.match(pattern);
    const candidate = sanitizeNameCandidate(match?.[1]);
    if (candidate) {
      names.push(candidate);
    }
  }
  return [...new Set(names)];
}

export function extractPossessiveQuerySurfaceNames(queryText: string): readonly string[] {
  const names: string[] = [];
  for (const match of queryText.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})'s\b/gu)) {
    const candidate = sanitizeNameCandidate(match[1]);
    if (candidate) {
      names.push(candidate);
    }
  }
  return [...new Set(names)];
}

export function extractPairQuerySurfaceNames(queryText: string): readonly string[] {
  const match = queryText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+and\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u);
  if (!match) {
    return [];
  }
  const left = sanitizeNameCandidate(match[1]);
  const right = sanitizeNameCandidate(match[2]);
  return [...new Set([left, right].filter((value): value is string => Boolean(value)))];
}

export function extractAnchoredQuerySurfaceNames(queryText: string): readonly string[] {
  return [
    ...new Set([
      ...extractPossessiveQuerySurfaceNames(queryText),
      ...extractPrimaryQuerySurfaceNames(queryText),
      ...extractPairQuerySurfaceNames(queryText)
    ])
  ];
}

export function extractObjectQuerySurfaceNames(queryText: string): readonly string[] {
  const anchoredNames = new Set(extractAnchoredQuerySurfaceNames(queryText));
  return extractQuerySurfaceNames(queryText).filter((name) => !anchoredNames.has(name));
}

export function isPairAggregationQuery(queryText: string): boolean {
  return (
    extractPairQuerySurfaceNames(queryText).length >= 2 &&
    (
      /\bshare\b|\bin common\b|\bboth\b|\btogether\b/u.test(queryText) ||
      /\bmeet\b/u.test(queryText)
    )
  );
}
