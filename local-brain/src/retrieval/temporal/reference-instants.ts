export function buildTemporalReferenceInstantFromParts(
  year: number | null,
  month: number | null,
  day: number | null
): string | null {
  if (typeof year !== "number") {
    return null;
  }
  const monthIndex = typeof month === "number" ? month - 1 : 0;
  const resolvedDay = typeof day === "number" ? day : 1;
  return new Date(Date.UTC(year, monthIndex, resolvedDay, 12, 0, 0, 0)).toISOString();
}

export function selectBestTemporalReferenceInstant(instants: readonly (string | null | undefined)[]): string | null {
  const parsed = instants
    .map((value) => (typeof value === "string" && value.trim() ? value.trim() : null))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, millis: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.millis));
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((left, right) => right.millis - left.millis);
  return new Date(parsed[0]!.millis).toISOString();
}

export function selectPreferredTemporalReferenceInstant(instants: readonly (string | null | undefined)[]): string | null {
  for (const instant of instants) {
    if (typeof instant !== "string" || !instant.trim()) {
      continue;
    }
    const parsed = Date.parse(instant);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

export function selectRelativeTemporalReferenceInstant(
  occurredAt: string | null | undefined,
  sourceReferenceInstant: string | null | undefined,
  capturedAt: string | null | undefined
): string | null {
  const sourceScoped = selectBestTemporalReferenceInstant([sourceReferenceInstant, capturedAt]);
  if (sourceScoped) {
    return sourceScoped;
  }
  return selectBestTemporalReferenceInstant([occurredAt]);
}
