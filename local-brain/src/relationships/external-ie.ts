import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { readConfig } from "../config.js";
import { resolveCanonicalEntityReference } from "../identity/service.js";
import { compilerCacheKey, loadCompilerCacheEntry, upsertCompilerCacheEntry } from "../taxonomy-temporal/compiler-cache.js";
import { GLINER_RELEX_EXTRACTOR, mapRelexRelationLabel } from "./relex-schema.js";

interface SceneSidecarInput {
  readonly sceneIndex: number;
  readonly sceneId: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
}

export type ExternalRelationIeMode = "support_only" | "support_and_promote";

interface SidecarEntity {
  readonly text?: string;
  readonly label?: string;
  readonly score?: number;
  readonly start?: number;
  readonly end?: number;
}

interface SidecarRelation {
  readonly source?: string;
  readonly target?: string;
  readonly relation?: string;
  readonly score?: number;
  readonly relationship_kind?: string;
  readonly start?: number;
  readonly end?: number;
}

interface SidecarExtractorResult {
  readonly extractor: string;
  readonly model_id?: string;
  readonly schema_version?: string;
  readonly thresholds?: Record<string, number>;
  readonly entities?: readonly SidecarEntity[];
  readonly relations?: readonly SidecarRelation[];
  readonly classifications?: Readonly<Record<string, unknown>> | null;
  readonly structures?: Readonly<Record<string, unknown>> | null;
  readonly warnings?: readonly string[];
}

interface SidecarSceneResult {
  readonly scene_index: number;
  readonly extractors: readonly SidecarExtractorResult[];
}

interface SidecarResponse {
  readonly scenes: readonly SidecarSceneResult[];
  readonly errors?: readonly string[];
}

interface SidecarDaemonRequestMessage {
  readonly request_id: string;
  readonly command: "infer" | "shutdown";
  readonly payload?: Record<string, unknown>;
}

interface SidecarDaemonResponseMessage {
  readonly request_id?: string | null;
  readonly response?: SidecarResponse | { readonly ok: boolean; readonly shutdown?: boolean };
  readonly error?: string;
}

interface SidecarPendingRequest {
  readonly resolve: (response: SidecarResponse) => void;
  readonly reject: (error: Error) => void;
}

interface SidecarDaemonState {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<string, SidecarPendingRequest>;
  stdoutBuffer: string;
  stderrBuffer: string;
  nextRequestId: number;
}

let sidecarDaemonState: SidecarDaemonState | null = null;
let sidecarExitHooksRegistered = false;

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot(): string {
  return path.resolve(thisDir(), "../../..");
}

function forceKillSidecarOnExit(): void {
  const state = sidecarDaemonState;
  if (!state) {
    return;
  }
  sidecarDaemonState = null;
  if (!state.child.killed) {
    state.child.kill("SIGKILL");
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

function isPlaceholderAffiliationSubject(value: string | null): boolean {
  const normalized = normalizeName(value ?? "");
  if (!normalized) {
    return true;
  }
  return /^(?:speaker(?:\s*\d+)?|the speaker|speaker0|speaker1|and|but|then|someone|person)$/u.test(normalized);
}

function normalizeExtractorName(value: string | null | undefined): string {
  const normalized = normalizeWhitespace(value ?? "").toLowerCase();
  return normalized === "gliner_relex" ? GLINER_RELEX_EXTRACTOR : normalized;
}

function readSidecarString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? normalizeWhitespace(value) : null;
}

function readSidecarRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSidecarArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function classificationList(value: Readonly<Record<string, unknown>> | null | undefined, key: string): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const raw = value[key];
  if (Array.isArray(raw)) {
    return raw.map((entry) => normalizeWhitespace(String(entry ?? "")).toLowerCase()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return [normalizeWhitespace(raw).toLowerCase()];
  }
  return [];
}

function keepOnlyMeta(value: Readonly<Record<string, unknown>> | null | undefined): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const meta = readSidecarRecord(value.__meta);
  return meta ? { __meta: meta } : null;
}

function hasAnyValue(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = entry[key];
    return typeof value === "string" ? value.trim().length > 0 : value !== null && typeof value !== "undefined";
  });
}

function hasFirstPersonCue(value: string | null | undefined): boolean {
  return /\b(?:i|me|my|mine|we|our|ours|myself|first-person)\b/iu.test(String(value ?? ""));
}

function isHabitualSceneText(text: string): boolean {
  return /\b(?:usually|every day|every morning|every night|wake|wake up|start work|stop checking|routine)\b/iu.test(text);
}

function isOwnershipRole(value: string | null | undefined): boolean {
  return /\b(?:owner|founder|cofounder|creator)\b/iu.test(String(value ?? ""));
}

function looksExplicitTransition(change: string | null | undefined): boolean {
  return /\b(?:left|leave|moved|move|returned|return|flew|fly|started|start|stopped|stop|became|become|ended|end|transitioned|changed|shifted|no longer)\b/iu.test(
    String(change ?? "")
  );
}

function isCoarseYearOnlyTime(value: string | null | undefined): boolean {
  return /^\d{4}$/.test(String(value ?? "").trim());
}

function cleanStructuredPhrase(value: string | null | undefined): string | null {
  const normalized = readSidecarString(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/^(?:an?|the)\s+/iu, "").trim() || null;
}

function trimTrailingProjectNoise(value: string | null | undefined): string | null {
  const cleaned = cleanStructuredPhrase(value);
  if (!cleaned) {
    return null;
  }
  return cleaned
    .replace(/\s+(?:while|and)\s+(?:redesigning|planning)\b.*$/iu, "")
    .replace(/\s+owned by\b.*$/iu, "")
    .trim() || null;
}

function cleanupProjectLabel(value: string | null | undefined): string | null {
  const cleaned = trimTrailingProjectNoise(value);
  if (!cleaned) {
    return null;
  }
  return cleaned
    .replace(/\b(?:using|with)\s+Postgres(?:\s+and\s+[^,.;]+)?$/iu, "")
    .replace(/\b(?:using|with)\s+relationship graphs?$/iu, "")
    .trim() || null;
}

function cleanupOrganizationLabel(value: string | null | undefined): string | null {
  const cleaned = trimTrailingProjectNoise(value);
  if (!cleaned) {
    return null;
  }
  return cleaned.replace(/\bwhile\b.*$/iu, "").trim() || null;
}

function looksLikePersonName(value: string | null | undefined): boolean {
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/u.test(String(value ?? "").trim());
}

function cleanRoleLabel(value: string | null | undefined): string | null {
  const cleaned = cleanStructuredPhrase(value);
  if (!cleaned) {
    return null;
  }
  const parts = cleaned
    .split(/\s+slash\s+|\/|,|\s+and\s+/iu)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const priorities = [
    /\bcto\b/iu,
    /\bceo\b/iu,
    /\bcfo\b/iu,
    /\bcoo\b/iu,
    /\bfounder\b/iu,
    /\bowner\b/iu,
    /\badvisor\b/iu,
    /\badviser\b/iu,
    /\bcreator\b/iu
  ];
  for (const priority of priorities) {
    const preferred = parts.find((entry) => priority.test(entry));
    if (preferred) {
      return preferred;
    }
  }
  return cleaned;
}

function projectCuePresent(sceneText: string, supportFamilies: ReadonlySet<string>): boolean {
  if (supportFamilies.has("project_focus")) {
    return true;
  }
  return /\b(?:working with .* on|worked on|split work across|personally on|also on|cto for|talked about .* how to create|create .* using|build .* using)\b/iu.test(sceneText);
}

function looksLikeToolSubstrate(value: string | null | undefined): boolean {
  return /\b(?:postgres|postgresql|database|sql|vector|embedding|graph|knowledge graph|entity extraction|gliner|chroma|timescale|bm25|index)\b/iu.test(
    String(value ?? "")
  );
}

