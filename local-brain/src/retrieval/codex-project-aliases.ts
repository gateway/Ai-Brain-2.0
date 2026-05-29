import { normalizeWhitespace } from "../identity/canonicalization.js";

export interface CodexProjectAliasEntry {
  readonly canonicalLabel: string;
  readonly aliases: readonly string[];
}

export const CODEX_PROJECT_ALIASES: readonly CodexProjectAliasEntry[] = [
  {
    canonicalLabel: "AI Brain",
    aliases: ["AI Brain", "ai-brain", "AI-Brain", "local brain", "local-brain"]
  },
  {
    canonicalLabel: "Media Studio",
    aliases: ["Media Studio", "media-studio", "Media Assistant", "Graph Studio", "media app", "media product", "kie-ai", "kie api", "KIE API"]
  },
  {
    canonicalLabel: "Operator Workbench",
    aliases: ["Operator Workbench", "operator-workbench"]
  },
  {
    canonicalLabel: "FixMyPhoto",
    aliases: ["FixMyPhoto", "fixmyphoto", "fix-my-photo"]
  },
  {
    canonicalLabel: "2Way",
    aliases: ["2Way", "Two Way", "Two-Way", "2way"]
  }
];

export function normalizeProjectKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export function knownCodexProjectLabels(): readonly string[] {
  return CODEX_PROJECT_ALIASES.map((entry) => entry.canonicalLabel);
}

export function projectAliasEntryFor(value: string): CodexProjectAliasEntry | null {
  const key = normalizeProjectKey(value);
  if (!key) return null;
  return CODEX_PROJECT_ALIASES.find((entry) => entry.aliases.some((alias) => normalizeProjectKey(alias) === key)) ?? null;
}

export function canonicalCodexProjectLabel(value: string): string {
  return projectAliasEntryFor(value)?.canonicalLabel ?? titleCaseProject(value);
}

export function codexProjectLabelFromText(value: string): string | null {
  const haystack = normalizeProjectKey(value);
  if (!haystack) return null;
  for (const entry of CODEX_PROJECT_ALIASES) {
    if (entry.aliases.some((alias) => {
      const key = normalizeProjectKey(alias);
      return key.length > 0 && haystack.includes(key);
    })) {
      return entry.canonicalLabel;
    }
  }
  return null;
}

export function codexProjectMatchesText(projectLabel: string, value: string): boolean {
  const entry = projectAliasEntryFor(projectLabel);
  const aliases = entry?.aliases ?? [projectLabel];
  const haystack = normalizeProjectKey(value);
  return aliases.some((alias) => {
    const key = normalizeProjectKey(alias);
    return key.length > 0 && haystack.includes(key);
  });
}

export function titleCaseProject(value: string): string {
  return normalizeWhitespace(value)
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((part) => part.length <= 3 && part === part.toLowerCase() ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
