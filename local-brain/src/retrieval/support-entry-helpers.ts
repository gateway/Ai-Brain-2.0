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

export const KNOWN_INSTRUMENT_LABELS = [
  "guitar",
  "piano",
  "drums",
  "violin",
  "cello",
  "flute",
  "saxophone",
  "clarinet",
  "trumpet",
  "trombone",
  "ukulele",
  "keyboard",
  "bass",
  "harmonica",
  "banjo"
] as const;

export const KNOWN_POTTERY_ITEM_LABELS = [
  "bowl",
  "bowls",
  "plate",
  "plates",
  "mug",
  "mugs",
  "vase",
  "vases",
  "planter",
  "planters",
  "cup",
  "cups",
  "figurine",
  "figurines",
  "clay animal",
  "clay animals",
  "pot",
  "pots"
] as const;

export function extractSupportContactsFromText(text: string): readonly string[] {
  const values = new Set<string>();
  if (!normalize(text)) {
    return [];
  }
  for (const [label, pattern] of [
    ["teammates on his video game team", /(?:\b(?:my team|teammates?)\b.*\b(?:game|gaming|tournament|counter-?strike|valorant|street fighter)\b|\b(?:game|gaming|tournament|counter-?strike|valorant|street fighter)\b.*\b(?:my team|teammates?)\b)/iu],
    ["teammates on his video game team", /\bold friends?\s+and\s+teamm?ates?\s+from other tournaments\b/iu],
    ["old friends from other tournaments", /\bold friends?\s+from other tournaments\b/iu],
    ["friends outside his usual circle from tournaments", /\boutside of my circle\b|\boutside\s+(?:his|her|their)\s+usual circle\b/iu],
    ["friends from gaming conventions", /\bfriends?\s+(?:at|from)\s+the convention\b|\bmade some friends\b.*\bgame(?:s|ing)?\b/iu],
    ["mentors", /\bmentors?\b/iu],
    ["family", /\bfamily\b/iu],
    ["friends", /\bfriends?\b/iu]
  ] as const) {
    if (pattern.test(text)) {
      values.add(label);
    }
  }
  return uniqueNormalized([...values]);
}
