function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function extractLivePerformanceTarget(queryText: string): string | null {
  const normalized = normalize(queryText);
  if (!/\bsee\b/iu.test(normalized) || !/\bperform\s+live\b/iu.test(normalized)) {
    return null;
  }
  const directMatch = normalized.match(
    /\bsee\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\s+perform\s+live\b/u
  );
  return directMatch?.[1] ? normalize(directMatch[1]) : null;
}

export function isSawLivePerformanceQuery(queryText: string): boolean {
  return Boolean(extractLivePerformanceTarget(queryText));
}

export function scoreSawLivePerformanceEvidence(
  queryText: string,
  text: string | null | undefined
): number {
  const normalizedText = normalize(text);
  const target = extractLivePerformanceTarget(queryText);
  if (!target || !normalizedText) {
    return 0;
  }

  const targetPattern = new RegExp(`\\b${escapeRegExp(target)}\\b`, "iu");
  if (!targetPattern.test(normalizedText)) {
    return -5;
  }

  if (
    /\b(?:saw|seen|finally saw)\b[^.!?\n]{0,60}\b(?:perform\s+live|live)\b/iu.test(normalizedText) ||
    /\b(?:perform\s+live|live)\b[^.!?\n]{0,60}\b(?:saw|seen)\b/iu.test(normalizedText)
  ) {
    return 4.5;
  }

  if (
    /\bif i had to pick a favorite\b/iu.test(normalizedText) ||
    /\btheir performance was incredible\b/iu.test(normalizedText) ||
    (/\bperformance\b/iu.test(normalizedText) && /\bincredible\b/iu.test(normalizedText))
  ) {
    return 3;
  }

  if (/\b(?:music festival|festival|concert|headliner)\b/iu.test(normalizedText)) {
    return 1.5;
  }

  if (/\b(?:car show|cars?|automotive|engineering)\b/iu.test(normalizedText)) {
    return -8;
  }

  return -2;
}