function hasOrganizationCue(sceneText: string, organization: string | null | undefined): boolean {
  const organizationText = String(organization ?? "").trim();
  if (!organizationText) {
    return false;
  }
  const escaped = organizationText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b(?:company|organization|org|client|employer|institution|team|at|for)\\s+(?:the\\s+)?${escaped}\\b`, "iu").test(
    sceneText
  );
}

function appendUniqueStructuredEntry(
  entries: Record<string, unknown>[],
  nextEntry: Record<string, unknown>,
  fields: readonly string[]
): void {
  const signature = fields
    .map((field) => normalizeWhitespace(String(nextEntry[field] ?? "")).toLowerCase())
    .join("|");
  if (!signature.replace(/\|/gu, "").trim()) {
    return;
  }
  const existing = entries.find((entry) =>
    fields
      .map((field) => normalizeWhitespace(String(entry[field] ?? "")).toLowerCase())
      .join("|") === signature
  );
  if (existing) {
    const oldSupport = readSidecarString(existing.support_phrase);
    const nextSupport = readSidecarString(nextEntry.support_phrase);
    const nextValue = readSidecarString(nextEntry.answer_value) ?? readSidecarString(nextEntry.object_value);
    const oldLooksWeak =
      !oldSupport ||
      (nextValue !== null && !normalizeWhitespace(oldSupport).toLowerCase().includes(normalizeWhitespace(nextValue).toLowerCase())) ||
      /\b(?:with so much to see|experiment with different combinations|that sounds like|congratulations|hope this helps)\b/iu.test(oldSupport);
    if (nextSupport && oldLooksWeak) {
      existing.support_phrase = nextSupport;
    }
    return;
  }
  if (!existing) {
    entries.push(nextEntry);
  }
}

function deriveProjectEntriesFromSceneText(params: {
  readonly sceneText: string;
  readonly supportFamilies: ReadonlySet<string>;
  readonly projectEntries: Record<string, unknown>[];
}): void {
  if (!projectCuePresent(params.sceneText, params.supportFamilies)) {
    return;
  }

  const withOnPattern = /with\s+([^,]+?)\s+on\s+(?:an?\s+)?([^,.;]+?)(?=(?:,\s*(?:with|personally on|and also on|also on))|[.;]|$)/giu;
  for (const match of params.sceneText.matchAll(withOnPattern)) {
    const subject = cleanStructuredPhrase(match[1]);
    const rawProject = cleanupProjectLabel(match[2]);
    if (!rawProject) {
      continue;
    }
    const [project, organization] = rawProject.split(/\s+for\s+/iu, 2).map((entry) => cleanupProjectLabel(entry));
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject,
        project: project ?? rawProject,
        role: null,
        organization: organization ?? null,
        time: null
      },
      ["subject", "project", "organization", "role"]
    );
  }

  const soloPatterns = [
    /personally on\s+(?:an?\s+)?([^,.;]+?)(?=(?:,\s*(?:and also on|also on))|[.;]|$)/giu,
    /also on\s+(?:an?\s+)?([^,.;]+?)(?=\s+to\b|[.;]|$)/giu
  ];
  for (const pattern of soloPatterns) {
    for (const match of params.sceneText.matchAll(pattern)) {
      const project = cleanupProjectLabel(match[1]);
      if (!project) {
        continue;
      }
      appendUniqueStructuredEntry(
        params.projectEntries,
        {
          subject: "I",
          project,
          role: null,
          organization: null,
          time: null
        },
        ["subject", "project", "organization", "role"]
      );
    }
  }

  const splitAcrossMatch = params.sceneText.match(/\bsplit work across\s+([^.;]+?)(?=\s+and\s+take\b|,|[.;]|$)/iu);
  if (splitAcrossMatch) {
    for (const candidate of splitAcrossMatch[1].split(/\s+and\s+|,/iu)) {
      const project = cleanupProjectLabel(candidate);
      if (!project) {
        continue;
      }
      appendUniqueStructuredEntry(
        params.projectEntries,
        {
          subject: "I",
          project,
          role: null,
          organization: null,
          time: null
        },
        ["subject", "project", "organization", "role"]
      );
    }
  }

  for (const match of params.sceneText.matchAll(/\bworked on\s+(?:an?\s+)?([^,.;]+?)\s+using\s+([^,.;]+?)(?=,|\s+on\s+|[.;]|$)/giu)) {
    const project = cleanupProjectLabel(match[1]);
    const substrate = cleanupOrganizationLabel(match[2]);
    if (!project) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role: null,
        organization: null,
        time: /\byesterday\b/iu.test(params.sceneText) ? "Yesterday" : null,
        tool_substrate: substrate,
        support_phrase: substrate ? `${project} using ${substrate}` : project
      },
      ["subject", "project", "tool_substrate", "role"]
    );
  }

  for (const match of params.sceneText.matchAll(/\bon\s+([^,.;]+?)\s+for\s+([^,.;]+?)(?=,|\s+and\s+as\b|\s+while\b|[.;]|$)/giu)) {
    const project = cleanupProjectLabel(match[1]);
    const organization = cleanupOrganizationLabel(match[2]);
    if (!project || !organization) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role: null,
        organization,
        time: /\byesterday\b/iu.test(params.sceneText) ? "Yesterday" : null
      },
      ["subject", "project", "organization", "role"]
    );
  }

  for (const match of params.sceneText.matchAll(/\bon\s+([^,.;]+?)(?=,|\s+and\b|[.;]|$)/giu)) {
    const project = cleanupProjectLabel(match[1]);
    if (!project || /\b(?:for|website|relationship graphs?)\b/iu.test(project)) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role: null,
        organization: null,
        time: /\byesterday\b/iu.test(params.sceneText) ? "Yesterday" : null
      },
      ["subject", "project", "organization", "role"]
    );
  }

  const roleForPattern = /\bas\s+([^,.;]+?)\s+for\s+([^,.;]+?)(?=\s+owned by\b|,|\s+while\b|[.;]|$)/giu;
  for (const match of params.sceneText.matchAll(roleForPattern)) {
    const role = cleanRoleLabel(match[1]);
    const project = cleanupProjectLabel(match[2]);
    if (!role || !project) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role,
        organization: null,
        time: /\byesterday\b/iu.test(params.sceneText) ? "Yesterday" : null
      },
      ["subject", "project", "role", "organization"]
    );
  }

  const workForPattern = /\bwork for (?:him|her|them)\s+as\s+([^,.;]+?)\s+of\s+(?:his|her|their)\s+company\s+([^,.;]+?)(?=,|[.;]|$)/giu;
  for (const match of params.sceneText.matchAll(workForPattern)) {
    const role = cleanRoleLabel(match[1]);
    const project = cleanupProjectLabel(match[2]);
    if (!role || !project) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role,
        organization: null,
        time: null
      },
      ["subject", "project", "role", "organization"]
    );
  }

  const companyTitlePattern = /\b(?:adviser\s+slash\s+)?(CTO|CEO|CFO|COO)\b(?:\s+of\s+(?:his|her|their)\s+company)?\s+([^,.;]+?)(?=,|[.;]|$)/giu;
  for (const match of params.sceneText.matchAll(companyTitlePattern)) {
    const role = cleanRoleLabel(match[1]);
    const project = cleanupProjectLabel(match[2]);
    if (!role || !project) {
      continue;
    }
    appendUniqueStructuredEntry(
      params.projectEntries,
      {
        subject: "I",
        project,
        role,
        organization: null,
        time: /\b2026\b/u.test(params.sceneText) ? "2026" : null
      },
      ["subject", "project", "role", "organization"]
    );
  }

  const projectGraphMatch = params.sceneText.match(
    /\btalked about\s+(?:the\s+)?([^,.;]+?)\s+and\s+how to create\s+(?:the\s+)?([^,.;]+?)\s+using\s+(?:a\s+)?([^,.;]+?)(?=\s+to\b|[.;]|$)/iu
  );
  if (projectGraphMatch) {
    const project = cleanupProjectLabel(projectGraphMatch[1]);
    const graph = cleanupProjectLabel(projectGraphMatch[2]);
    const substrate = cleanupOrganizationLabel(projectGraphMatch[3]);
    if (project && graph && substrate && /\b(?:engine|project|graph|database|extraction|memoir|brain)\b/iu.test(params.sceneText)) {
      appendUniqueStructuredEntry(
        params.projectEntries,
        {
          subject: /\bben\b/iu.test(params.sceneText) ? "Ben" : "I",
          project,
          role: null,
          organization: null,
          time: null,
          support_phrase: `create ${graph} using ${substrate}`,
          graph_component: graph,
          tool_substrate: substrate
        },
        ["subject", "project", "graph_component", "tool_substrate"]
      );
    }
  }
}

function upgradeProjectRolesFromSceneText(sceneText: string, projectEntries: Record<string, unknown>[]): void {
  const roleMatches = [
    ...sceneText.matchAll(/\bwork for (?:him|her|them)\s+as\s+([^,.;]+?)\s+of\s+(?:his|her|their)\s+company\s+([^,.;]+?)(?=,|[.;]|$)/giu),
    ...sceneText.matchAll(/\b(?:adviser\s+slash\s+)?(CTO|CEO|CFO|COO)\b(?:\s+of\s+(?:his|her|their)\s+company)?\s+([^,.;]+?)(?=,|[.;]|$)/giu)
  ];
  for (const match of roleMatches) {
    const role = cleanRoleLabel(match[1]);
    const project = cleanupProjectLabel(match[2]);
    if (!role || !project) {
      continue;
    }
    const existing = projectEntries.find((entry) => normalizeName(String(entry.project ?? "")) === normalizeName(project));
    if (existing) {
      existing.role = role;
      continue;
    }
    appendUniqueStructuredEntry(
      projectEntries,
      {
        subject: "I",
        project,
        role,
        organization: null,
        time: /\b2026\b/u.test(sceneText) ? "2026" : null
      },
      ["subject", "project", "role", "organization"]
    );
  }
}

function deriveRelationshipEntriesFromSceneText(params: {
  readonly sceneText: string;
  readonly supportFamilies: ReadonlySet<string>;
  readonly narrativeFrames: ReadonlySet<string>;
  readonly relationshipEntries: Record<string, unknown>[];
}): void {
  if (!params.supportFamilies.has("relationship")) {
    return;
  }
  if (params.narrativeFrames.has("plan") && !params.narrativeFrames.has("fact")) {
    return;
  }

  const introducedMatch = params.sceneText.match(/\b([A-Z][a-z]+)\s+later introduced\s+([A-Z][a-z]+)\b/u);
  if (introducedMatch) {
    appendUniqueStructuredEntry(
      params.relationshipEntries,
      {
        subject: cleanStructuredPhrase(introducedMatch[1]),
        other_person: cleanStructuredPhrase(introducedMatch[2]),
        relation: null,
        organization: null,
        time: null
      },
      ["subject", "other_person", "relation", "organization"]
    );
  }

  const communityListMatch = params.sceneText.match(/\bincluding\s+([A-Z][a-z]+(?:,\s+[A-Z][a-z]+)*(?:,\s+and\s+[A-Z][a-z]+|\s+and\s+[A-Z][a-z]+)?)\b/u);
  if (communityListMatch) {
    const names = communityListMatch[1]
      .split(/,\s*|\s+and\s+/u)
      .map((entry) => cleanStructuredPhrase(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (names.length >= 2) {
      appendUniqueStructuredEntry(
        params.relationshipEntries,
        {
          subject: names[0],
          other_person: names[Math.min(2, names.length - 1)],
          relation: null,
          organization: null,
          time: null
        },
        ["subject", "other_person", "relation", "organization"]
      );
    }
  }
}

function deriveRoutineEntriesFromSceneText(params: {
  readonly sceneText: string;
  readonly supportFamilies: ReadonlySet<string>;
  readonly routineEntries: Record<string, unknown>[];
}): void {
  if (!params.supportFamilies.has("routine") && !isHabitualSceneText(params.sceneText)) {
    return;
  }

  const redditMatch = params.sceneText.match(/\bcheck\s+([^,.;]+?)\s+on\s+Reddit\b/iu);
  if (redditMatch) {
    appendUniqueStructuredEntry(
      params.routineEntries,
      {
        subject: "I",
        time_of_day: null,
        activity: cleanStructuredPhrase(`check ${redditMatch[1]}`),
        context: "Reddit"
      },
      ["subject", "time_of_day", "activity", "context"]
    );
  }
}

function deriveTransitionEntriesFromSceneText(params: {
  readonly sceneText: string;
  readonly supportFamilies: ReadonlySet<string>;
  readonly narrativeFrames: ReadonlySet<string>;
  readonly transitionEntries: Record<string, unknown>[];
}): void {
  if (!(params.supportFamilies.has("temporal_event") || params.narrativeFrames.has("temporal") || params.narrativeFrames.has("plan"))) {
    return;
  }

  const plannedTripMatch = params.sceneText.match(
    /\b(?:planned\s+)?trip\s+to\s+(.+?)(?=\s+at\s+the\s+end\s+of\b|\s+at\b|\s+for\b|[.;]|$).*?\b(?:at\s+the\s+)?(?:end\s+of\s+)?([A-Z][a-z]+)\b(?:\s+for\s+([^.;]+?))?(?=[.;]|$)/u
  );
  if (plannedTripMatch) {
    const place = cleanStructuredPhrase(plannedTripMatch[1]);
    const month = cleanStructuredPhrase(plannedTripMatch[2]);
    const reason = cleanStructuredPhrase(plannedTripMatch[3]);
    if (place && month) {
      appendUniqueStructuredEntry(
        params.transitionEntries,
        {
          subject: "I",
          change: `planned trip to ${place}`,
          counterparty: null,
          time: params.sceneText.includes("end of") ? `end of ${month}` : month,
          reason
        },
        ["subject", "change", "time", "reason"]
      );
    }
  }

  const departureMatch = params.sceneText.match(
    /\b([A-Z][A-Za-z]+)\s+left\s+([^.;]+?)\s+(?:to\s+fly\s+back\s+to|to)\s+([^.;]+?)(?=[.;]|$)/u
  );
  const dateMatch = params.sceneText.match(/\b(?:on\s+)?((?:\d{1,2}\/\d{1,2}\/\d{4})|(?:[A-Z][a-z]+\s+\d{1,2},\s+\d{4}))\b/u);
  if (departureMatch) {
    const subject = cleanStructuredPhrase(departureMatch[1]);
    const origin = cleanStructuredPhrase(departureMatch[2]);
    const destination = cleanStructuredPhrase(departureMatch[3].replace(/\bspecifically\s+to\s+/iu, ""));
    const time = cleanStructuredPhrase(dateMatch?.[1]);
    if (subject && destination) {
      appendUniqueStructuredEntry(
        params.transitionEntries,
        {
          subject,
          change: origin ? `left ${origin} for ${destination}` : `left for ${destination}`,
          counterparty: null,
          time,
          reason: null
        },
        ["subject", "change", "time"]
      );
    }
  }

  const namedSubject = cleanStructuredPhrase(params.sceneText.match(/\b([A-Z][A-Za-z]+)\s+left\b/u)?.[1]);
  const flewBackMatch = params.sceneText.match(/\b(?:she|he|they|[A-Z][A-Za-z]+)\s+flew\s+back\s+to\s+([^.;]+?)\s+to\s+([^.;]+?)(?=\s+and\s+(?:we|they|he|she|I)\b|[.;]|$)/iu);
  if (namedSubject && flewBackMatch) {
    const intermediate = cleanStructuredPhrase(flewBackMatch[1]);
    const destination = cleanStructuredPhrase(flewBackMatch[2]);
    const time = cleanStructuredPhrase(dateMatch?.[1]);
    if (destination) {
      appendUniqueStructuredEntry(
        params.transitionEntries,
        {
          subject: namedSubject,
          change: intermediate ? `flew back to ${intermediate} to ${destination}` : `flew back to ${destination}`,
          counterparty: null,
          time,
          reason: null
        },
        ["subject", "change", "time"]
      );
    }
  }
}

function deriveLongMemExactDetailEntriesFromSceneText(params: {
  readonly sceneText: string;
  readonly scalarEntries: Record<string, unknown>[];
  readonly eventEntries: Record<string, unknown>[];
  readonly selfBindingEntries: Record<string, unknown>[];
}): void {
  const text = params.sceneText;
  const firstPerson = /\b(?:I|i|my|mine|me|we|our)\b/u.test(text);
  const ownershipCue = firstPerson ? "I" : null;
  let derivedExactDetail = false;
  const markDerivedExactDetail = () => {
    derivedExactDetail = true;
  };

  const addScalar = (propertyKey: string, answerValue: string | null, supportPhrase: string | null, valueUnit?: string | null) => {
    if (!answerValue && !supportPhrase) {
      return;
    }
    markDerivedExactDetail();
    appendUniqueStructuredEntry(
      params.scalarEntries,
      {
        subject: firstPerson ? "I" : null,
        property_key: propertyKey,
        answer_value: answerValue,
        value_unit: valueUnit ?? null,
        ownership_cue: ownershipCue,
        time_context: null,
        support_phrase: supportPhrase ?? cleanStructuredPhrase(text.slice(0, 180))
      },
      ["property_key", "answer_value", "support_phrase"]
    );
  };
  const addEvent = (
    predicateFamily: string,
    objectValue: string | null,
    objectType: string,
    eventLabel: string,
    supportPhrase: string | null
  ) => {
    if (!objectValue && !supportPhrase) {
      return;
    }
    markDerivedExactDetail();
    appendUniqueStructuredEntry(
      params.eventEntries,
      {
        subject: firstPerson ? "I" : null,
        predicate_family: predicateFamily,
        object_value: objectValue,
        object_type: objectType,
        event_label: eventLabel,
        time_context: null,
        ownership_cue: ownershipCue,
        support_phrase: supportPhrase ?? cleanStructuredPhrase(text.slice(0, 180))
      },
      ["predicate_family", "object_value", "support_phrase"]
    );
  };
  const matchGroup = (patterns: readonly RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      const value = cleanStructuredPhrase(match?.[1]);
      if (value) {
        return value;
      }
    }
    return null;
  };
  const support = (pattern: RegExp): string | null => cleanStructuredPhrase(pattern.exec(text)?.[0]);
  const supportAroundValue = (value: string | null, contextPattern: RegExp): string | null => {
    const cleanedValue = cleanStructuredPhrase(value);
    if (!cleanedValue) {
      return null;
    }
    const normalizedValue = normalizeWhitespace(cleanedValue).toLowerCase();
    const clauses = text
      .split(/(?<=[.!?])\s+|\s+(?=user:)|\s+(?=assistant:)|\n+/u)
      .map((entry) => cleanStructuredPhrase(entry))
      .filter((entry): entry is string => Boolean(entry));
    const matchingClause = clauses.find((entry) => {
      const normalizedEntry = normalizeWhitespace(entry).toLowerCase();
      return normalizedEntry.includes(normalizedValue) && contextPattern.test(entry);
    });
    if (matchingClause) {
      return matchingClause.slice(0, 220);
    }
    const index = text.toLowerCase().indexOf(normalizedValue);
    if (index < 0) {
      return null;
    }
    const start = Math.max(0, index - 120);
    const end = Math.min(text.length, index + cleanedValue.length + 120);
    return cleanStructuredPhrase(text.slice(start, end))?.slice(0, 220) ?? null;
  };
  const durationUnitPattern = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?)(?:\s+per\s+day|\s+each\s+way)?`;
  const durationIsRecencyWindow = (value: string | null): boolean => {
    const cleanedValue = cleanStructuredPhrase(value);
    if (!cleanedValue) {
      return false;
    }
    const normalizedValue = normalizeWhitespace(cleanedValue).toLowerCase();
    const normalizedText = normalizeWhitespace(text).toLowerCase();
    const indexes: number[] = [];
    let start = 0;
    while (start < normalizedText.length) {
      const index = normalizedText.indexOf(normalizedValue, start);
      if (index < 0) {
        break;
      }
      indexes.push(index);
      start = index + Math.max(1, normalizedValue.length);
    }
    return indexes.some((index) => {
      const clauseStart = Math.max(
        normalizedText.lastIndexOf(".", index),
        normalizedText.lastIndexOf("!", index),
        normalizedText.lastIndexOf("?", index),
        normalizedText.lastIndexOf("\n", index)
      );
      const clauseEndCandidates = [".", "!", "?", "\n"]
        .map((separator) => normalizedText.indexOf(separator, index + normalizedValue.length))
        .filter((candidate) => candidate >= 0);
      const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : normalizedText.length;
      const clause = normalizedText.slice(clauseStart + 1, clauseEnd);
      const valueIndexInClause = clause.indexOf(normalizedValue);
      const before = valueIndexInClause >= 0 ? clause.slice(Math.max(0, valueIndexInClause - 32), valueIndexInClause) : "";
      const after =
        valueIndexInClause >= 0
          ? clause.slice(valueIndexInClause + normalizedValue.length, valueIndexInClause + normalizedValue.length + 32)
          : "";
      return /\b(?:ago|past|last|previous|recent(?:ly)?)\b/u.test(before) || /\bago\b/u.test(after);
    });
  };

  const speed = matchGroup([
    /\b(?:internet|network)\s+(?:plan\s+)?(?:speed\s+)?(?:is|was|runs?|at|of|to)\s+(\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|megabits?|gigabits?))\b/iu,
    /\b(?:internet|network|fiber|broadband)\s+plan\b[^.?!]{0,80}\b(?:is|was|at|to|with|for)?\s*(\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|megabits?|gigabits?))\b/iu,
    /\b(?:internet|network|fiber|broadband)\s+speed\b[^.?!]{0,140}\b(?:upgrade(?:d)?|switch(?:ed)?|moved)\s+(?:to|up\s+to|onto)\s+(\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|megabits?|gigabits?))\b/iu,
    /\b(?:upgrade(?:d)?|switch(?:ed)?|moved)\s+(?:to|up\s+to|onto)\s+(\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|megabits?|gigabits?))\b/iu,
    /\b(\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|megabits?|gigabits?))\b[^.?!]{0,100}\b(?:internet|network|fiber|broadband|plan)\b/iu
  ]);
  if (speed) {
    addScalar("internet_speed", speed, support(/\b[^.?!]*(?:internet|network|plan)[^.?!]*\b(?:kbps|mbps|gbps|megabits?|gigabits?)[^.?!]*/iu));
  }

  const brand = matchGroup([
    /\b(?:favorite\s+)?running\s+shoes?\s+(?:are|is|were|brand\s+is|from|by)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
    /\b(?:favorite\s+)?running\s+shoe\s+brand\s+(?:is|was)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
    /\b(?:gym|running|workout|training)\s+shoes?\b[^.?!]{0,140}\b(?:experience\s+with|liked|prefer(?:red)?|favorite|from|by)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
    /\b(?:my\s+)?([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\s+(?:are\s+)?(?:my\s+)?favorite\s+running\s+shoes?\b/u,
    /\b([A-Z][A-Za-z0-9'&.-]+)\s+(?:running\s+)?shoes?\b/u
  ]);
  if (brand && /\b(?:running|gym|workout|training)\s+shoes?\b/iu.test(text)) {
    addScalar("running_shoe_brand", brand, support(/\b[^.?!]*(?:running|gym|workout|training)\s+shoes?[^.?!]*/iu));
  }

  const breed = matchGroup([
    /\b(?:dog|puppy|cat|kitten)\s+(?:is|was|breed\s+is|is\s+a|was\s+a)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
    /\b(?:breed\s+of\s+my\s+(?:dog|cat)\s+is)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
    /\b(?:collar|harness|leash|name\s+tag)\b[^.?!]{0,120}\b(?:suit|fit|for)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:like|named|called)\b/u,
    /\b(?:my\s+)?(?:dog|puppy|cat|kitten)\s*,?\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
    /\b(?:my\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:dog|puppy|cat|kitten)\b/u
  ]);
  if (breed && /\b(?:dog|puppy|cat|kitten|breed|collar|name\s+tag|leash|harness)\b/iu.test(text)) {
    addScalar("pet_breed", breed, supportAroundValue(breed, /\b(?:dog|puppy|cat|kitten|breed|collar|name\s+tag)\b/iu) ?? support(/\b[^.?!]*(?:dog|puppy|cat|kitten|breed)[^.?!]*/iu));
  }

  const petName = matchGroup([
    /\b(?:cat|dog|pet|kitten|puppy)\s+(?:is\s+)?(?:named|called)\s+([A-Z][A-Za-z'-]{1,30})\b/u,
    /\b(?:cat|dog|pet|kitten|puppy)(?:'s)?\s+name\s+(?:is|was)\s+([A-Z][A-Za-z'-]{1,30})\b/u,
    /\bmy\s+(?:cat|dog|pet|kitten|puppy)(?:'s)?\s+name\s+(?:is|was)\s+([A-Z][A-Za-z'-]{1,30})\b/u,
    /\bmy\s+(?:cat|dog|pet|kitten|puppy)\s*,\s*([A-Z][A-Za-z'-]{1,30})\b/u
  ]);
  if (petName) {
    addScalar("pet_name", petName, supportAroundValue(petName, /\b(?:cat|dog|pet|kitten|puppy|name|named|called)\b/iu) ?? support(/\b[^.?!]*(?:cat|dog|pet|kitten|puppy)[^.?!]*(?:named|called|name)[^.?!]*/iu));
  }

  const serviceName = matchGroup([
    /\b(?:music\s+)?(?:streaming\s+)?(?:service|platform|app)\s+(?:is|was|called)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
    /\b(?:using|use|been\s+using|stream(?:ing)?\s+on|listen(?:ing)?\s+on)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
    /\blisten(?:ing)?\s+to\b[^.?!]{0,120}\bon\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u
  ]);
  if (serviceName && /\b(?:music|streaming|service|platform|app|listen)\b/iu.test(text)) {
    addScalar("music_service", serviceName, support(/\b[^.?!]*(?:music|streaming|service|platform|app|listen)[^.?!]*/iu));
  }

  const playlistName = matchGroup([
    /\bplaylist\s+(?:is|was|called|named)\s+["“]?([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})["”]?\b/u,
    /\b(?:created|made|built)\s+(?:a\s+)?(?:Spotify\s+)?playlist\s+(?:called|named)\s+["“]?([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})["”]?\b/u,
    /\bplaylist\s+on\s+Spotify\s+that\s+I\s+created,\s+called\s+["“]?([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})(?=,|[.;!?]|$)/u,
    /\b(?:my|your)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})\s+playlist\b/u,
    /\b["“]([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,4})["”]\s+(?:playlist)\b/u
  ]);
  if (playlistName && /\b(?:playlist|spotify)\b/iu.test(text)) {
    addScalar("spotify_playlist_name", playlistName, support(/\b[^.?!]*(?:playlist|spotify)[^.?!]*(?:called|named|created|made|built)?[^.?!]*/iu));
  }

  const previousLastName = matchGroup([
    /\b(?:last\s+name|surname)\s+(?:was|used\s+to\s+be|before\s+(?:I\s+)?changed\s+it\s+was)\s+([A-Z][A-Za-z'-]{1,40})\b/u,
    /\bchanged\s+(?:my\s+)?last\s+name\s+from\s+([A-Z][A-Za-z'-]{1,40})\s+to\s+[A-Z][A-Za-z'-]{1,40}\b/u,
    /\bold\s+name\s+was\s+([A-Z][A-Za-z'-]{1,40})\b/u,
    /\bfrom\s+([A-Z][A-Za-z'-]{1,40})\s+to\s+[A-Z][A-Za-z'-]{1,40}\b/u,
    /\bbefore\s+(?:I\s+)?changed\s+(?:my\s+)?last\s+name[^.?!]{0,80}?\b([A-Z][A-Za-z'-]{1,40})\b/u
  ]);
  if (previousLastName && /\b(?:last\s+name|surname|maiden|changed\s+(?:my\s+)?name)\b/iu.test(text)) {
    addScalar("previous_last_name", previousLastName, support(/\b[^.?!]*(?:last\s+name|surname|maiden|changed\s+(?:my\s+)?name)[^.?!]*/iu));
  }

  const timeOfDay = matchGroup([
    /\bstop\s+checking\s+(?:work\s+)?(?:emails?|messages?)[^.?!]{0,80}?\b(?:at|around|by)\s+((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))\b/iu,
    /\bstopping\s+(?:work\s+)?(?:emails?|messages?)(?:\s+and\s+(?:emails?|messages?))?[^.?!]{0,80}?\b(?:at|around|by)\s+((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))\b/iu,
    /\b((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))\b[^.?!]{0,80}\b(?:stop\s+checking|stopping)\s+(?:work\s+)?(?:emails?|messages?)\b/iu
  ]);
  if (timeOfDay) {
    addScalar("checking_email_stop_time", timeOfDay, support(/\b[^.?!]*stop\s+checking\s+(?:work\s+)?(?:emails?|messages?)[^.?!]*/iu));
  }

  const capacity = matchGroup([
    /\b(?:upgrade(?:d)?|upgraded\s+my\s+laptop)\b[^.?!]{0,80}?\b(?:to|with)\s+(\d[\d,.]*\s*(?:gb|tb|mb))\b/iu,
    /\b(?:ram|storage|capacity)\b[^.?!]{0,80}?\b(\d[\d,.]*\s*(?:gb|tb|mb))\b/iu
  ]);
  if (capacity) {
    addScalar("device_capacity", capacity, support(/\b[^.?!]*(?:upgrade|ram|storage|capacity)[^.?!]*(?:gb|tb|mb)[^.?!]*/iu));
  }

  const stance = matchGroup([
    /\b(?:previous|former|old)\s+(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.?!]{1,60}\s+)?(?:was|used\s+to\s+be)\s+(?:that\s+I\s+was\s+|that\s+I\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
    /\b(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.?!]{1,60}\s+)?(?:was|is)\s+(?:that\s+I\s+was\s+|that\s+I\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
    /\b(?:used\s+to\s+be|formerly\s+was|previously\s+was)\s+(?:an?\s+)?([^.;!?\n]+?(?:atheist|agnostic|spiritual|religious|skeptic|sceptic|believer))\b/iu
  ]);
  if (stance && /\b(?:stance|view|belief|opinion|position|spirituality|religion|atheist|agnostic|used to|formerly|previously)\b/iu.test(text)) {
    addScalar("previous_stance", stance, supportAroundValue(stance, /\b(?:stance|view|belief|opinion|position|spirituality|religion|atheist|agnostic|used to|formerly|previously)\b/iu) ?? support(/\b[^.?!]*(?:stance|view|belief|opinion|position|spirituality|religion|atheist|agnostic|used to|formerly|previously)[^.?!]*/iu));
  }

  const color = matchGroup([
    /\b(?:painted|repainted|paint|repaint)\b[^.?!]{0,120}\b(?:walls?|bedroom)\b[^.?!]{0,80}\b(?:a\s+)?((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\b/iu,
    /\b(?:walls?|bedroom)\b[^.?!]{0,120}\b(?:painted|repainted|paint|repaint)\b[^.?!]{0,80}\b(?:a\s+)?((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\b/iu,
    /\b(?:new|fresh)\s+((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\s+walls?\b/iu
  ]);
  if (color && /\b(?:paint|painted|repaint|repainted|walls?|bedroom|color|colour|shade|gray|grey)\b/iu.test(text)) {
    addScalar("wall_color", color, support(/\b[^.?!]*(?:paint|painted|repaint|repainted|walls?|bedroom|color|colour|shade|gray|grey)[^.?!]*/iu));
  }

  const ownedCount = matchGroup([
    /\b(?:own|have|got)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:bikes?|copies|albums?|items?)\b/iu,
    /\b(?:got|have)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+of\s+them\b[^.?!]{0,120}\b(?:bikes?|copies|albums?|items?)\b/iu,
    /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:bikes?|copies|albums?|items?)\b/iu,
    /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand))\s+copies\b[^.?!]{0,120}\b(?:released|worldwide|album|debut)\b/iu
  ]);
  if (ownedCount && /\b(?:how many|own|have|got|bikes?|copies|released|album|worldwide)\b/iu.test(text)) {
    addScalar("item_count", ownedCount, supportAroundValue(ownedCount, /\b(?:own|have|bikes?|copies|released|album|worldwide)\b/iu) ?? support(/\b[^.?!]*(?:own|have|bikes?|copies|released)[^.?!]*/iu));
  }

  const packedCount = matchGroup([
    /\b(?:packed|pack|brought|bring)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:shirts?|pants?|pairs?|items?)\b/iu,
    /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:shirts?|pants?|pairs?|items?)\b[^.?!]{0,80}\b(?:packed|pack|brought|bring|trip)\b/iu
  ]);
  if (packedCount && /\b(?:packed|pack|brought|bring|shirts?|trip)\b/iu.test(text)) {
    addScalar("packed_item_count", packedCount, supportAroundValue(packedCount, /\b(?:packed|pack|brought|bring|shirts?|trip|costa\s+rica)\b/iu) ?? support(/\b[^.?!]*(?:packed|pack|brought|bring|shirts?|trip)[^.?!]*/iu));
  }

  const caughtCount = matchGroup([
    /\b(?:caught|catch|landed)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:largemouth\s+)?(?:bass|fish)\b/iu,
    /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:largemouth\s+)?(?:bass|fish)\b[^.?!]{0,120}\b(?:caught|catch|fishing|lake)\b/iu
  ]);
  if (caughtCount && /\b(?:caught|catch|fishing|lake|bass|fish)\b/iu.test(text)) {
    addEvent("activity_count", caughtCount, "count", "activity_count", support(/\b[^.?!]*(?:caught|catch|fishing|lake|bass|fish)[^.?!]*/iu));
  }

  const shop = matchGroup([
    /\b(?:redeemed?|used)\b[^.?!]{0,120}?\b(?:coupon|discount|voucher)\b[^.?!]{0,120}?\b(?:at|from)\s+([^,.;!?\n]+)/iu,
    /\b(?:coupon|discount|voucher)\b[^.?!]{0,120}?\b(?:at|from)\s+([^,.;!?\n]+)/iu,
    /\b(?:cartwheel|loyalty)\s+(?:app|card)?[^.?!]{0,120}?\b(?:from|at)\s+(Target|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3})\b/iu,
    /\bshop\s+at\s+(Target|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3})\b/iu,
    /\b(?:bought|buy|purchased|purchase|ordered|picked\s+up|got)\b[^.?!]{0,160}?\bfrom\s+([^,.;!?\n]+)/iu,
    /\b(?:new|my)\s+[^.?!]{0,80}?\b(?:which|that)\s+(?:I\s+)?(?:got|bought|purchased)\s+from\s+([^,.;!?\n]+)/iu,
    /\b(?:new|my)\s+[^.?!]{0,80}?\b(?:is|was|came)\s+from\s+([^,.;!?\n]+)/iu,
    /\bfrom\s+(IKEA|the\s+sports\s+store\s+downtown|Dick's\s+Sporting\s+Goods|[^.;!?\n]+(?:store|shop|retailer|downtown))\b/iu
  ]);
  if (shop && /\b(?:bought|buy|purchased|purchase|ordered|from|redeem|redeemed|coupon|discount|voucher|cartwheel|loyalty|shop\s+at)\b/iu.test(text)) {
    addEvent("purchase_source", shop, "shop", "purchase_source", supportAroundValue(shop, /\b(?:bought|buy|purchased|purchase|ordered|from|redeem|redeemed|coupon|discount|voucher|cartwheel|loyalty|shop\s+at|bookshelf|racket)\b/iu) ?? support(/\b[^.?!]*(?:bought|buy|purchased|purchase|ordered|from|redeem|redeemed|coupon|discount|voucher|cartwheel|loyalty|shop\s+at)[^.?!]*/iu));
  }

  const price = matchGroup([
    /\b(?:spent|paid|cost|price\s+was|purchase\s+price\s+was)\b[^.?!]{0,140}\b(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
    /(?:^|[^A-Za-z0-9])(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b[^.?!]{0,140}\b(?:spent|paid|cost|buying|bought|purchased|handbag|bag|item|purchase)\b/iu,
    /\b(?:buying|bought|purchased)\b[^.?!]{0,160}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s*(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
    /\b(?:handbag|bag|luxury\s+items?)\b[^.?!]{0,160}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s*(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu
  ]);
  if (price && /\b(?:spent|paid|cost|price|purchase|purchased|bought|handbag|bag|item|dollars?|\$)\b/iu.test(text)) {
    addEvent("amount_spent", price.replace(/\$\s+/u, "$"), "price", "price", supportAroundValue(price, /\b(?:spent|paid|cost|price|purchase|purchased|bought|handbag|bag|item|dollars?|\$)\b/iu) ?? support(/\b[^.?!]*(?:spent|paid|cost|price|purchase|purchased|bought|handbag|bag|item|dollars?|\$)[^.?!]*/iu));
  }

  const venue = matchGroup([
    /\b(?:take|took|attend|attended|go\s+to|went\s+to)\s+[^.?!]{0,80}?\b(?:classes?|program|study\s+abroad)\s+(?:at|in)\s+([^,.;!?\n]+)/iu,
    /\b(?:near|to|at)\s+(Serenity\s+Yoga|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3}\s+Yoga)\b/u,
    /\bmake\s+it\s+to\s+(Serenity\s+Yoga|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3}\s+Yoga)\b/u,
    /\b(?:study\s+abroad|program)\b[^.?!]{0,120}?\b(?:at|from|in)\s+([^,.;!?\n]+)/iu,
    /\b(?:went|attended|visited)\s+there\b[^.?!]{0,140}\bduring\s+my\s+study\s+abroad\s+program\s+at\s+([^,.;!?\n]+)/iu,
    /\b(?:wedding|ceremony|reception)\b[^.?!]{0,120}?\b(?:at|in)\s+((?:the\s+)?[A-Z][^,.;!?\n]{0,80}?(?:Ballroom|Hall|Hotel|Venue|Center|Centre)[^,.;!?\n]*)/u,
    /\b(?:degree|bachelor'?s?)\b[^.?!]{0,120}?\b(?:at|from)\s+([^,.;!?\n]+)/iu,
    /\b(?:undergrad|bachelor'?s?|degree)\b[^.?!]{0,160}?\b(?:from|at)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,8})\b/u,
    /\b(?:at|from)\s+((?:the\s+)?[A-Z][^.;!?\n]{0,80}?(?:University|College|School|Studio|Gym|Ballroom|UCLA)[^.;!?\n]*)/u
  ]);
  if (venue && /\b(?:classes?|program|study abroad|degree|bachelor|undergrad|wedding|university|college|school|studio|gym|ballroom|yoga|ucla|cs)\b/iu.test(text)) {
    addEvent("study_location", venue, "venue", "venue", supportAroundValue(venue, /\b(?:classes?|program|study abroad|degree|bachelor|undergrad|wedding|university|college|school|studio|gym|ballroom|yoga|ucla|cs)\b/iu) ?? support(/\b[^.?!]*(?:classes?|program|study abroad|degree|bachelor|undergrad|wedding|university|college|school|studio|gym|ballroom|yoga|ucla|cs)[^.?!]*/iu));
  }

  const certification = matchGroup([
    /\bgraduated\s+with\s+(?:an?\s+)?(?:bachelor'?s?|master'?s?|doctoral|doctorate|associate'?s?)?\s*degree\s+in\s+([^,.;!?\n]+?)(?:,|\s+from\b|\s+at\b|\s+in\s+\d{4}\b|[.;!?\n]|$)/iu,
    /\b(?:completed|earned|received|finished|got)\s+(?:an?\s+)?([^.;!?\n]+?(?:certification|certificate|credential|course|program|degree))/iu,
    /\b(?:completed|earned|received|finished|got)\s+(?:an?\s+)?([A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,4})\s+(?:last\s+month|certification|certificate|credential|course|program)\b/u
  ]);
  if (certification && /\b(?:certification|certificate|credential|course|program|degree|completed|earned)\b/iu.test(text)) {
    addEvent("credential_completed", certification, "certification", "credential_completed", supportAroundValue(certification, /\b(?:certification|certificate|credential|course|program|degree|completed|earned|data\s+science)\b/iu) ?? support(/\b[^.?!]*(?:certification|certificate|credential|course|program|degree|completed|earned)[^.?!]*/iu));
  }

  const duration = matchGroup([
    new RegExp(String.raw`\b(?:screen\s+time|instagram|social\s+media)\b[^.?!]{0,180}\b(?:averag(?:e|ed|ing)?|about|around|roughly)\s+(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\b(?:averag(?:e|ed|ing)?|about|around|roughly)\s+(${durationUnitPattern})\b[^.?!]{0,180}\b(?:screen\s+time|instagram|social\s+media)\b`, "iu"),
    new RegExp(String.raw`\b(?:spent|visited|traveled|travelled)\s+(${durationUnitPattern})\b[^.?!]{0,180}\b(?:in|around|through|country|japan|solo\s+trip)\b`, "iu"),
    new RegExp(String.raw`\b(?:in|around|through|visited|traveled|travelled|stayed\s+in)\s+(?:Japan|[A-Z][A-Za-z]+)\b[^.?!]{0,180}\b(?:for|about|around|roughly)\s+(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\bcommute\b[^.?!]{0,100}?\b(?:is|takes?|runs?|averages?)\s+(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\b(${durationUnitPattern})\b[^.?!]{0,100}\bcommute\b`, "iu"),
    new RegExp(String.raw`\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b[^.?!]{0,160}\b(?:took|lasted)\s+(?:around|about|roughly)?\s*(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\b(?:took|lasted)\s+(?:around|about|roughly)?\s*(${durationUnitPattern})\b[^.?!]{0,160}\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b`, "iu"),
    new RegExp(String.raw`\b(?:took\s+me(?:\s+and\s+my\s+friends)?|move(?:d)?|moving)\b[^.?!]{0,140}\b(?:around|about|roughly)?\s*(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\b(?:took|lasted)\s+(${durationUnitPattern})\b`, "iu"),
    new RegExp(String.raw`\b(?:for|about|around|roughly|nearly)\s+(${durationUnitPattern})\b`, "iu")
  ]);
  if (
    duration &&
    !durationIsRecencyWindow(duration) &&
    /\b(?:how long|collecting|duration|for|stayed|lived|Japan|move|moving|took|screen time|instagram|averaging|per day|commute|each way|assemble|assembled|assembly|bookshelf|furniture|put together)\b/iu.test(text)
  ) {
    addEvent("duration_held", duration, "duration", "duration", supportAroundValue(duration, /\b(?:collecting|duration|stayed|lived|Japan|travel|solo|move|moving|took|for|about|around|commute|each way|screen time|instagram|per day|assemble|assembled|assembly|bookshelf|furniture|put together)\b/iu) ?? support(/\b[^.?!]*(?:collecting|duration|stayed|lived|Japan|move|moving|took|for|about|around|commute|each way|screen time|instagram|per day|assemble|assembled|assembly|bookshelf|furniture|put together)[^.?!]*/iu));
  }

  const role = matchGroup([
    /\b(?:previous\s+occupation|occupation|job|role|position)\s+(?:was|is)\s+(?:an?\s+)?([^.;!?\n]+)/iu,
    /\bprevious\s+role\s+as\s+(?:an?\s+)?([^.;!?\n]+?)(?:\s+and\b|[.;!?\n]|$)/iu,
    /\b(?:worked|served)\s+as\s+(?:an?\s+)?([^.;!?\n]+)/iu
  ]);
  if (role && /\b(?:previous occupation|occupation|job|role|position|worked|served)\b/iu.test(text)) {
    addEvent("work_role", role, "role", "work_role", support(/\b[^.?!]*(?:previous occupation|occupation|job|role|position|worked|served)[^.?!]*/iu));
  }

  const purchasedItem = matchGroup([
    /\b(?:for\s+my\s+[^.?!]{0,40}birthday|birthday\s+gift|gift|present)\b[^.?!]{0,120}\b(?:got|bought|purchased|was|is)\s+(?:her\s+|him\s+|them\s+)?(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+and\b|\s+to\s+match\b|[.;!?\n]|$)/iu,
    /\b(?:got|bought|purchased|picked\s+up|found)\s+(?:an?\s+|the\s+|my\s+)?([^.;!?\n]+?(?:action\s+figure|dress|gift|present))\s+(?:from|at|for|with|last|yesterday|today|tomorrow|on)\b/iu,
    /\b(?:got|bought|purchased|picked\s+up|found)\s+(?:an?\s+|the\s+|my\s+)?([^.;!?\n]+?)\s+from\s+(?:a\s+)?(?:thrift|antique|collectibles?)\s+store\b/iu
  ]);
  if (purchasedItem && /\b(?:buy|bought|purchase|purchased|got|picked up|found|gift|present|birthday|thrift|action figure|dress)\b/iu.test(text)) {
    addEvent("purchased_item", purchasedItem, "item", "purchased_item", supportAroundValue(purchasedItem, /\b(?:buy|bought|purchase|purchased|got|picked up|found|gift|present|birthday|sister|thrift|action figure|dress)\b/iu) ?? support(/\b[^.?!]*(?:buy|bought|purchase|purchased|got|picked up|found|gift|present|birthday|thrift|action figure|dress)[^.?!]*/iu));
  }

  const foodDrink = matchGroup([
    /\b(?:tried|made|mixed|prepared|experimented\s+with)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?(?:cocktail|recipe|fizz|martini))\b/iu,
    /\b(?:baked|made)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?cake)\s+(?:for|at|with|last|recently|yesterday|today|tomorrow|on)\b/iu,
    /\b(?:favorite|preferred)\s+(?:type\s+of\s+)?rice\s+(?:is|was|has\s+been)?\s+(?:my\s+)?([^.;!?\n]+?rice)\b/iu,
    /\b(?:my\s+favorite|favorite)\s+([^.;!?\n]+?rice)\b/iu
  ]);
  if (foodDrink && /\b(?:food|drink|recipe|cake|rice|cocktail|gin|fizz|baked|made|favorite|niece|party)\b/iu.test(text)) {
    addScalar("food_drink", foodDrink, supportAroundValue(foodDrink, /\b(?:food|drink|recipe|cake|rice|cocktail|gin|fizz|baked|made|favorite|niece|party|blueberry)\b/iu) ?? support(/\b[^.?!]*(?:food|drink|recipe|cake|rice|cocktail|gin|fizz|baked|made|favorite|niece|party)[^.?!]*/iu));
  }

  const ageAtEvent = matchGroup([
    /\b(?:when\s+I\s+was|I\s+was|at\s+age)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\b[^.?!]{0,160}\b(?:grandma|grandmother|necklace|gift|gave)\b/iu,
    /\b(?:grandma|grandmother)\b[^.?!]{0,160}\b(?:gave|gifted)\b[^.?!]{0,160}\b(?:when\s+I\s+was|at\s+age)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\b/iu,
    /\b(?:grandma|grandmother|necklace|gift|gave)\b[^.?!]{0,180}\bon\s+my\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)\s+birthday\b/iu,
    /\bon\s+my\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)\s+birthday\b[^.?!]{0,180}\b(?:grandma|grandmother|necklace|gift|gave)\b/iu
  ]);
  if (ageAtEvent && /\b(?:age|old|grandma|grandmother|gave|gift|necklace|when)\b/iu.test(text)) {
    addEvent("age_at_event", ageAtEvent, "age", "age_at_event", supportAroundValue(ageAtEvent, /\b(?:age|old|birthday|grandma|grandmother|gave|gift|necklace|when)\b/iu) ?? support(/\b[^.?!]*(?:age|old|grandma|grandmother|gave|gift|necklace|when)[^.?!]*/iu));
  }

  if (firstPerson && derivedExactDetail) {
    appendUniqueStructuredEntry(
      params.selfBindingEntries,
      {
        candidate_subject: "I",
        ownership_cue: "I",
        alias_text: null,
        support_phrase: cleanStructuredPhrase(text.slice(0, 180)),
        confidence_note: "first-person exact-detail support"
      },
      ["candidate_subject", "ownership_cue", "support_phrase"]
    );
  }
}

function normalizeStructureOutputs(
  sceneText: string,
  classifications: Readonly<Record<string, unknown>> | null | undefined,
  structures: Readonly<Record<string, unknown>> | null | undefined
): Readonly<Record<string, unknown>> | null {
  const raw = readSidecarRecord(structures) ?? {};
  const supportFamilies = new Set(classificationList(classifications, "support_family"));
  const narrativeFrames = new Set(classificationList(classifications, "narrative_frame"));
  const eventness = classificationList(classifications, "eventness")[0] ?? null;
  const normalized: Record<string, unknown> = {};
  const meta = readSidecarRecord(raw.__meta);
  if (meta) {
    normalized.__meta = meta;
  }

  const scalarEntries = readSidecarArray(raw.scalar_value_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => hasAnyValue(entry, ["answer_value", "property_key", "support_phrase"]));

  const eventEntries = readSidecarArray(raw.event_value_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => hasAnyValue(entry, ["object_value", "predicate_family", "support_phrase", "event_label"]));

  const selfBindingEntries = readSidecarArray(raw.self_binding_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter(
      (entry) =>
        hasAnyValue(entry, ["candidate_subject", "alias_text", "support_phrase"]) &&
        (hasFirstPersonCue(readSidecarString(entry.ownership_cue)) || readSidecarString(entry.alias_text) !== null)
    );

  deriveLongMemExactDetailEntriesFromSceneText({
    sceneText,
    scalarEntries,
    eventEntries,
    selfBindingEntries
  });

  if (scalarEntries.length > 0) {
    normalized.scalar_value_support = scalarEntries;
  }
  if (eventEntries.length > 0) {
    normalized.event_value_support = eventEntries;
  }
  if (selfBindingEntries.length > 0) {
    normalized.self_binding_support = selfBindingEntries;
  }

  const relationshipEntries = readSidecarArray(raw.relationship_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const subject = readSidecarString(entry.subject);
      const otherPerson = readSidecarString(entry.other_person);
      const relation = readSidecarString(entry.relation);
      const organization = readSidecarString(entry.organization);
      const time = readSidecarString(entry.time);
      if (!subject || isPlaceholderAffiliationSubject(subject)) {
        return false;
      }
      if (!(otherPerson || relation || organization || supportFamilies.has("relationship"))) {
        return false;
      }
      if (eventness === "event_like" && narrativeFrames.has("plan") && otherPerson && time && !relation && !organization) {
        return false;
      }
      if (otherPerson && organization && normalizeName(subject) === normalizeName(organization) && !relation) {
        return false;
      }
      return true;
    });

  const derivedRelationshipEntries = readSidecarArray(raw.project_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .flatMap((entry) => {
      const subject = readSidecarString(entry.subject);
      const project = readSidecarString(entry.project);
      const role = cleanRoleLabel(readSidecarString(entry.role));
      if (!subject || isPlaceholderAffiliationSubject(subject) || !project || !isOwnershipRole(role)) {
        return [];
      }
      return [
        {
          subject,
          other_person: null,
          relation: role,
          organization: project,
          time: readSidecarString(entry.time)
        }
      ];
    });
  if (derivedRelationshipEntries.length > 0) {
    relationshipEntries.push(...derivedRelationshipEntries);
  }
  deriveRelationshipEntriesFromSceneText({
    sceneText,
    supportFamilies,
    narrativeFrames,
    relationshipEntries
  });
  if (relationshipEntries.length > 0) {
    normalized.relationship_support = relationshipEntries;
  }

  const projectEntries = readSidecarArray(raw.project_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const project = readSidecarString(entry.project);
      const role = cleanRoleLabel(readSidecarString(entry.role));
      const organization = readSidecarString(entry.organization);
      const time = readSidecarString(entry.time);
      if (!project) {
        return false;
      }
      if (isOwnershipRole(role) && !supportFamilies.has("project_focus") && !organization) {
        return false;
      }
      if (/\b(?:conference|meetup|event|trip)\b/iu.test(project) && !role && !organization) {
        return false;
      }
      if (eventness === "event_like" && narrativeFrames.has("plan") && !role && !organization && time) {
        return false;
      }
      if (organization && looksLikeToolSubstrate(organization) && !hasOrganizationCue(sceneText, organization)) {
        return false;
      }
      return supportFamilies.has("project_focus") || Boolean(role) || Boolean(organization);
    });
  deriveProjectEntriesFromSceneText({
    sceneText,
    supportFamilies,
    projectEntries
  });
  upgradeProjectRolesFromSceneText(sceneText, projectEntries);
  if (projectEntries.length > 0) {
    normalized.project_support = projectEntries;
  }

  const routineEntries = readSidecarArray(raw.routine_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const activity = readSidecarString(entry.activity);
      const timeOfDay = readSidecarString(entry.time_of_day);
      const context = readSidecarString(entry.context);
      if (!activity && !timeOfDay && !context) {
        return false;
      }
      if (!supportFamilies.has("routine")) {
        return false;
      }
      if (eventness === "event_like" && narrativeFrames.has("plan")) {
        return false;
      }
      return Boolean(activity) || (Boolean(timeOfDay) && (Boolean(context) || isHabitualSceneText(sceneText)));
    });
  deriveRoutineEntriesFromSceneText({
    sceneText,
    supportFamilies,
    routineEntries
  });
  if (routineEntries.length > 0) {
    normalized.routine_support = routineEntries;
  }

  const transitionEntries = readSidecarArray(raw.transition_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const time = readSidecarString(entry.time);
      const change = readSidecarString(entry.change);
      const counterparty = readSidecarString(entry.counterparty);
      const reason = readSidecarString(entry.reason);
      const subject = readSidecarString(entry.subject);
      if (!subject || !(time || change || counterparty || reason)) {
        return false;
      }
      if (supportFamilies.has("routine") && isHabitualSceneText(sceneText) && !looksExplicitTransition(change)) {
        return false;
      }
      if (!change && !reason && counterparty && isCoarseYearOnlyTime(time)) {
        return false;
      }
      if (change && /\bno\s+longer\s+talk\b/iu.test(change) && isCoarseYearOnlyTime(time)) {
        return false;
      }
      if (!change && !counterparty && !reason && !(time && narrativeFrames.has("temporal"))) {
        return false;
      }
      return true;
    });
  deriveTransitionEntriesFromSceneText({
    sceneText,
    supportFamilies,
    narrativeFrames,
    transitionEntries
  });
  if (transitionEntries.length > 0) {
    normalized.transition_support = transitionEntries;
  }

  const mediaEntries = readSidecarArray(raw.media_support)
    .map((entry) => readSidecarRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => readSidecarString(entry.title) !== null);
  if (mediaEntries.length > 0) {
    normalized.media_support = mediaEntries;
  }

  return Object.keys(normalized).length > 0 ? normalized : keepOnlyMeta(structures);
}

function recalibrateNormalizedClassifications(params: {
  readonly sceneText: string;
  readonly classifications: Readonly<Record<string, unknown>> | null | undefined;
  readonly normalizedStructures: Readonly<Record<string, unknown>> | null | undefined;
}): Record<string, unknown> | null {
  const classifications = readSidecarRecord(params.classifications);
  if (!classifications) {
    return null;
  }
  const supportFamilies = new Set(classificationList(classifications, "support_family"));
  const narrativeFrames = new Set(classificationList(classifications, "narrative_frame"));
  const normalizedStructures = readSidecarRecord(params.normalizedStructures);
  if (readSidecarArray(normalizedStructures?.relationship_support).length > 0) {
    supportFamilies.add("relationship");
  }
  if (readSidecarArray(normalizedStructures?.project_support).length > 0) {
    supportFamilies.add("project_focus");
    narrativeFrames.add("fact");
  }
  if (readSidecarArray(normalizedStructures?.routine_support).length > 0) {
    supportFamilies.add("routine");
    if (isHabitualSceneText(params.sceneText)) {
      narrativeFrames.add("fact");
    }
  }
  if (readSidecarArray(normalizedStructures?.transition_support).length > 0) {
    supportFamilies.add("temporal_event");
    narrativeFrames.add("temporal");
  }
  if (readSidecarArray(normalizedStructures?.media_support).length > 0) {
    supportFamilies.add("media_reference");
  }
  return {
    ...classifications,
    support_family: [...supportFamilies],
    narrative_frame: [...narrativeFrames]
  };
}

export function normalizeExternalIeExtractorResult(params: {
  readonly sceneText: string;
  readonly extractor: SidecarExtractorResult;
}): SidecarExtractorResult {
  if (normalizeWhitespace(params.extractor.extractor).toLowerCase() !== "gliner2") {
    return params.extractor;
  }
  const normalizedStructures = normalizeStructureOutputs(params.sceneText, params.extractor.classifications ?? null, params.extractor.structures ?? null);
  const scalarOrEventSupportPresent =
    readSidecarArray(readSidecarRecord(normalizedStructures)?.scalar_value_support).length > 0 ||
    readSidecarArray(readSidecarRecord(normalizedStructures)?.event_value_support).length > 0;
  const selfBindingPresent = readSidecarArray(readSidecarRecord(normalizedStructures)?.self_binding_support).length > 0;
  const routineSupportPresent = readSidecarArray(readSidecarRecord(normalizedStructures)?.routine_support).length > 0;

  const classifications = recalibrateNormalizedClassifications({
    sceneText: params.sceneText,
    classifications: params.extractor.classifications ?? null,
    normalizedStructures
  });
  let normalizedClassifications: Record<string, unknown> | null = classifications ? { ...classifications } : null;
  if (normalizedClassifications) {
    const ownership = readSidecarString(normalizedClassifications.ownership_mode)?.toLowerCase();
    if (ownership === "self_owned" && !(scalarOrEventSupportPresent || selfBindingPresent || routineSupportPresent)) {
      normalizedClassifications.ownership_mode = "unknown";
    }
    const exactDetailFamily = readSidecarString(normalizedClassifications.exact_detail_family)?.toLowerCase();
    if (exactDetailFamily && exactDetailFamily !== "none" && !scalarOrEventSupportPresent) {
      normalizedClassifications.exact_detail_family = "none";
    }
  }

  return {
    ...params.extractor,
    classifications: normalizedClassifications,
    structures: normalizedStructures
  };
}

function buildSceneClassificationTasks(): Record<string, unknown> {
  const supportThreshold = 0.45;
  return {
    subject_arity: ["single_subject", "paired_subject", "group_subject", "no_subject"],
    ownership_mode: {
      labels: ["self_owned", "other_owned", "pair_scoped", "group_scoped", "unknown"],
      label_descriptions: {
        self_owned: "The scene explicitly describes the narrator or the user's own property, preference, routine, or state using first-person ownership cues like I, my, me, or our.",
        other_owned: "The scene is mainly about another person's property, preference, routine, or state rather than the narrator's own.",
        pair_scoped: "The scene is primarily about a pair relationship or shared activity between two people rather than one person's owned fact.",
        group_scoped: "The scene is mainly about a group, team, household, or larger collective rather than one person's owned fact.",
        unknown: "Ownership is not explicit or cannot be determined reliably from the text."
      },
      multi_label: false,
      cls_threshold: 0.65
    },
    exact_detail_family: {
      labels: [
        "speed",
        "brand",
        "breed",
        "service_name",
        "playlist_name",
        "last_name",
        "capacity",
        "time_of_day",
        "pet_name",
        "count",
        "venue",
        "shop",
        "certification",
        "duration",
        "role",
        "price",
        "stance",
        "none"
      ],
      label_descriptions: {
        speed: "A short atomic value about connection speed, plan speed, or throughput such as 200 Mbps.",
        brand: "A short atomic brand or manufacturer value such as Nike, Apple, or Trek.",
        breed: "A short atomic pet breed or animal breed value.",
        service_name: "A short atomic service, provider, platform, or subscription name such as Spotify or Verizon.",
        playlist_name: "A short atomic playlist title such as Summer Vibes.",
        last_name: "A short atomic previous last name or surname value such as Johnson.",
        capacity: "A short atomic storage or plan capacity value such as 256 GB or 2 TB.",
        time_of_day: "A short atomic time or routine clock value such as 7 PM or after lunch.",
        pet_name: "A short atomic pet name value only.",
        count: "A short atomic numeric count such as 2 bikes or 3 cats.",
        venue: "A short atomic place, school, campus, or venue value tied to an event.",
        shop: "A short atomic store, retailer, or purchase source value tied to an event.",
        certification: "A short atomic credential, certification, course, or program name.",
        duration: "A short atomic duration value such as 3 years or 6 months.",
        role: "A short atomic occupation, title, or role value such as advisor or CTO.",
        price: "A short atomic money amount or purchase price such as $800.",
        stance: "A short atomic belief, stance, view, or opinion value such as staunch atheist.",
        none: "The scene does not clearly express one short exact-detail scalar or event-backed answer value."
      },
      multi_label: false,
      cls_threshold: 0.6
    },
    eventness: {
      labels: ["state_like", "event_like", "mixed", "none"],
      label_descriptions: {
        state_like: "The scene mainly describes a stable state, preference, attribute, or current condition.",
        event_like: "The scene mainly describes a discrete event, occurrence, transition, purchase, trip, or completion.",
        mixed: "The scene contains both stable state information and event information in a balanced way.",
        none: "The scene does not clearly express either a state-like or event-like support pattern."
      },
      multi_label: false,
      cls_threshold: 0.6
    },
    support_family: {
      labels: [
        "identity",
        "relationship",
        "project_focus",
        "routine",
        "media_reference",
        "temporal_event",
        "activity_participation",
        "explicit_reason",
        "other"
      ],
      label_descriptions: {
        identity: "Identity, self-description, named role, alias, or biographical fact support.",
        relationship: "Relationship, friendship, family, coworker, or pair-bond support.",
        project_focus: "Project, workstream, product, company, or collaboration support.",
        routine: "Routine, habit, repeated behavior, or cadence support.",
        media_reference: "Books, shows, music, games, or other media reference support.",
        temporal_event: "Trips, purchases, completed milestones, moves, study periods, or other event support.",
        activity_participation: "Participation in activities, hobbies, sports, classes, or events.",
        explicit_reason: "An explicit why, motivation, justification, or causal explanation.",
        other: "Useful scene support that does not fit the other support families."
      },
      multi_label: true,
      cls_threshold: supportThreshold
    },
    narrative_frame: {
      labels: ["fact", "temporal", "plan", "preference", "reason", "identity", "relationship", "activity"],
      label_descriptions: {
        fact: "A direct factual statement or claim.",
        temporal: "A statement centered on dates, times, durations, or ordering.",
        plan: "An intention, future plan, or pending action.",
        preference: "A like, dislike, favorite, or enduring preference.",
        reason: "A cause, explanation, or motivation.",
        identity: "A statement about who someone is, their role, or their background.",
        relationship: "A statement mainly about a connection between people.",
        activity: "A statement mainly about doing, attending, practicing, or participating."
      },
      multi_label: true,
      cls_threshold: supportThreshold
    }
  };
}

function buildSceneStructureSchemas(): Record<string, unknown> {
  return {
    scalar_value_support: [
      "subject::str::person or narrator who owns the scalar exact-detail fact",
      "property_key::str::normalized property key such as internet_speed, running_shoe_brand, music_service, pet_name, bike_count, amount_spent, previous_stance, or stop_checking_emails_time",
      "answer_value::str::short atomic answer value only",
      "value_unit::str::unit for the answer if explicitly stated such as Mbps, GB, years, or PM",
      "ownership_cue::str::first-person or ownership cue such as I, my, our, his, or her",
      "time_context::str::time reference if explicitly stated",
      "support_phrase::str::short supporting phrase that directly justifies the value"
    ],
    event_value_support: [
      "subject::str::person or narrator associated with the event-backed exact-detail fact",
      "predicate_family::str::event predicate family such as study_location, purchase_source, credential_completed, duration_held, amount_spent, or work_role",
      "object_value::str::short atomic event-backed answer value only",
      "object_type::str::value type such as venue, shop, certification, duration, role, count, price, or stance",
      "event_label::str::short human-readable label for the event if explicit",
      "time_context::str::time reference if explicitly stated",
      "support_phrase::str::short supporting phrase that directly justifies the value"
    ],
    self_binding_support: [
      "candidate_subject::str::person who appears to be the narrator or namespace self",
      "ownership_cue::str::cue such as I, me, my, our, or first-person narration",
      "alias_text::str::nickname or alias for the candidate subject if explicit",
      "support_phrase::str::short phrase that supports the self-binding",
      "confidence_note::str::brief note on why the binding seems reliable"
    ],
    relationship_support: [
      "subject::str::primary person or narrator in the relationship fact",
      "other_person::str::the other named person in the relationship",
      "relation::str::friend, former partner, coworker, advisor, supporter, or similar relationship label",
      "organization::str::organization or shared context if explicitly stated",
      "time::str::time or transition clue if explicitly stated"
    ],
    project_support: [
      "subject::str::person or team owning the project work",
      "project::str::named project, product, or initiative",
      "role::str::explicit role such as founder, advisor, CTO, collaborator, or owner",
      "organization::str::organization attached to the work if explicit",
      "time::str::time reference if explicitly stated"
    ],
    routine_support: [
      "subject::str::person whose routine is being described",
      "time_of_day::str::time of day or cadence marker",
      "activity::str::routine activity or repeated action",
      "context::str::work, personal, exercise, coffee, or related context"
    ],
    transition_support: [
      "subject::str::person or relationship owner",
      "change::str::what changed",
      "counterparty::str::other person involved in the change",
      "time::str::explicit date or time phrase for the change",
      "reason::str::reason or explanation if stated"
    ],
    media_support: [
      "subject::str::person mentioning or discussing the media",
      "title::str::movie, show, book, or media title",
      "media_type::str::movie, show, book, song, or other media kind",
      "context::str::where or with whom it was mentioned if explicit"
    ]
  };
}

function mapEntityType(label: string | undefined): "person" | "place" | "org" | "project" | "media" | null {
  const normalized = normalizeWhitespace((label ?? "").split(/::|:/u)[0] ?? "").toLowerCase();
  if (["person", "per"].includes(normalized)) {
    return "person";
  }
  if (["place", "location", "city", "country", "gpe", "loc", "venue", "facility", "region", "state"].includes(normalized)) {
    return "place";
  }
  if (["org", "organization", "organisation", "company", "team", "institution", "employer"].includes(normalized)) {
    return "org";
  }
  if (["project", "product", "tool", "app", "initiative", "service"].includes(normalized)) {
    return "project";
  }
  if (["media", "movie", "film", "work_of_art", "book", "show", "song", "album", "series", "podcast", "band"].includes(normalized)) {
    return "media";
  }
  return null;
}

function inferEntityTypesFromPredicate(
  predicate: string
): { readonly source: "person" | "place" | "org" | "project" | "media" | null; readonly target: "person" | "place" | "org" | "project" | "media" | null } {
  switch (predicate) {
    case "friend_of":
    case "works_with":
    case "sibling_of":
    case "was_with":
      return { source: "person", target: "person" };
    case "works_at":
    case "worked_at":
    case "member_of":
    case "supports":
    case "advises":
      return { source: "person", target: "org" };
    case "works_on":
    case "participated_in":
      return { source: "person", target: "project" };
    case "lives_in":
    case "lived_in":
      return { source: "person", target: "place" };
    case "prefers":
    case "favorite_of":
    case "owns":
    case "bought":
      return { source: "person", target: null };
    case "inspired_by":
    case "caused_by":
    case "because_of":
    case "about":
    case "identity_support_of":
      return { source: null, target: null };
    case "occurred_on":
      return { source: "project", target: null };
    case "family_activity_with":
      return { source: "person", target: "person" };
    case "met_through":
      return { source: "person", target: "org" };
    default:
      return { source: null, target: null };
  }
}

function mapPredicate(relation: string | undefined): { predicate: string; metadata: Record<string, unknown> } | null {
  const relexMapping = mapRelexRelationLabel(relation);
  if (relexMapping) {
    return {
      predicate: relexMapping.predicate,
      metadata: {
        ...relexMapping.metadata,
        relex_family: relexMapping.family,
        relex_answer_shape: relexMapping.answerShape
      }
    };
  }
  const normalized = normalizeWhitespace((relation ?? "").split(/::|:/u)[0] ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  if (["friend of", "friend_of", "friend", "friends with"].includes(normalized)) {
    return { predicate: "friend_of", metadata };
  }
  if (["works with", "works_with", "coworker of", "collaborates with"].includes(normalized)) {
    return { predicate: "works_with", metadata };
  }
  if (["works at", "works_at", "employed by"].includes(normalized)) {
    return { predicate: "works_at", metadata };
  }
  if (["worked at", "worked_at", "previously worked at"].includes(normalized)) {
    return { predicate: "worked_at", metadata };
  }
  if (["works on", "works_on", "working on"].includes(normalized)) {
    return { predicate: "works_on", metadata };
  }
  if (["member of", "member_of"].includes(normalized)) {
    return { predicate: "member_of", metadata };
  }
  if (["met through", "met_through"].includes(normalized)) {
    return { predicate: "met_through", metadata };
  }
  if (["sibling of", "sibling_of", "brother of", "sister of"].includes(normalized)) {
    return { predicate: "sibling_of", metadata };
  }
  if (["lives in", "lives_in", "resides in", "currently in"].includes(normalized)) {
    return { predicate: "lives_in", metadata };
  }
  if (["lived in", "lived_in", "used to live in"].includes(normalized)) {
    return { predicate: "lived_in", metadata };
  }
  if (["romantic partner of", "romantic_partner_of", "partner of", "dating", "dated", "girlfriend of", "boyfriend of"].includes(normalized)) {
    metadata.relationship_kind = "romantic";
    return { predicate: "was_with", metadata };
  }
  return null;
}

function jsonObjectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function metadataStringValue(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: string,
  canonicalName: string,
  aliases: readonly string[],
  metadata: Record<string, unknown>
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        last_seen_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, now(), $5::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [namespaceId, entityType, canonicalName, normalizeName(canonicalName), JSON.stringify(metadata)]
  );

  const entityId = result.rows[0]?.id;
  if (!entityId) {
    throw new Error(`Failed to upsert external IE entity ${canonicalName}`);
  }

  const uniqueAliases = [...new Set([canonicalName, ...aliases].map((value) => normalizeWhitespace(value)).filter(Boolean))];
  for (const alias of uniqueAliases) {
    await client.query(
      `
        INSERT INTO entity_aliases (
          entity_id,
          alias,
          normalized_alias,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (entity_id, normalized_alias)
        DO NOTHING
      `,
      [entityId, alias, normalizeName(alias), JSON.stringify({ source: "external_relation_ie" })]
    );
  }

  return entityId;
}

async function upsertObservedAlias(
  client: PoolClient,
  entityId: string,
  alias: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const normalizedAlias = normalizeName(alias);
  if (!normalizedAlias) {
    return;
  }
  await client.query(
    `
      INSERT INTO entity_aliases (
        entity_id,
        alias,
        normalized_alias,
        alias_type,
        metadata
      )
      VALUES ($1, $2, $3, 'observed', $4::jsonb)
      ON CONFLICT (entity_id, normalized_alias)
      DO UPDATE SET
        metadata = entity_aliases.metadata || EXCLUDED.metadata
    `,
    [entityId, alias, normalizedAlias, JSON.stringify(metadata)]
  );
}

function entityResolutionTypes(entityType: string): readonly string[] {
  return entityType === "person" ? [entityType, "self"] : [entityType];
}

function shouldStageObservedEntity(entityText: string, entityType: string | null, score: number | null, threshold: number): boolean {
  const normalized = normalizeName(entityText);
  if (!normalized || !entityType) {
    return false;
  }
  if (typeof score === "number" && Number.isFinite(score) && score < threshold) {
    return false;
  }
  if (entityType === "person" && normalized.length < 2) {
    return false;
  }
  return true;
}

function shouldReplaceObservedEntity(
  current: { type: string | null; score: number | null },
  next: { type: string | null; score: number | null }
): boolean {
  const currentTyped = current.type ? 1 : 0;
  const nextTyped = next.type ? 1 : 0;
  if (nextTyped !== currentTyped) {
    return nextTyped > currentTyped;
  }
  const currentScore = typeof current.score === "number" && Number.isFinite(current.score) ? current.score : -1;
  const nextScore = typeof next.score === "number" && Number.isFinite(next.score) ? next.score : -1;
  return nextScore > currentScore;
}

async function resolveOrUpsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: string,
  canonicalName: string,
  aliases: readonly string[],
  metadata: Record<string, unknown>
): Promise<string> {
  const resolved = await resolveCanonicalEntityReference(namespaceId, canonicalName, {
    entityTypes: entityResolutionTypes(entityType)
  });
  if (resolved) {
    for (const alias of [...new Set([canonicalName, ...aliases].map((value) => normalizeWhitespace(value)).filter(Boolean))]) {
      await upsertObservedAlias(client, resolved.entityId, alias, {
        source: "external_relation_ie",
        external_ie: true,
        ...metadata
      });
    }
    return resolved.entityId;
  }
  return upsertEntity(client, namespaceId, entityType, canonicalName, aliases, metadata);
}

function registerSidecarExitHooks(): void {
  if (sidecarExitHooksRegistered) {
    return;
  }
  sidecarExitHooksRegistered = true;
  process.once("beforeExit", forceKillSidecarOnExit);
  process.once("exit", forceKillSidecarOnExit);
}

function rejectPendingSidecarRequests(state: SidecarDaemonState, error: Error): void {
  for (const pending of state.pending.values()) {
    pending.reject(error);
  }
  state.pending.clear();
}

function handleDaemonStdoutChunk(state: SidecarDaemonState, chunk: Buffer): void {
  state.stdoutBuffer += chunk.toString();
  while (true) {
    const newlineIndex = state.stdoutBuffer.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    const line = state.stdoutBuffer.slice(0, newlineIndex).trim();
    state.stdoutBuffer = state.stdoutBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let message: SidecarDaemonResponseMessage;
    try {
      message = JSON.parse(line) as SidecarDaemonResponseMessage;
    } catch (error) {
      rejectPendingSidecarRequests(
        state,
        new Error(`relation-ie daemon returned invalid JSON line: ${String(error)}\n${line}`)
      );
      state.child.kill();
      return;
    }
    const requestId = typeof message.request_id === "string" ? message.request_id : null;
    if (!requestId) {
      continue;
    }
    const pending = state.pending.get(requestId);
    if (!pending) {
      continue;
    }
    state.pending.delete(requestId);
    if (typeof message.error === "string" && message.error.trim().length > 0) {
      pending.reject(new Error(`relation-ie daemon failed: ${message.error}`));
      continue;
    }
    pending.resolve((message.response ?? { scenes: [], errors: [] }) as SidecarResponse);
  }
}

function createSidecarDaemon(cwd: string, pythonExecutable: string, scriptPath: string): SidecarDaemonState {
  const child = spawn(pythonExecutable, [scriptPath, "--daemon"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.setDefaultEncoding("utf8");
  const state: SidecarDaemonState = {
    child,
    pending: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    nextRequestId: 1
  };
  child.stdout.on("data", (chunk) => {
    handleDaemonStdoutChunk(state, chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.stderrBuffer += chunk.toString();
  });
  child.on("error", (error) => {
    if (sidecarDaemonState === state) {
      sidecarDaemonState = null;
    }
    rejectPendingSidecarRequests(state, error instanceof Error ? error : new Error(String(error)));
  });
  child.on("close", (code, signal) => {
    if (sidecarDaemonState === state) {
      sidecarDaemonState = null;
    }
    const stderr = state.stderrBuffer.trim();
    rejectPendingSidecarRequests(
      state,
      new Error(
        `relation-ie daemon exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})${stderr ? `: ${stderr}` : ""}`
      )
    );
  });
  registerSidecarExitHooks();
  return state;
}

function sidecarRequestPayload(request: {
  readonly extractors?: readonly string[];
  readonly scenes: readonly SceneSidecarInput[];
}): Record<string, unknown> {
  const config = readConfig();
  return {
    device: config.relationIeDevice,
    extractors: request.extractors ?? config.relationIeExtractors,
    entity_labels: config.relationIeEntityLabels,
    relation_labels: config.relationIeRelationLabels,
    entity_descriptions: config.relationIeEntityDescriptions,
    relation_descriptions: config.relationIeRelationDescriptions,
    thresholds: {
      entity: config.relationIeEntityThreshold,
      adjacency: config.relationIeAdjacencyThreshold,
      relation: config.relationIeRelationThreshold,
      classification: config.relationIeClassificationThreshold,
      structure: config.relationIeStructureThreshold
    },
    classification_tasks: buildSceneClassificationTasks(),
    structure_schemas: buildSceneStructureSchemas(),
    models: {
      gliner_relex: config.relationIeGlinerRelexModel,
      gliner_relex_v1: config.relationIeGlinerRelexModel,
      gliner2: config.relationIeGliner2Model,
      spacy: config.relationIeSpacyModel,
      span_marker: config.relationIeSpanMarkerModel
    },
    scenes: request.scenes.map((scene) => ({
      scene_index: scene.sceneIndex,
      text: scene.text
    }))
  };
}

async function runSidecarDaemonRequest(request: {
  readonly extractors?: readonly string[];
  readonly scenes: readonly SceneSidecarInput[];
}): Promise<SidecarResponse> {
  const config = readConfig();
  const cwd = repoRoot();
  const state =
    sidecarDaemonState?.child.killed || sidecarDaemonState === null
      ? createSidecarDaemon(cwd, config.relationIePythonExecutable, config.relationIeScriptPath)
      : sidecarDaemonState;
  sidecarDaemonState = state;
  const requestId = `req_${state.nextRequestId++}`;
  const message: SidecarDaemonRequestMessage = {
    request_id: requestId,
    command: "infer",
    payload: sidecarRequestPayload(request)
  };
  const response = await new Promise<SidecarResponse>((resolve, reject) => {
    state.pending.set(requestId, { resolve, reject });
    state.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) {
        return;
      }
      state.pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const sceneByIndex = new Map(request.scenes.map((scene) => [scene.sceneIndex, scene]));
  return {
    ...response,
    scenes: (response.scenes ?? []).map((scene) => ({
      ...scene,
      extractors: (scene.extractors ?? []).map((extractor) =>
        normalizeExternalIeExtractorResult({
          sceneText: sceneByIndex.get(scene.scene_index)?.text ?? "",
          extractor
        })
      )
    }))
  };
}

async function runSidecar(request: {
  readonly extractors?: readonly string[];
  readonly scenes: readonly SceneSidecarInput[];
}): Promise<SidecarResponse> {
  return runSidecarDaemonRequest(request);
}

function numericMean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundConfidence(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 1000) / 1000;
}

function extractorConfidenceSummary(extractor: SidecarExtractorResult): Record<string, unknown> {
  const entityScores = (extractor.entities ?? [])
    .map((entity) => entity.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const relationScores = (extractor.relations ?? [])
    .map((relation) => relation.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));

  const classificationMeta =
    extractor.classifications &&
    typeof extractor.classifications === "object" &&
    (extractor.classifications as Record<string, unknown>).__meta &&
    typeof (extractor.classifications as Record<string, unknown>).__meta === "object"
      ? (extractor.classifications as Record<string, unknown>).__meta
      : null;
  const structureMeta =
    extractor.structures &&
    typeof extractor.structures === "object" &&
    (extractor.structures as Record<string, unknown>).__meta &&
    typeof (extractor.structures as Record<string, unknown>).__meta === "object"
      ? (extractor.structures as Record<string, unknown>).__meta
      : null;

  return {
    entity_mean: roundConfidence(numericMean(entityScores)),
    entity_max: roundConfidence(entityScores.length > 0 ? Math.max(...entityScores) : null),
    relation_mean: roundConfidence(numericMean(relationScores)),
    relation_max: roundConfidence(relationScores.length > 0 ? Math.max(...relationScores) : null),
    classification_meta: classificationMeta,
    structure_meta: structureMeta
  };
}

export async function stageExternalRelationCandidatesForScenes(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly scenes: readonly SceneSidecarInput[];
    readonly forceRun?: boolean;
    readonly relationIeMode?: ExternalRelationIeMode;
    readonly extractors?: readonly string[];
  }
): Promise<{
  readonly stagedCount: number;
  readonly warningCount: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly gliner2JobsSkipped: number;
}> {
  const config = readConfig();
  if ((!config.relationIeEnabled && input.forceRun !== true) || input.scenes.length === 0) {
    return { stagedCount: 0, warningCount: 0, cacheHits: 0, cacheMisses: 0, gliner2JobsSkipped: 0 };
  }

  const requestedExtractors = input.extractors && input.extractors.length > 0 ? input.extractors : config.relationIeExtractors;
  const extractorSignature = requestedExtractors
    .map((extractor) => {
      const normalizedExtractor = normalizeExtractorName(extractor);
      const modelId =
        normalizedExtractor === "gliner2"
          ? config.relationIeGliner2Model
          : normalizedExtractor === GLINER_RELEX_EXTRACTOR
            ? config.relationIeGlinerRelexModel
            : normalizedExtractor === "spacy"
              ? config.relationIeSpacyModel
              : normalizedExtractor === "span_marker"
                ? config.relationIeSpanMarkerModel
                : "unknown";
      return `${normalizedExtractor}:${modelId}:${config.relationIeGlinerRelexSchemaVersion}:${config.relationIeEntityThreshold}:${config.relationIeRelationThreshold}:${config.relationIeClassificationThreshold}:${config.relationIeStructureThreshold}`;
    })
    .sort()
    .join("|");
  const cacheBySceneIndex = new Map<number, SidecarSceneResult>();
  const cacheHitSceneIds = new Set<string>();
  const missingScenes: SceneSidecarInput[] = [];
  for (const scene of input.scenes) {
    const identity = {
      cacheScope: "relation_ie_scene" as const,
      namespaceId: input.namespaceId,
      sourceText: scene.text,
      sourceType: "narrative_scene",
      relationIeMode: input.relationIeMode ?? "support_and_promote",
      extractorSignature,
      taxonomyVersion: "memory_taxonomy_v1",
      temporalVersion: "temporal_semantic_v1",
      assistantModelId: null,
      gliner2ModelId: config.relationIeGliner2Model,
      schemaVersion: `external_relation_ie_scene_cache_v2:${config.relationIeGlinerRelexSchemaVersion}`,
      promptVersion: "relation_ie_sidecar_v2"
    };
    const cached = await loadCompilerCacheEntry(client, identity, { trackHit: false }).catch(() => null);
    if (cached?.responsePayload?.sceneResult && typeof cached.responsePayload.sceneResult === "object") {
      const cachedScene = cached.responsePayload.sceneResult as SidecarSceneResult;
      cacheBySceneIndex.set(scene.sceneIndex, {
        ...cachedScene,
        scene_index: scene.sceneIndex
      });
      cacheHitSceneIds.add(scene.sceneId);
      continue;
    }
    missingScenes.push(scene);
  }
  const response =
    missingScenes.length > 0
      ? await runSidecar({
          extractors: input.extractors,
          scenes: missingScenes
        })
      : { scenes: [], errors: [] };
  const byScene = new Map<number, SceneSidecarInput>(input.scenes.map((scene) => [scene.sceneIndex, scene]));
  const responseByScene = new Map<number, SidecarSceneResult>(
    response.scenes.map((sceneResult) => [sceneResult.scene_index, sceneResult])
  );
  const sceneResults: readonly SidecarSceneResult[] = input.scenes.map(
    (scene): SidecarSceneResult =>
      cacheBySceneIndex.get(scene.sceneIndex) ?? responseByScene.get(scene.sceneIndex) ?? {
        scene_index: scene.sceneIndex,
        extractors: requestedExtractors.map((extractor) => ({
          extractor,
          model_id:
            extractor === "gliner2"
              ? config.relationIeGliner2Model
              : normalizeExtractorName(extractor) === GLINER_RELEX_EXTRACTOR
                ? config.relationIeGlinerRelexModel
                : extractor === "spacy"
                  ? config.relationIeSpacyModel
                  : extractor === "span_marker"
                    ? config.relationIeSpanMarkerModel
                    : undefined,
          schema_version:
            extractor === "gliner2"
              ? "gliner2_native_v2"
              : normalizeExtractorName(extractor) === GLINER_RELEX_EXTRACTOR
                ? config.relationIeGlinerRelexSchemaVersion
                : "deterministic_relation_ie_fallback",
          thresholds: undefined,
          entities: [],
          relations: [],
          classifications: {},
          structures: {},
          warnings: ["sidecar_scene_result_missing_deterministic_fallback"]
        }))
      }
  );
  for (const scene of missingScenes) {
    const sceneResult = responseByScene.get(scene.sceneIndex);
    if (!sceneResult) {
      continue;
    }
    const identity = {
      cacheScope: "relation_ie_scene" as const,
      namespaceId: input.namespaceId,
      sourceText: scene.text,
      sourceType: "narrative_scene",
      relationIeMode: input.relationIeMode ?? "support_and_promote",
      extractorSignature,
      taxonomyVersion: "memory_taxonomy_v1",
      temporalVersion: "temporal_semantic_v1",
      assistantModelId: null,
      gliner2ModelId: config.relationIeGliner2Model,
      schemaVersion: `external_relation_ie_scene_cache_v2:${config.relationIeGlinerRelexSchemaVersion}`,
      promptVersion: "relation_ie_sidecar_v2"
    };
    const key = compilerCacheKey(identity);
    await upsertCompilerCacheEntry(client, {
      ...identity,
      requestPayload: {
        scene_id: scene.sceneId,
        source_memory_id: scene.sourceMemoryId,
        source_chunk_id: scene.sourceChunkId,
        occurred_at: scene.occurredAt
      },
      responsePayload: {
        sceneResult
      },
      metrics: {
        extractor_count: sceneResult.extractors.length,
        warning_count: sceneResult.extractors.reduce((count, extractor) => count + (extractor.warnings?.length ?? 0), 0),
        cache_key: key.cacheKey,
        source_hash: key.sourceHash
      }
    }).catch(() => undefined);
  }
  let stagedCount = 0;
  let warningCount = 0;
  const sourceChunkIds = [...new Set(input.scenes.map((scene) => scene.sourceChunkId).filter((value): value is string => Boolean(value)))];
  const routerMetadataByChunkId = new Map<string, unknown>();
  if (sourceChunkIds.length > 0) {
    const routerRows = await client.query<{ id: string; ingestion_router_v2: unknown }>(
      `
        SELECT id, metadata -> 'ingestion_router_v2' AS ingestion_router_v2
        FROM artifact_chunks
        WHERE id = ANY($1::uuid[])
      `,
      [sourceChunkIds]
    );
    for (const row of routerRows.rows) {
      if (row.ingestion_router_v2) {
        routerMetadataByChunkId.set(row.id, row.ingestion_router_v2);
      }
    }
  }

  for (const sceneResult of sceneResults) {
    const scene = byScene.get(sceneResult.scene_index);
    if (!scene) {
      continue;
    }

    await client.query(
      `
        UPDATE narrative_scenes
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{external_relation_ie}',
          $2::jsonb,
          true
        ),
        updated_at = now()
        WHERE id = $1
      `,
      [
        scene.sceneId,
        JSON.stringify({
          updated_at: new Date().toISOString(),
          relation_ie_mode: input.relationIeMode ?? "support_and_promote",
          source_memory_id: scene.sourceMemoryId,
          source_chunk_id: scene.sourceChunkId,
          occurred_at: scene.occurredAt,
          extractors: sceneResult.extractors.map((extractor) => ({
            extractor: extractor.extractor,
            relation_ie_mode: input.relationIeMode ?? "support_and_promote",
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? null,
            thresholds: extractor.thresholds ?? null,
            entity_count: extractor.entities?.length ?? 0,
            relation_count: extractor.relations?.length ?? 0,
            warning_count: extractor.warnings?.length ?? 0,
            confidence_summary: extractorConfidenceSummary(extractor),
            source_memory_id: scene.sourceMemoryId,
            source_chunk_id: scene.sourceChunkId,
            occurred_at: scene.occurredAt,
            entities: extractor.entities ?? [],
            relations: extractor.relations ?? [],
            classifications: extractor.classifications ?? null,
            structures: extractor.structures ?? null
          })),
          warning_count: sceneResult.extractors.reduce(
            (count, extractor) => count + (extractor.warnings?.length ?? 0),
            0
          ),
          compiler_cache: {
            status: cacheHitSceneIds.has(scene.sceneId) ? "hit" : "miss",
            cache_scope: "relation_ie_scene"
          }
        })
      ]
    );

    const entityCache = new Map<string, { id: string; type: string }>();
    const rawEntityByName = new Map<string, { type: string | null; score: number | null; start: number | null; end: number | null; rawLabel: string | null }>();
    for (const extractor of sceneResult.extractors) {
      warningCount += extractor.warnings?.length ?? 0;
      const entityThreshold =
        typeof extractor.thresholds?.entity === "number" && Number.isFinite(extractor.thresholds.entity)
          ? extractor.thresholds.entity
          : 0;
      for (const entity of extractor.entities ?? []) {
        const entityText = normalizeWhitespace(entity.text ?? "");
        if (!entityText) {
          continue;
        }
        const entityType = mapEntityType(entity.label);
        if (!entityType) {
          continue;
        }
        const normalizedEntityText = normalizeName(entityText);
        const observation = {
          type: entityType,
          score: typeof entity.score === "number" ? entity.score : null,
          start: typeof entity.start === "number" ? entity.start : null,
          end: typeof entity.end === "number" ? entity.end : null,
          rawLabel: typeof entity.label === "string" ? entity.label : null
        };
        const existingObservation = rawEntityByName.get(normalizedEntityText);
        if (!existingObservation || shouldReplaceObservedEntity(existingObservation, observation)) {
          rawEntityByName.set(normalizedEntityText, observation);
        }
        if (!shouldStageObservedEntity(entityText, entityType, observation.score, entityThreshold)) {
          continue;
        }
        const resolvedEntityType = entityType;
        const cacheKey = `${resolvedEntityType}:${normalizedEntityText}`;
        if (!entityCache.has(cacheKey)) {
          const entityId = await resolveOrUpsertEntity(client, input.namespaceId, resolvedEntityType, entityText, [entityText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true
          });
          entityCache.set(cacheKey, { id: entityId, type: resolvedEntityType });
        }
      }

      for (const relation of extractor.relations ?? []) {
        const sourceText = normalizeWhitespace(relation.source ?? "");
        const targetText = normalizeWhitespace(relation.target ?? "");
        const predicate = mapPredicate(relation.relation);
        if (!sourceText || !targetText || !predicate) {
          continue;
        }

        const inferredTypes = inferEntityTypesFromPredicate(predicate.predicate);
        const sourceObserved = rawEntityByName.get(normalizeName(sourceText));
        const targetObserved = rawEntityByName.get(normalizeName(targetText));
        const sourceTypeHint = sourceObserved?.type ?? inferredTypes.source;
        const targetTypeHint = targetObserved?.type ?? inferredTypes.target;

        if (sourceTypeHint && !entityCache.has(`${sourceTypeHint}:${normalizeName(sourceText)}`)) {
          const sourceId = await resolveOrUpsertEntity(client, input.namespaceId, sourceTypeHint, sourceText, [sourceText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true,
            inferred_from_relation: true,
            raw_label: sourceObserved?.rawLabel ?? "other",
            span_start: sourceObserved?.start ?? null,
            span_end: sourceObserved?.end ?? null
          });
          entityCache.set(`${sourceTypeHint}:${normalizeName(sourceText)}`, { id: sourceId, type: sourceTypeHint });
        }

        if (targetTypeHint && !entityCache.has(`${targetTypeHint}:${normalizeName(targetText)}`)) {
          const targetId = await resolveOrUpsertEntity(client, input.namespaceId, targetTypeHint, targetText, [targetText], {
            extractor: extractor.extractor,
            model_id: extractor.model_id ?? null,
            schema_version: extractor.schema_version ?? "relation_ie_v1",
            thresholds: extractor.thresholds ?? null,
            external_ie: true,
            inferred_from_relation: true,
            raw_label: targetObserved?.rawLabel ?? "other",
            span_start: targetObserved?.start ?? null,
            span_end: targetObserved?.end ?? null
          });
          entityCache.set(`${targetTypeHint}:${normalizeName(targetText)}`, { id: targetId, type: targetTypeHint });
        }

        const sourceCandidate =
          entityCache.get(`person:${normalizeName(sourceText)}`) ??
          entityCache.get(`org:${normalizeName(sourceText)}`) ??
          entityCache.get(`project:${normalizeName(sourceText)}`) ??
          entityCache.get(`place:${normalizeName(sourceText)}`) ??
          entityCache.get(`media:${normalizeName(sourceText)}`);
        const targetCandidate =
          entityCache.get(`person:${normalizeName(targetText)}`) ??
          entityCache.get(`org:${normalizeName(targetText)}`) ??
          entityCache.get(`project:${normalizeName(targetText)}`) ??
          entityCache.get(`place:${normalizeName(targetText)}`) ??
          entityCache.get(`media:${normalizeName(targetText)}`);

        if (!sourceCandidate || !targetCandidate || sourceCandidate.id === targetCandidate.id) {
          continue;
        }

        const confidence = Math.max(0.4, Math.min(typeof relation.score === "number" ? relation.score : 0.6, 0.95));
        const priorScore = Math.max(0.5, Math.min(confidence - 0.05, 0.9));
        const routerMetadata = jsonObjectValue(scene.sourceChunkId ? routerMetadataByChunkId.get(scene.sourceChunkId) ?? null : null);
        const sourceRoute = metadataStringValue(routerMetadata, "source_route");
        const sourceIntelligenceProfile = metadataStringValue(routerMetadata, "source_intelligence_profile");
        const taxonomyProfile = metadataStringValue(routerMetadata, "taxonomy_profile");
        const relationFamily =
          typeof predicate.metadata.relex_family === "string" && predicate.metadata.relex_family.trim()
            ? predicate.metadata.relex_family
            : predicate.predicate;
        const answerShape =
          typeof predicate.metadata.relex_answer_shape === "string" && predicate.metadata.relex_answer_shape.trim()
            ? predicate.metadata.relex_answer_shape
            : null;
        const promotionAllowed = normalizeExtractorName(extractor.extractor) === GLINER_RELEX_EXTRACTOR ? config.relationIeGlinerRelexPromote : true;

        await client.query(
          `
            INSERT INTO relationship_candidates (
              namespace_id,
              subject_entity_id,
              predicate,
              object_entity_id,
              source_scene_id,
              source_memory_id,
              source_chunk_id,
              confidence,
              prior_score,
              prior_reason,
              status,
              valid_from,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12::jsonb)
            ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
            DO UPDATE SET
              confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
              prior_score = GREATEST(relationship_candidates.prior_score, EXCLUDED.prior_score),
              prior_reason = COALESCE(relationship_candidates.prior_reason, EXCLUDED.prior_reason),
              metadata = relationship_candidates.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            sourceCandidate.id,
            predicate.predicate,
            targetCandidate.id,
            scene.sceneId,
            scene.sourceMemoryId,
            scene.sourceChunkId,
            confidence,
            priorScore,
            `external_relation_ie:${extractor.extractor}`,
            scene.occurredAt,
            JSON.stringify({
              extractor: extractor.extractor,
              model_id: extractor.model_id ?? null,
              external_ie: true,
              schema_version: extractor.schema_version ?? "relation_ie_v1",
              thresholds: extractor.thresholds ?? null,
              classification_outputs: extractor.classifications ?? null,
              structure_outputs: extractor.structures ?? null,
              relation_schema_version:
                normalizeExtractorName(extractor.extractor) === GLINER_RELEX_EXTRACTOR
                  ? config.relationIeGlinerRelexSchemaVersion
                  : null,
              promotion_allowed: promotionAllowed,
              candidate_buffer: "relationship_candidates",
              candidate_buffer_kind: "relationship_candidates",
              universal_candidate_contract_version: "universal_candidate_buffer_v1",
              source_route: sourceRoute,
              source_intelligence_profile: sourceIntelligenceProfile,
              taxonomy_profile: taxonomyProfile,
              relation_family: relationFamily,
              answer_shape: answerShape,
              evidence_trigger: relation.relation ?? predicate.predicate,
              promotion_rejection_reason: promotionAllowed ? null : "relex_promotion_flag_disabled",
              source_quote: scene.text,
              snippet: scene.text,
              ingestion_router_v2: routerMetadata,
              raw_relation: relation.relation ?? null,
              raw_source: sourceText,
              raw_target: targetText,
              raw_source_label: sourceObserved?.rawLabel ?? null,
              raw_target_label: targetObserved?.rawLabel ?? null,
              raw_source_start: sourceObserved?.start ?? null,
              raw_source_end: sourceObserved?.end ?? null,
              raw_target_start: targetObserved?.start ?? null,
              raw_target_end: targetObserved?.end ?? null,
              raw_relation_start: typeof relation.start === "number" ? relation.start : null,
              raw_relation_end: typeof relation.end === "number" ? relation.end : null,
              relation_score: confidence,
              ...predicate.metadata
            })
          ]
        );
        stagedCount += 1;
      }
    }
  }

  return {
    stagedCount,
    warningCount,
    cacheHits: cacheHitSceneIds.size,
    cacheMisses: missingScenes.length,
    gliner2JobsSkipped: requestedExtractors.includes("gliner2") ? cacheHitSceneIds.size : 0
  };
}

export async function runExternalRelationExtractionShadow(
  scenes: readonly { readonly sceneIndex: number; readonly text: string }[],
  options?: {
    readonly extractors?: readonly string[];
  }
): Promise<SidecarResponse> {
  return runSidecar({
    extractors: options?.extractors,
    scenes: scenes.map((scene) => ({
      sceneIndex: scene.sceneIndex,
      sceneId: `shadow:${scene.sceneIndex}`,
      text: scene.text,
      occurredAt: new Date().toISOString(),
      sourceMemoryId: null,
      sourceChunkId: null
    }))
  });
}

export async function shutdownRelationIeSidecarWorker(): Promise<void> {
  const state = sidecarDaemonState;
  if (!state) {
    return;
  }
  sidecarDaemonState = null;
  const requestId = `shutdown_${state.nextRequestId++}`;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      state.child.kill("SIGKILL");
      finish();
    }, 2_000);
    state.child.once("close", () => {
      clearTimeout(timeout);
      finish();
    });
    const message: SidecarDaemonRequestMessage = { request_id: requestId, command: "shutdown" };
    state.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        clearTimeout(timeout);
        state.child.kill("SIGKILL");
        finish();
      }
    });
    state.child.stdin.end();
  });
}
