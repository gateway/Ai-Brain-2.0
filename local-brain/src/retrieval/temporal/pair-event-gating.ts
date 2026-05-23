function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isPairEventTemporalQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return (
    /^\s*when\b/u.test(normalized) &&
    (
      /\btogether\b/u.test(normalized) ||
      /\bboth\b/u.test(normalized) ||
      /\bshared\b/u.test(normalized)
    ) &&
    (
      /\battend(?:ed|ing)?\b/u.test(normalized) ||
      /\bvisit(?:ed|ing)?\b/u.test(normalized) ||
      /\bwent to\b/u.test(normalized) ||
      /\bfestival\b/u.test(normalized) ||
      /\bconcert\b/u.test(normalized)
    )
  );
}

export function requiresPairEventTemporalBinding(queryText: string): boolean {
  return isPairEventTemporalQuery(queryText);
}
