export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function normalizeEntityLookupName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

const CANONICAL_ALIAS_GROUPS = [
  {
    canonical: "koh samui",
    variants: ["koh samui", "ko samui", "samui", "kozimui"]
  },
  {
    canonical: "lake tahoe",
    variants: ["lake tahoe", "lake taho", "lake he"]
  },
  {
    canonical: "samui experience",
    variants: [
      "samui experience",
      "koh samui experience",
      "kozimui experience",
      "experience on koh samui",
      "experience on kozimui",
      "private park on koh samui",
      "private park on kozimui"
    ]
  }
] as const;

const CANONICAL_DISPLAY_NAMES: Record<string, string> = {
  "koh samui": "Koh Samui",
  "lake tahoe": "Lake Tahoe",
  "samui experience": "Samui Experience"
};

export function expandEntityLookupCandidates(value: string): readonly string[] {
  const normalized = normalizeEntityLookupName(value);
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  for (const group of CANONICAL_ALIAS_GROUPS) {
    if (group.variants.some((variant) => normalized === variant || normalized.includes(variant))) {
      candidates.add(group.canonical);
      for (const variant of group.variants) {
        candidates.add(variant);
      }
    }
  }

  return [...candidates];
}

export function canonicalAliasVariants(canonicalName: string): readonly string[] {
  const normalized = normalizeEntityLookupName(canonicalName);
  const matches = CANONICAL_ALIAS_GROUPS.find(
    (group) => group.canonical === normalized || group.variants.some((variant) => variant === normalized)
  );
  if (!matches) {
    return [];
  }

  return matches.variants
    .filter((variant) => variant !== normalized)
    .map((variant) =>
      variant
        .split(" ")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ")
    );
}

export function canonicalizeObservedEntityText(value: string): string {
  const normalized = normalizeEntityLookupName(value);
  if (!normalized) {
    return normalizeWhitespace(value);
  }

  const group = CANONICAL_ALIAS_GROUPS.find(
    (candidate) => candidate.canonical === normalized || candidate.variants.some((variant) => variant === normalized)
  );
  if (!group) {
    return normalizeWhitespace(value);
  }

  return CANONICAL_DISPLAY_NAMES[group.canonical] ?? normalizeWhitespace(group.canonical);
}
