function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function extractEntityRelationshipClauses(sentence: string, entityName: string): readonly string[] {
  const normalizedEntity = entityName.trim().toLowerCase();
  if (!normalizedEntity) {
    return [];
  }

  const clauses = sentence
    .split(/\s*(?:;|(?<!\bLake)\bbut\b|(?<!\bLake)\bhowever\b|\bwhereas\b)\s+/iu)
    .flatMap((part) => part.split(/\s+(?=(?:and\s+)?[A-Z][a-z]+,\s)/u))
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 8);
  const matching = clauses.filter((part) => part.toLowerCase().includes(normalizedEntity));
  return matching.length > 0 ? matching : [normalizeWhitespace(sentence)];
}

export function sliceSentenceFromEntity(sentence: string, entityName: string): string | undefined {
  const normalizedSentence = sentence.toLowerCase();
  const normalizedEntity = entityName.trim().toLowerCase();
  const entityIndex = normalizedSentence.indexOf(normalizedEntity);
  if (entityIndex === -1) {
    return undefined;
  }
  return normalizeWhitespace(sentence.slice(entityIndex));
}

export function clipEntityRelationshipWindow(entityTail: string): string {
  const delimiterPatterns = [
    /,\s+(?:and\s+)?[A-Z][a-z]+(?:\b|,)/u,
    /\b(?:but|however|whereas)\b/iu
  ];
  let endIndex = entityTail.length;
  for (const pattern of delimiterPatterns) {
    const match = pattern.exec(entityTail);
    if (match?.index !== undefined && match.index > 0) {
      endIndex = Math.min(endIndex, match.index);
    }
  }
  return normalizeWhitespace(entityTail.slice(0, endIndex));
}

export function findEntityAdjacentObject(sentenceTail: string, objectPattern: RegExp, maxDistance: number): string | undefined {
  const match = objectPattern.exec(sentenceTail);
  if (!match?.[1] || match.index === undefined || match.index > maxDistance) {
    return undefined;
  }
  return normalizeWhitespace(match[1]).replace(/^[Tt]he\s+/u, "").replace(/[.,!?]+$/u, "");
}

export function findSentenceLevelRelationshipObjects(sentence: string, entityName: string): readonly string[] {
  const escapedEntity = entityName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const objects = new Set<string>();
  const patterns = [
    new RegExp(`\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+that\\s+${escapedEntity}\\s+owns\\b`, "giu"),
    new RegExp(`\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+is\\s+owned\\s+by\\s+${escapedEntity}\\b`, "giu"),
    new RegExp(`\\b${escapedEntity}\\s*\\(([^)]+)\\)`, "giu"),
    new RegExp(`\\b${escapedEntity}\\s+that\\s+owns\\s+([A-Z][A-Za-z0-9'’& -]{2,80})\\b`, "giu")
  ];
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      objects.add(value.replace(/^[Tt]he\s+/u, "").replace(/[.,!?]+$/u, "").trim());
    }
  }
  return [...objects];
}

export function extractAssociatedPlacesNearEntity(sentenceTail: string): readonly string[] {
  const places = new Set<string>();
  const directPlacePatterns = [
    /\b(Chiang Mai|Bangkok|Thailand|Lake Tahoe|Koh Samui|Bend|Oregon|Mexico City|Tahoe City|Japan)\b/giu
  ];
  for (const pattern of directPlacePatterns) {
    for (const match of sentenceTail.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      places.add(value);
    }
  }

  for (const match of sentenceTail.matchAll(/\b(?:from|in)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/gu)) {
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    const cleaned = value.replace(/[.,!?]+$/u, "");
    if (
      cleaned.split(/\s+/u).length <= 3 &&
      !["Chiang", "Lake", "Koh", "Tahoe", "Mexico"].includes(cleaned) &&
      !cleaned.toLowerCase().startsWith("a ")
    ) {
      places.add(cleaned);
    }
  }

  return [...places];
}
