function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function uniqueNormalized(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values.map((entry) => normalize(entry)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  return [...unique.values()];
}

export function isCampingLocationQuery(queryText: string): boolean {
  return /\bwhere\b[^?!.]{0,80}\bcamp(?:ed|ing)?\b/iu.test(queryText);
}

export function inferCampingLocationCompletenessTarget(queryText: string): number {
  if (!isCampingLocationQuery(queryText)) {
    return 1;
  }
  return /\b(?:all|every|any other|else)\b/iu.test(queryText) ? 3 : 2;
}

export function hasCampingLocationSeedEvidence(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) {
    return false;
  }
  return /\bcamp(?:ed|ing|site|ground|fire)?\b/iu.test(normalized) && (
    /\b(?:beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)\b/iu.test(
      normalized
    ) ||
    /\b(?:trip|family|kids?|children|hike|nature|marshmallows|campfire)\b/iu.test(normalized)
  );
}

export function extractCampingPlacesFromText(text: string): readonly string[] {
  const values = new Set<string>();
  const campingSegments = text
    .split(/[\n.!?]+/u)
    .map((segment) => normalize(segment))
    .filter((segment) => /\bcamp(?:ed|ing|site|ground)?\b/iu.test(segment));
  if (campingSegments.length === 0) {
    return [];
  }
  const genericCampingStopWords = new Set([
    "family",
    "friends",
    "weekend",
    "trip",
    "camping",
    "camped",
    "campground",
    "campsite",
    "support group",
    "pride parade"
  ]);
  const normalizeCampingCandidate = (value: string): string | null => {
    const normalized = normalize(
      value
        .replace(/^and\s+/iu, "")
        .replace(/^(?:at|in|to|through|across|around|into|near)\s+/iu, "")
        .replace(/^(?:the|a|an|my|our|his|her|their)\s+/iu, "")
        .replace(/\b(?:with|during|before|after|around|for|while)\b.*$/iu, "")
        .replace(/[.?!,;:]+$/u, "")
    );
    if (!normalized || normalized.length > 40) {
      return null;
    }
    if (genericCampingStopWords.has(normalized.toLowerCase())) {
      return null;
    }
    if (/\b(?:support group|parade|festival|concert|church|gym|shelter|cafe|convention)\b/iu.test(normalized)) {
      return null;
    }
    if (
      /\b(?:beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)\b/iu.test(normalized)
    ) {
      return normalized;
    }
    if (/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\b/u.test(normalized)) {
      return normalized;
    }
    return null;
  };

  for (const segment of campingSegments) {
    for (const match of segment.matchAll(/\bcamp(?:ed|ing)?\b[^.!?\n]{0,120}?\b(?:at|in|to|through|across|around|into|near)\s+([^.!?\n]+)/giu)) {
      const clause = normalize(match[1] ?? "");
      if (!clause) {
        continue;
      }
      for (const part of clause.split(/\s*(?:,|\band\b)\s*/iu)) {
        const candidate = normalizeCampingCandidate(part);
        if (candidate) {
          values.add(candidate);
        }
      }
    }
    for (const match of segment.matchAll(/\b(beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)\b/giu)) {
      const candidate = normalizeCampingCandidate(match[1] ?? "");
      if (candidate) {
        values.add(candidate);
      }
    }
  }

  return uniqueNormalized([...values]);
}
