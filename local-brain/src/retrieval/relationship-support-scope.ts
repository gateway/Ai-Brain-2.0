function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}

function extractRelationshipQuerySubjectHints(queryText: string): readonly string[] {
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
    "do"
  ]);
  return [...new Set((queryText.match(/\b[A-Z][a-z]+\b/gu) ?? [])
    .map((value) => normalize(value))
    .filter((value) => value && !stopTerms.has(value.toLowerCase())))];
}

function extractSpeakerScopedSegments(text: string): ReadonlyArray<{ readonly speaker: string; readonly segment: string }> {
  const matches = [...text.matchAll(/([A-Z][A-Za-z'’.-]{1,40}):\s*/gu)];
  if (matches.length === 0) {
    return [];
  }
  const segments: Array<{ readonly speaker: string; readonly segment: string }> = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const speaker = normalize(match[1]);
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : text.length;
    const segment = normalize(text.slice(start, end));
    if (!speaker || !segment) {
      continue;
    }
    segments.push({ speaker, segment });
  }
  return segments;
}

export function extractSubjectScopedRelationshipSupportText(queryText: string, texts: readonly string[]): string {
  const subjectHints = extractRelationshipQuerySubjectHints(queryText).map((value) => value.toLowerCase());
  if (subjectHints.length === 0) {
    return uniqueNormalized(texts).join(" ");
  }
  const scopedTexts: string[] = [];
  for (const text of texts) {
    const normalizedText = normalize(text);
    if (!normalizedText) {
      continue;
    }
    const speakerSegments = extractSpeakerScopedSegments(normalizedText);
    const matchingSegments = speakerSegments
      .filter((segment) => subjectHints.includes(segment.speaker.toLowerCase()))
      .map((segment) => segment.segment);
    if (matchingSegments.length > 0) {
      scopedTexts.push(...matchingSegments);
      continue;
    }
    if (subjectHints.some((hint) => normalizedText.toLowerCase().includes(hint))) {
      scopedTexts.push(normalizedText);
    }
  }
  const effectiveTexts = scopedTexts.length > 0 ? scopedTexts : texts;
  return uniqueNormalized(effectiveTexts).join(" ");
}
