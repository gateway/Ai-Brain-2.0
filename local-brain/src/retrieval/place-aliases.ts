import { normalizeWhitespace } from "../identity/canonicalization.js";

export interface PlaceAliasEntry {
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly aliasType?: "place_alias" | "venue_alias" | "region_alias";
  readonly ownerSubject?: string;
  readonly source: "manual_seed" | "candidate_ledger";
  readonly confidence: number;
}

const PLACE_ALIASES: readonly PlaceAliasEntry[] = [
  {
    canonical: "Chiang Mai",
    source: "manual_seed",
    confidence: 0.98,
    aliases: [
      "chiang mai",
      "cmu",
      "weave artisan",
      "canass hotel",
      "living a dream",
      "changklan",
      "chang khlan",
      "tambon chang khlan"
    ]
  },
  {
    canonical: "Istanbul",
    source: "manual_seed",
    confidence: 0.97,
    aliases: ["istanbul", "turkey"]
  },
  {
    canonical: "Bend",
    source: "manual_seed",
    confidence: 0.96,
    aliases: ["bend", "bend oregon"]
  },
  {
    canonical: "Reno",
    source: "manual_seed",
    confidence: 0.95,
    aliases: ["reno"]
  },
  {
    canonical: "Thailand",
    source: "manual_seed",
    confidence: 0.96,
    aliases: ["thailand", "koh samui", "bangkok", "pai"]
  }
];

export interface AliasInventoryEntry {
  readonly canonical: string;
  readonly alias: string;
  readonly entityRole: "person" | "place" | "project" | "org" | "venue";
  readonly aliasType: "manual_seed" | "spelling_variant" | "venue_alias" | "org_alias" | "project_alias";
  readonly ownerSubject: string | null;
  readonly source: "manual_seed";
  readonly confidence: number;
}

export function manualGraphAliasInventory(): readonly AliasInventoryEntry[] {
  const people: readonly AliasInventoryEntry[] = [
    { canonical: "Gummi", alias: "Gummi", entityRole: "person", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.98 },
    { canonical: "Gummi", alias: "Gumi", entityRole: "person", aliasType: "spelling_variant", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.95 },
    { canonical: "Gummi", alias: "Gumee", entityRole: "person", aliasType: "spelling_variant", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.92 },
    { canonical: "Gummi", alias: "Omi Gummi", entityRole: "person", aliasType: "spelling_variant", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.9 },
    { canonical: "Ben", alias: "Ben Williams", entityRole: "person", aliasType: "spelling_variant", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.92 },
    { canonical: "Tim", alias: "Tim", entityRole: "person", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.96 },
    { canonical: "Dan", alias: "Dan", entityRole: "person", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.96 }
  ];
  const places = PLACE_ALIASES.flatMap((entry) =>
    [entry.canonical, ...entry.aliases].map<AliasInventoryEntry>((alias) => ({
      canonical: entry.canonical,
      alias,
      entityRole: alias === entry.canonical || alias.toLowerCase() === entry.canonical.toLowerCase() ? "place" : "venue",
      aliasType: alias === entry.canonical || alias.toLowerCase() === entry.canonical.toLowerCase() ? "manual_seed" : "venue_alias",
      ownerSubject: "Steve Tietze",
      source: "manual_seed",
      confidence: entry.confidence
    }))
  );
  const projects: readonly AliasInventoryEntry[] = [
    { canonical: "Two Way", alias: "Two Way", entityRole: "project", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.97 },
    { canonical: "Two Way", alias: "Two-Way", entityRole: "project", aliasType: "project_alias", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.96 },
    { canonical: "Two Way", alias: "2Way", entityRole: "project", aliasType: "project_alias", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.94 },
    { canonical: "Well Inked", alias: "Well Inked", entityRole: "org", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.96 },
    { canonical: "AI Brain", alias: "AI Brain", entityRole: "project", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.96 },
    { canonical: "Preset Kitchen", alias: "Preset Kitchen", entityRole: "project", aliasType: "manual_seed", ownerSubject: "Steve Tietze", source: "manual_seed", confidence: 0.94 }
  ];
  return [...people, ...places, ...projects];
}

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export function knownPlaceAliases(): readonly PlaceAliasEntry[] {
  return PLACE_ALIASES;
}

export function canonicalPlaceName(value: string | null | undefined): string | null {
  const key = normalizeKey(value ?? "");
  if (!key) {
    return null;
  }
  for (const entry of PLACE_ALIASES) {
    if (normalizeKey(entry.canonical) === key || entry.aliases.some((alias) => normalizeKey(alias) === key)) {
      return entry.canonical;
    }
  }
  return null;
}

export function extractPlaceScopes(queryText: string): readonly string[] {
  const normalized = normalizeWhitespace(queryText);
  const places = new Set<string>();
  for (const entry of PLACE_ALIASES) {
    if (textMatchesPlaceAlias(normalized, entry.canonical)) {
      places.add(entry.canonical);
    }
  }
  const prepositionMatches = normalized.matchAll(
    /\b(?:in|from|around|near|through|after|before|to|for)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})\b/gu
  );
  for (const match of prepositionMatches) {
    const candidate = normalizeWhitespace((match[1] ?? "").replace(/[?.!,;:]+$/u, ""));
    const canonical = canonicalPlaceName(candidate);
    if (canonical) {
      places.add(canonical);
    }
  }
  return [...places];
}

export function textMatchesPlaceAlias(text: string, placeScope: string | null | undefined): boolean {
  const place = canonicalPlaceName(placeScope) ?? normalizeWhitespace(placeScope ?? "");
  if (!place) {
    return true;
  }
  const entry = PLACE_ALIASES.find((item) => item.canonical.toLowerCase() === place.toLowerCase());
  const aliases = entry ? [entry.canonical, ...entry.aliases] : [place];
  const normalized = normalizeWhitespace(text).toLowerCase();
  return aliases.some((alias) => {
    const key = normalizeKey(alias);
    if (!key) {
      return false;
    }
    if (/^[a-z0-9]+$/u.test(key)) {
      return new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(normalized);
    }
    return normalized.includes(key);
  });
}
