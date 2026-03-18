import type { PoolClient } from "pg";
import { loadNamespaceSelfProfileForClient, upsertNamespaceSelfProfileForClient } from "../identity/service.js";
import type { SceneRecord, TimeGranularity } from "../types.js";

type EntityType = "self" | "person" | "place" | "org" | "project" | "concept" | "unknown";

interface SceneSourceRef {
  readonly sceneIndex: number;
  readonly sourceMemoryIds: readonly string[];
  readonly sourceChunkIds: readonly string[];
  readonly occurredAt: string;
}

interface NarrativeClaim {
  readonly claimType: string;
  readonly subjectName?: string;
  readonly subjectType?: EntityType;
  readonly predicate: string;
  readonly objectName?: string;
  readonly objectType?: EntityType;
  readonly confidence: number;
  readonly status: "pending" | "accepted" | "abstained";
  readonly metadata?: Record<string, unknown>;
}

interface ResolvedNarrativeClaim extends NarrativeClaim {
  readonly subjectEntityId: string | null;
  readonly objectEntityId: string | null;
  readonly resolvedSubjectType?: EntityType;
  readonly resolvedObjectType?: EntityType;
}

interface NarrativeEventDraft {
  readonly eventKind: string;
  readonly eventLabel: string;
  readonly timeExpressionText?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly timeGranularity: TimeGranularity;
  readonly timeConfidence: number;
  readonly isRelativeTime: boolean;
  readonly primarySubjectEntityId?: string | null;
  readonly primaryLocationEntityId?: string | null;
  readonly metadata: Record<string, unknown>;
}

interface EventClusterState {
  readonly eventIndex: number;
  readonly eventKind: string;
  readonly primarySubjectEntityId?: string | null;
  readonly primaryLocationEntityId?: string | null;
  readonly orgProjectEntityIds: readonly string[];
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly timeGranularity: TimeGranularity;
}

interface PriorScore {
  readonly score: number;
  readonly reason: string;
}

type HistoricalPriorMap = ReadonlyMap<string, {
  readonly score: number;
  readonly neighborSignature: Record<string, unknown>;
}>;

interface ClaimAmbiguity {
  readonly state: "requires_clarification";
  readonly type:
    | "possible_misspelling"
    | "undefined_kinship"
    | "vague_place"
    | "alias_collision"
    | "unknown_reference"
    | "kinship_resolution"
    | "place_grounding";
  readonly reason: string;
  readonly targetRole: "subject" | "object";
  readonly rawText: string;
  readonly suggestedMatches: readonly string[];
}

interface StageNarrativeClaimsInput {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly observationId: string;
  readonly capturedAt: string;
  readonly scenes: readonly SceneRecord[];
  readonly sceneSources: readonly SceneSourceRef[];
}

interface StageNarrativeClaimsResult {
  readonly sceneCount: number;
  readonly claimCount: number;
  readonly relationshipCount: number;
}

const PLACE_NAMES = new Map<string, string>([
  ["australia", "Australia"],
  ["bangkok", "Bangkok"],
  ["chiang mai", "Chiang Mai"],
  ["danang", "Danang"],
  ["denmark", "Denmark"],
  ["france", "France"],
  ["iceland", "Iceland"],
  ["koh samui", "Koh Samui"],
  ["koh samui island", "Koh Samui Island"],
  ["mexico", "Mexico"],
  ["mexico city", "Mexico City"],
  ["singapore", "Singapore"],
  ["thailand", "Thailand"],
  ["turkey", "Turkey"],
  ["vietnam", "Vietnam"]
]);

const PLACE_CONTAINMENT = new Map<string, string>([
  ["Chiang Mai", "Thailand"],
  ["Koh Samui", "Thailand"],
  ["Koh Samui Island", "Thailand"],
  ["Danang", "Vietnam"],
  ["Mexico City", "Mexico"]
]);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
] as const;

const STOP_PERSON_NAMES = new Set([
  "He",
  "She",
  "They",
  "I",
  "We",
  "In",
  "On",
  "At",
  "By",
  "During",
  "After",
  "Before",
  "Earlier",
  "Later",
  "Last",
  "Next",
  "This",
  "Thailand",
  "Vietnam",
  "Iceland",
  "Australia",
  "Mexico",
  "France",
  "Singapore",
  "Danang",
  "Chiang",
  "Koh"
]);

const KINSHIP_TERMS = new Set([
  "uncle",
  "aunt",
  "grandpa",
  "grandma",
  "grandfather",
  "grandmother",
  "mother",
  "mom",
  "father",
  "dad",
  "brother",
  "sister",
  "cousin",
  "nephew",
  "niece"
]);

const VAGUE_PLACE_PHRASES = [/^summer home$/iu, /^cabin$/iu, /^the cabin$/iu, /^lake house$/iu, /^beach house$/iu, /^family house$/iu];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

function titleCase(value: string): string {
  return normalizeWhitespace(value)
    .split(/\s+/u)
    .map((part) => (part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}` : part))
    .join(" ");
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/u)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function expandContractions(value: string): string {
  return value
    .replace(/\bI'm\b/gu, "I am")
    .replace(/\bI've\b/gu, "I have")
    .replace(/\bI’d\b/gu, "I would")
    .replace(/\bI'd\b/gu, "I would")
    .replace(/\bHe’s\b/gu, "He is")
    .replace(/\bHe's\b/gu, "He is")
    .replace(/\bShe’s\b/gu, "She is")
    .replace(/\bShe's\b/gu, "She is")
    .replace(/\bThey’re\b/gu, "They are")
    .replace(/\bThey're\b/gu, "They are")
    .replace(/\bWe’d\b/gu, "We had")
    .replace(/\bWe'd\b/gu, "We had");
}

function canonicalizePlace(value: string): string | null {
  const cleaned = normalizeWhitespace(value.replace(/[.,;:]+$/u, ""));
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned.toLowerCase();
  if (PLACE_NAMES.has(normalized)) {
    return PLACE_NAMES.get(normalized) ?? null;
  }

  return null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function splitNameList(value: string): string[] {
  return value
    .split(/\s*(?:,|and)\s*/u)
    .map((part) => normalizeWhitespace(part.replace(/^(?:with|through)\s+/iu, "")))
    .filter(Boolean);
}

function looksLikePersonName(value: string): boolean {
  const cleaned = normalizeWhitespace(value.replace(/[.,;:]+$/u, ""));
  if (!cleaned) {
    return false;
  }

  const tokens = cleaned.split(/\s+/u);
  if (tokens.length > 3) {
    return false;
  }

  if (tokens.some((token) => STOP_PERSON_NAMES.has(token))) {
    return false;
  }

  return tokens.every((token) => /^[A-Z][a-z]+$/u.test(token));
}

function stripLeadingTemporalPhrase(value: string): string {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) {
    return cleaned;
  }

  const monthPattern = MONTH_NAMES.join("|");
  const weekdayPattern = WEEKDAY_NAMES.join("|");
  const patterns = [
    new RegExp(`^(?:In|On|By|Around|During)\\s+(?:${monthPattern})(?:\\s+\\d{4})?[,:]?\\s+`, "u"),
    new RegExp(`^(?:In|On|By|Around|During)\\s+(?:${weekdayPattern})[,:]?\\s+`, "u"),
    /^(?:Last|Next|This)\s+(?:week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,:]?\s+/u,
    /^\d+\s+(?:day|days|week|weeks|month|months|year|years)\s+(?:later|after|before|ago)[,:]?\s+/u,
    /^(?:Earlier|Later)\s+that\s+(?:day|week|month|year)[,:]?\s+/u
  ];

  for (const pattern of patterns) {
    const stripped = cleaned.replace(pattern, "");
    if (stripped !== cleaned) {
      return normalizeWhitespace(stripped);
    }
  }

  return cleaned;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));

  for (let i = 0; i <= left.length; i += 1) {
    matrix[i]![0] = i;
  }

  for (let j = 0; j <= right.length; j += 1) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + substitutionCost
      );
    }
  }

  return matrix[left.length]![right.length]!;
}

function findSuggestedAliasMatches(rawText: string, namespaceAliases: ReadonlyMap<string, string>): string[] {
  const normalizedRaw = normalizeName(rawText);
  if (!normalizedRaw) {
    return [];
  }

  const canonicals = new Set<string>();
  for (const [alias, canonical] of namespaceAliases.entries()) {
    if (!alias || !canonical) {
      continue;
    }

    const distance = levenshteinDistance(normalizedRaw, alias);
    if (distance <= 2 || alias.includes(normalizedRaw) || normalizedRaw.includes(alias)) {
      canonicals.add(canonical);
    }
  }

  return [...canonicals].sort((left, right) => left.localeCompare(right)).slice(0, 5);
}

function shouldAbstainPersonResolution(rawText: string, namespaceAliases: ReadonlyMap<string, string>): readonly string[] {
  const normalizedRaw = normalizeName(rawText);
  if (!normalizedRaw) {
    return [];
  }

  if (namespaceAliases.has(normalizedRaw)) {
    return [];
  }

  const rawTokenCount = normalizeWhitespace(rawText).split(/\s+/u).filter(Boolean).length;
  return findSuggestedAliasMatches(rawText, namespaceAliases).filter((candidate) => {
    const candidateNormalized = normalizeName(candidate);
    const candidateTokenCount = normalizeWhitespace(candidate).split(/\s+/u).filter(Boolean).length;
    if (candidateNormalized === normalizedRaw) {
      return false;
    }

    if (rawTokenCount < 2 && candidateTokenCount > rawTokenCount) {
      return false;
    }

    return true;
  });
}

function isVaguePlaceReference(rawText: string): boolean {
  const cleaned = normalizeWhitespace(rawText);
  return VAGUE_PLACE_PHRASES.some((pattern) => pattern.test(cleaned));
}

function classifyAmbiguity(
  claim: ResolvedNarrativeClaim,
  namespaceAliases: ReadonlyMap<string, string>
): ClaimAmbiguity | null {
  const candidates: Array<{
    readonly role: "subject" | "object";
    readonly text?: string;
    readonly entityId: string | null;
    readonly entityType?: EntityType;
  }> = [
    { role: "subject", text: claim.subjectName, entityId: claim.subjectEntityId, entityType: claim.resolvedSubjectType ?? claim.subjectType },
    { role: "object", text: claim.objectName, entityId: claim.objectEntityId, entityType: claim.resolvedObjectType ?? claim.objectType }
  ];

  for (const candidate of candidates) {
    const rawText = normalizeWhitespace(candidate.text ?? "");
    if (!rawText || candidate.entityId) {
      continue;
    }

    const normalized = normalizeName(rawText);
    if (!normalized) {
      continue;
    }

    if (KINSHIP_TERMS.has(normalized)) {
      return {
        state: "requires_clarification",
        type: "kinship_resolution",
        reason: `The ${candidate.role} reference "${rawText}" is a kinship role without a grounded person entity.`,
        targetRole: candidate.role,
        rawText,
        suggestedMatches: findSuggestedAliasMatches(rawText, namespaceAliases)
      };
    }

    if (VAGUE_PLACE_PHRASES.some((pattern) => pattern.test(rawText))) {
      return {
        state: "requires_clarification",
        type: "place_grounding",
        reason: `The ${candidate.role} reference "${rawText}" looks like a vague place that needs a concrete location.`,
        targetRole: candidate.role,
        rawText,
        suggestedMatches: findSuggestedAliasMatches(rawText, namespaceAliases)
      };
    }

    if ((candidate.entityType === "person" || looksLikePersonName(rawText)) && findSuggestedAliasMatches(rawText, namespaceAliases).length > 0) {
      return {
        state: "requires_clarification",
        type: "possible_misspelling",
        reason: `The ${candidate.role} reference "${rawText}" looks close to an existing person alias but did not resolve cleanly.`,
        targetRole: candidate.role,
        rawText,
        suggestedMatches: findSuggestedAliasMatches(rawText, namespaceAliases)
      };
    }

    if (candidate.entityType === "place" || /home|house|villa|island|city|town|beach|cabin/iu.test(rawText)) {
      return {
        state: "requires_clarification",
        type: "unknown_reference",
        reason: `The ${candidate.role} reference "${rawText}" did not resolve to a known place or entity.`,
        targetRole: candidate.role,
        rawText,
        suggestedMatches: findSuggestedAliasMatches(rawText, namespaceAliases)
      };
    }
  }

  return null;
}

async function loadExistingSelfName(client: PoolClient, namespaceId: string): Promise<string | null> {
  const boundProfile = await loadNamespaceSelfProfileForClient(client, namespaceId);
  if (boundProfile?.canonicalName) {
    return boundProfile.canonicalName;
  }

  const result = await client.query<{ canonical_name: string }>(
    `
      SELECT canonical_name
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
    [namespaceId]
  );

  return result.rows[0]?.canonical_name ?? null;
}

function cleanProjectName(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\b(?:i\s+am|i'm|am)\s+working\s+on\s+/giu, "")
      .replace(/\b(?:we\s+are|we're)\s+building\s+/giu, "")
      .replace(/[.,;:]+$/gu, "")
  );
}

async function loadNamespacePersonAliases(client: PoolClient, namespaceId: string): Promise<Map<string, string>> {
  const result = await client.query<{ alias: string; canonical_name: string }>(
    `
      SELECT ea.alias, e.canonical_name
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('self', 'person')
        AND e.merged_into_entity_id IS NULL
    `,
    [namespaceId]
  );

  const aliases = new Map<string, string>();
  for (const row of result.rows) {
    aliases.set(normalizeName(row.alias), row.canonical_name);
  }

  return aliases;
}

function buildPriorPairKey(leftEntityId: string, rightEntityId: string): string {
  return [leftEntityId, rightEntityId].sort((left, right) => left.localeCompare(right)).join("::");
}

async function loadRelationshipPriors(client: PoolClient, namespaceId: string): Promise<HistoricalPriorMap> {
  const result = await client.query<{
    entity_a_id: string;
    entity_b_id: string;
    global_correlation_score: number;
    neighbor_signature: Record<string, unknown>;
  }>(
    `
      SELECT entity_a_id::text, entity_b_id::text, global_correlation_score, neighbor_signature
      FROM relationship_priors
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );

  return new Map(
    result.rows.map((row) => [
      buildPriorPairKey(row.entity_a_id, row.entity_b_id),
      {
        score: row.global_correlation_score,
        neighborSignature: row.neighbor_signature ?? {}
      }
    ] as const)
  );
}

function extractAliasPairs(text: string): Array<{ canonical: string; aliases: readonly string[] }> {
  const pairs: Array<{ canonical: string; aliases: readonly string[] }> = [];
  const matches = text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}),\s+or\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu);

  for (const match of matches) {
    const left = normalizeWhitespace(match[1] ?? "");
    const right = normalizeWhitespace(match[2] ?? "");
    if (!left || !right) {
      continue;
    }

    const canonical = right.split(/\s+/u).length >= left.split(/\s+/u).length ? right : left;
    const aliases = unique([left, right, left.split(/\s+/u)[0] ?? "", right.split(/\s+/u)[0] ?? ""].filter(Boolean));
    pairs.push({ canonical, aliases });
  }

  return pairs;
}

function buildAliasMap(aliasPairs: readonly { canonical: string; aliases: readonly string[] }[]): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const pair of aliasPairs) {
    for (const alias of pair.aliases) {
      aliasMap.set(normalizeName(alias), pair.canonical);
    }
  }

  return aliasMap;
}

function extractExplicitPeople(text: string, aliasPairs: readonly { canonical: string; aliases: readonly string[] }[]): string[] {
  const names = new Set<string>(aliasPairs.map((pair) => pair.canonical));
  const patterns = [
    /\bfriend\s+named\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\bmy friend\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\bperson\s+named\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\bran into\s+(?:a person named\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\bI(?:\s+have|\s+also)?\s+met\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\bWe have\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/gu,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:is from|runs|has lived|is currently in|is an engineer|buckles)\b/gu
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = normalizeWhitespace(match[1] ?? "");
      if (looksLikePersonName(name)) {
        names.add(name);
      }
    }
  }

  return [...names];
}

function extractProjectsAndOrgs(text: string): { readonly projects: readonly string[]; readonly orgs: readonly string[] } {
  const projects = new Set<string>();
  const orgs = new Set<string>();

  for (const match of text.matchAll(/\bcompany\s+called\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b/gu)) {
    const name = normalizeWhitespace(match[1] ?? "");
    if (name) {
      projects.add(name);
    }
  }

  for (const match of text.matchAll(/\bfor\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.&-]+){0,3})\b/gu)) {
    const name = normalizeWhitespace(match[1] ?? "");
    if (name && /\bAir\b/u.test(name)) {
      orgs.add(name);
    }
  }

  return {
    projects: [...projects],
    orgs: [...orgs]
  };
}

function resolvePersonName(
  raw: string | undefined,
  aliasMap: ReadonlyMap<string, string>,
  selfName: string | null,
  explicitPeople: readonly string[]
): string | undefined {
  const cleaned = normalizeWhitespace(raw ?? "");
  if (!cleaned) {
    return undefined;
  }

  const normalized = normalizeName(cleaned);
  const aliased = aliasMap.get(normalized);
  if (aliased) {
    return aliased;
  }

  if (selfName && normalized === normalizeName(selfName)) {
    return selfName;
  }

  const byFirstName = explicitPeople.find((name) => normalizeName(name.split(/\s+/u)[0] ?? "") === normalized);
  if (byFirstName) {
    return byFirstName;
  }

  const direct = explicitPeople.find((name) => normalizeName(name) === normalized);
  if (direct) {
    return direct;
  }

  return looksLikePersonName(cleaned) ? titleCase(cleaned) : undefined;
}

function extractClaimsFromScene(
  sceneText: string,
  selfName: string | null,
  knownAliases: ReadonlyMap<string, string>
): { readonly claims: readonly NarrativeClaim[]; readonly aliases: ReadonlyMap<string, string> } {
  const aliasPairs = extractAliasPairs(sceneText);
  const aliasMap = new Map<string, string>(knownAliases);
  for (const [alias, canonical] of buildAliasMap(aliasPairs).entries()) {
    aliasMap.set(alias, canonical);
  }
  const explicitPeople = extractExplicitPeople(sceneText, aliasPairs);
  const discovered = extractProjectsAndOrgs(sceneText);
  const claims: NarrativeClaim[] = [];
  const sentences = splitSentences(sceneText);
  let resolvedSelfName = selfName;
  let lastPerson: string | undefined;
  let lastProject: string | undefined = discovered.projects[0];
  let lastOrg: string | undefined = discovered.orgs[0];

  for (const sentence of sentences) {
    const sentenceText = expandContractions(sentence);
    const sentenceTextForSubject = stripLeadingTemporalPhrase(sentenceText);
    const selfMatch = sentenceText.match(/\bmy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu);
    if (selfMatch) {
      resolvedSelfName = normalizeWhitespace(selfMatch[1] ?? "");
    }

    const sentencePeople = extractExplicitPeople(sentenceTextForSubject, aliasPairs).map((name) =>
      resolvePersonName(name, aliasMap, resolvedSelfName, explicitPeople)
    );
    const leadingPersonToken = normalizeWhitespace(sentenceTextForSubject.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u)?.[1] ?? "");
    const leadingSubject =
      leadingPersonToken && looksLikePersonName(leadingPersonToken)
        ? resolvePersonName(leadingPersonToken, aliasMap, resolvedSelfName, explicitPeople) ?? leadingPersonToken
        : undefined;
    const explicitSubject = sentencePeople.find(Boolean) ?? leadingSubject;
    const subject =
      /\b(?:I|my|me|we|our)\b/u.test(sentenceText)
        ? resolvedSelfName ?? undefined
        : explicitSubject ?? (/^\b(?:He|His|She|Her|They|Their)\b/u.test(sentenceText) ? lastPerson : undefined);

    if (explicitSubject) {
      lastPerson = explicitSubject;
    }

    for (const match of sentenceText.matchAll(/\bmy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/giu)) {
      const name = normalizeWhitespace(match[1] ?? "");
      resolvedSelfName = name;
      claims.push({
        claimType: "identity",
        subjectName: name,
        subjectType: "self",
        predicate: "self_name",
        objectName: name,
        objectType: "self",
        confidence: 0.99,
        status: "accepted"
      });
      lastPerson = name;
    }

    if (
      subject &&
      /\b(?:I|He|She|They|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:(?:am|are|is|was|were|had been)\s+)?(?:live|lives|living)\s+(?:out here too|in)\b/u.test(
        sentenceText
      )
    ) {
      const placeMentions = unique(
        [...PLACE_NAMES.values()].filter((place) => new RegExp(`\\b${place.replace(/\s+/gu, "\\s+")}\\b`, "iu").test(sentenceText))
      );
      const rawPlaceMatch = sentenceText.match(
        /\b(?:(?:am|are|is|was|were|had been)\s+)?(?:live|lives|living)\s+in\s+([^.,;]+?)(?:\s+for\b|\s+with\b|[.?!,;]|$)/iu
      );
      const rawPlace = normalizeWhitespace(rawPlaceMatch?.[1] ?? "");

      if (/\bout here too\b/iu.test(sentenceText) && placeMentions.length === 0) {
        claims.push({
          claimType: "location",
          subjectName: subject,
          subjectType: subject === resolvedSelfName ? "self" : "person",
          predicate: "lives_in",
          confidence: 0.4,
          status: "abstained",
          metadata: { reason: "vague_relative_place" }
        });
      }

      if (!/\bout here too\b/iu.test(sentenceText) && rawPlace && placeMentions.length === 0) {
        claims.push({
          claimType: "location",
          subjectName: subject,
          subjectType: subject === resolvedSelfName ? "self" : "person",
          predicate: "lives_in",
          objectName: rawPlace,
          objectType: "place",
          confidence: 0.48,
          status: "pending"
        });
      }

      for (const place of placeMentions) {
        claims.push({
          claimType: "location",
          subjectName: subject,
          subjectType: subject === resolvedSelfName ? "self" : "person",
          predicate: "lives_in",
          objectName: place,
          objectType: "place",
          confidence: place === "Thailand" ? 0.8 : 0.93,
          status: "accepted"
        });
      }
    }

    if (subject && /\b(?:I|He|She|They|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+lived\s+(?:on|in)\b/u.test(sentenceText)) {
      const placeMentions = unique(
        [...PLACE_NAMES.values()].filter((place) => new RegExp(`\\b${place.replace(/\s+/gu, "\\s+")}\\b`, "iu").test(sentenceText))
      );
      const rawPlaceMatch = sentenceText.match(/\blived\s+(?:on|in)\s+([^.,;]+?)(?:\s+for\b|\s+with\b|[.?!,;]|$)/iu);
      const rawPlace = normalizeWhitespace(rawPlaceMatch?.[1] ?? "");

      for (const place of placeMentions) {
        claims.push({
          claimType: "location_history",
          subjectName: subject,
          subjectType: subject === selfName ? "self" : "person",
          predicate: "lived_in",
          objectName: place,
          objectType: "place",
          confidence: 0.9,
          status: "accepted"
        });
      }

      if (rawPlace && placeMentions.length === 0) {
        claims.push({
          claimType: "location_history",
          subjectName: subject,
          subjectType: subject === selfName ? "self" : "person",
          predicate: "lived_in",
          objectName: rawPlace,
          objectType: "place",
          confidence: 0.46,
          status: "pending"
        });
      }

      const withMatch = sentenceText.match(/\bwith\s+(?:my friend\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u);
      if (withMatch && resolvedSelfName) {
        const person = resolvePersonName(withMatch[1], aliasMap, resolvedSelfName, explicitPeople);
        if (person) {
          claims.push({
            claimType: "relationship",
            subjectName: resolvedSelfName,
            subjectType: "self",
            predicate: "with",
            objectName: person,
            objectType: "person",
            confidence: 0.88,
            status: "accepted"
          });
          lastPerson = person;
        }
      }
    }

    if (resolvedSelfName && /\b(?:best friends?|good friends?)\b/iu.test(sentenceText)) {
      const person =
        sentenceText.match(/\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u)?.[1] ??
        lastPerson;

      if (person) {
        claims.push({
          claimType: "relationship",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "friend_of",
          objectName: resolvePersonName(person, aliasMap, resolvedSelfName, explicitPeople),
          objectType: "person",
          confidence: 0.92,
          status: "accepted"
        });
      }
    }

    const friendsWithMatch = sentenceText.match(
      /\b((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|I)\s+is\s+friends?\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}(?:\s*(?:,|and)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})*)/iu
    );
    if (friendsWithMatch) {
      const rawSubject = normalizeWhitespace(friendsWithMatch[1] ?? "");
      const subjectPerson =
        rawSubject === "I" ? resolvedSelfName ?? undefined : resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const targets = splitNameList(friendsWithMatch[2] ?? "");

      for (const target of targets) {
        const person = resolvePersonName(target, aliasMap, resolvedSelfName, explicitPeople);
        if (subjectPerson && person && normalizeName(subjectPerson) !== normalizeName(person)) {
          claims.push({
            claimType: "relationship",
            subjectName: subjectPerson,
            subjectType: subjectPerson === resolvedSelfName ? "self" : "person",
            predicate: "friend_of",
            objectName: person,
            objectType: "person",
            confidence: 0.92,
            status: "accepted"
          });
          lastPerson = person;
        }
      }
    }

    const goodFriendMatch = sentenceText.match(/\bgood friend of ours,\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu);
    if (goodFriendMatch && subject) {
      const person = resolvePersonName(goodFriendMatch[1], aliasMap, resolvedSelfName, explicitPeople);
      if (person) {
        claims.push({
          claimType: "relationship",
          subjectName: subject,
          subjectType: subject === resolvedSelfName ? "self" : "person",
          predicate: "friend_of",
          objectName: person,
          objectType: "person",
          confidence: 0.84,
          status: "accepted"
        });
        lastPerson = person;
      }
    }

    const fromMatch = sentenceTextForSubject.match(/^(?:((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She|They))\b.*?\bis\s+from\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u);
    if (fromMatch) {
      const rawSubject = fromMatch[2] ? lastPerson : fromMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const place = canonicalizePlace(fromMatch[3] ?? "");
      if (person && place) {
        claims.push({
          claimType: "origin",
          subjectName: person,
          subjectType: person === resolvedSelfName ? "self" : "person",
          predicate: "from",
          objectName: place,
          objectType: "place",
          confidence: 0.94,
          status: "accepted"
        });
        lastPerson = person;
      }
    }

    const passportMatch = sentenceTextForSubject.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\b([A-Z][A-Za-z]+)\s+passport\b/u);
    if (passportMatch) {
      const rawSubject = passportMatch[2] ? lastPerson : passportMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const place = canonicalizePlace(passportMatch[3] ?? "");
      if (person && place) {
        claims.push({
          claimType: "citizenship_hint",
          subjectName: person,
          subjectType: "person",
          predicate: "passport_country",
          objectName: place,
          objectType: "place",
          confidence: 0.82,
          status: "pending"
        });
      }
    }

    const pilotForMatch = sentenceTextForSubject.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bpilot\s+for\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.&-]+){0,3})\b/u);
    if (pilotForMatch) {
      const rawSubject = pilotForMatch[2] ? lastPerson : pilotForMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const org = normalizeWhitespace(pilotForMatch[3] ?? "");
      if (person && org) {
        lastOrg = org;
        claims.push({
          claimType: "employment",
          subjectName: person,
          subjectType: "person",
          predicate: "works_at",
          objectName: org,
          objectType: "org",
          confidence: 0.9,
          status: "accepted",
          metadata: { role: "airline_pilot" }
        });
      }
    }

    const companyMatch = sentenceTextForSubject.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bruns\s+(?:a\s+company\s+called\s+)?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b/u);
    if (companyMatch) {
      const rawSubject = companyMatch[2] ? lastPerson : companyMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const project = normalizeWhitespace(companyMatch[3] ?? "");
      if (person && project) {
        lastProject = project;
        claims.push({
          claimType: "organization_role",
          subjectName: person,
          subjectType: "person",
          predicate: "runs",
          objectName: project,
          objectType: "project",
          confidence: 0.94,
          status: "accepted"
        });
      }
    }

    const createdByMatch = sentenceText.match(
      /\b([A-Z][A-Za-z0-9]+(?:-[A-Z][A-Za-z0-9]+)?(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b(?:,\s*|\s+)a\s+project\s+created\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu
    );
    if (createdByMatch) {
      const projectName = cleanProjectName(createdByMatch[1] ?? "");
      const person = resolvePersonName(createdByMatch[2], aliasMap, resolvedSelfName, explicitPeople);
      if (projectName && person) {
        lastProject = projectName;
        lastPerson = person;
        claims.push({
          claimType: "project_origin",
          subjectName: person,
          subjectType: person === resolvedSelfName ? "self" : "person",
          predicate: "created_by",
          objectName: projectName,
          objectType: "project",
          confidence: 0.9,
          status: "accepted"
        });
      }
    }

    const workingOnMatch = sentenceText.match(
      /\bI(?:'m|\s+am)?\s+working\s+on\s+([A-Z][A-Za-z0-9]+(?:-[A-Z][A-Za-z0-9]+)?(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b/iu
    );
    if (workingOnMatch && resolvedSelfName) {
      const projectName = cleanProjectName(workingOnMatch[1] ?? "");
      if (projectName) {
        lastProject = projectName;
        claims.push({
          claimType: "project_engagement",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "works_on",
          objectName: projectName,
          objectType: "project",
          confidence: 0.84,
          status: "accepted"
        });
      }
    }

    const actingRoleMatch = sentenceText.match(
      /\bI(?:'m|\s+am)?\s+the\s+acting\s+([A-Za-z][A-Za-z0-9 /-]{1,60}?)\s+for\s+([A-Z][A-Za-z0-9]+(?:-[A-Z][A-Za-z0-9]+)?(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4}?)(?=\s+(?:and|as|with|who|that|which|we|he|she|they)\b|[.,;]|$)/iu
    );
    if (resolvedSelfName && actingRoleMatch) {
      const role = normalizeWhitespace(actingRoleMatch[1] ?? "");
      const projectName = cleanProjectName(actingRoleMatch[2] ?? "");
      if (projectName && role) {
        lastProject = projectName;
        claims.push({
          claimType: "role_assigned",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "project_role",
          objectName: projectName,
          objectType: "project",
          confidence: 0.92,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            role
          }
        });
      }
    }

    const worksAtMatch = sentenceTextForSubject.match(
      /^(?:((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She|They))\b.*?\bworks?\s+at\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b/u
    );
    if (worksAtMatch) {
      const rawSubject = worksAtMatch[2] ? lastPerson : worksAtMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const orgOrProject = normalizeWhitespace(worksAtMatch[3] ?? "");
      if (person && orgOrProject) {
        lastProject = orgOrProject;
        claims.push({
          claimType: "employment",
          subjectName: person,
          subjectType: person === resolvedSelfName ? "self" : "person",
          predicate: "works_at",
          objectName: orgOrProject,
          objectType: "project",
          confidence: 0.88,
          status: "accepted"
        });
      }
    }

    const associationMatch = sentenceText.match(
      /^(?:((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She|They))\b.*?\bpart of\s+(?:the\s+)?([A-Za-z][A-Za-z0-9.& -]{2,80}?association)\b/iu
    );
    if (associationMatch) {
      const rawSubject = associationMatch[2] ? lastPerson : associationMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const orgName = normalizeWhitespace(associationMatch[3] ?? "").replace(/^the\s+/iu, "");
      if (person && orgName) {
        lastOrg = titleCase(orgName);
        claims.push({
          claimType: "org_membership",
          subjectName: person,
          subjectType: person === resolvedSelfName ? "self" : "person",
          predicate: "member_of",
          objectName: lastOrg,
          objectType: "org",
          confidence: 0.88,
          status: "accepted"
        });
      }
    }

    const bestFriendsWithMatch = sentenceText.match(
      /^(?:((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She|They))\b.*?\bbest friends?\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu
    );
    if (bestFriendsWithMatch) {
      const rawSubject = bestFriendsWithMatch[2] ? lastPerson : bestFriendsWithMatch[1];
      const subjectPerson = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const targetPerson = resolvePersonName(bestFriendsWithMatch[3], aliasMap, resolvedSelfName, explicitPeople);
      if (subjectPerson && targetPerson && normalizeName(subjectPerson) !== normalizeName(targetPerson)) {
        claims.push({
          claimType: "relationship",
          subjectName: subjectPerson,
          subjectType: subjectPerson === resolvedSelfName ? "self" : "person",
          predicate: "friend_of",
          objectName: targetPerson,
          objectType: "person",
          confidence: 0.9,
          status: "accepted"
        });
      }
    }

    if (resolvedSelfName && /\bwe\s+go\s+hiking\b/iu.test(sentenceText) && lastPerson) {
      claims.push({
        claimType: "relationship",
        subjectName: resolvedSelfName,
        subjectType: "self",
        predicate: "hikes_with",
        objectName: lastPerson,
        objectType: "person",
        confidence: 0.85,
        status: "accepted"
      });
    }

    if (resolvedSelfName && /\bstarted working for his company\b/iu.test(sentenceText)) {
      if (lastProject) {
        claims.push({
          claimType: "employment",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "works_at",
          objectName: lastProject,
          objectType: "project",
          confidence: 0.92,
          status: "accepted",
          metadata: { role: sentenceText.match(/\bas\s+([A-Za-z ]+?)\b(?:just recently|for|now|$)/iu)?.[1]?.trim() ?? null }
        });
      } else {
        claims.push({
          claimType: "employment",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "works_at",
          confidence: 0.35,
          status: "abstained",
          metadata: { reason: "missing_project_context" }
        });
      }
    }

    if (resolvedSelfName && /\bstarted working with him\b/iu.test(sentenceText)) {
      if (lastPerson) {
        claims.push({
          claimType: "relationship",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "works_with",
          objectName: lastPerson,
          objectType: "person",
          confidence: 0.86,
          status: "accepted",
          metadata: { role: sentenceText.match(/\bas\s+([A-Za-z ]+?)\b(?:as well|$)/iu)?.[1]?.trim() ?? null }
        });

        if (lastProject) {
          claims.push({
            claimType: "employment",
            subjectName: resolvedSelfName,
            subjectType: "self",
            predicate: "works_at",
            objectName: lastProject,
            objectType: "project",
            confidence: 0.82,
            status: "accepted",
            metadata: { role: sentenceText.match(/\bas\s+([A-Za-z ]+?)\b(?:as well|$)/iu)?.[1]?.trim() ?? null }
          });
        }
      }
    }

    const workedWithMatch = sentenceText.match(
      /\bworked\s+with\s+((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|uncle|aunt|cousin|brother|sister|dad|father|mom|mother)\b(?=\s+on\b|[.?!,;]|$)/iu
    );
    if (subject && workedWithMatch) {
      const rawPerson = normalizeWhitespace(workedWithMatch[1] ?? "");
      const person = resolvePersonName(rawPerson, aliasMap, resolvedSelfName, explicitPeople) ?? rawPerson;
      claims.push({
        claimType: "relationship",
        subjectName: subject,
        subjectType: resolvedSelfName && subject === resolvedSelfName ? "self" : "person",
        predicate: "works_with",
        objectName: person,
        objectType: "person",
        confidence: KINSHIP_TERMS.has(normalizeName(rawPerson)) ? 0.42 : 0.78,
        status: KINSHIP_TERMS.has(normalizeName(rawPerson)) ? "pending" : "accepted"
      });
      lastPerson = person;
    }

    const explicitProjectStatusMatch = sentenceText.match(
      /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\s+status\s+is\s+(active|on hold|paused|blocked|archived|in progress)\b/iu
    );
    if (explicitProjectStatusMatch) {
      const projectName = normalizeWhitespace(explicitProjectStatusMatch[1] ?? "");
      const statusValue = normalizeWhitespace(explicitProjectStatusMatch[2] ?? "").toLowerCase();
      if (projectName && statusValue) {
        lastProject = projectName;
        claims.push({
          claimType: "project_status_changed",
          subjectName: projectName,
          subjectType: "project",
          predicate: "project_status",
          objectName: statusValue,
          objectType: "concept",
          confidence: 0.94,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            status_value: statusValue
          }
        });
      }
    }

    const projectDeadlineMatch = sentenceText.match(
      /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\s+(?:deadline|launch)\s+(?:moved to|is)\s+([A-Z][a-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})\b/iu
    );
    if (projectDeadlineMatch) {
      const projectName = normalizeWhitespace(projectDeadlineMatch[1] ?? "");
      const deadlineText = normalizeWhitespace(projectDeadlineMatch[2] ?? "");
      if (projectName && deadlineText) {
        lastProject = projectName;
        claims.push({
          claimType: "deadline_changed",
          subjectName: projectName,
          subjectType: "project",
          predicate: "project_deadline",
          objectName: deadlineText,
          objectType: "concept",
          confidence: 0.88,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            deadline_text: deadlineText
          }
        });
      }
    }

    const projectTechMatch = sentenceText.match(
      /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\s+(?:uses|use|runs on|moved to|switched to)\s+(.+?)$/iu
    );
    if (projectTechMatch) {
      const projectName = normalizeWhitespace(projectTechMatch[1] ?? "");
      const summary = normalizeWhitespace(projectTechMatch[2] ?? "").replace(/[.]+$/u, "");
      if (
        projectName &&
        summary &&
        /\b(?:PostgreSQL|pgvector|BM25|ParadeDB|Next\.js|Node\.js|TypeScript|React|Tailwind|shadcn)\b/iu.test(summary)
      ) {
        lastProject = projectName;
        claims.push({
          claimType: "project_spec_changed",
          subjectName: projectName,
          subjectType: "project",
          predicate: "project_focus",
          objectName: summary,
          objectType: "concept",
          confidence: 0.82,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            spec_summary: summary
          }
        });
      }
    }

    if (resolvedSelfName && lastProject) {
      const roleMatch = sentenceText.match(/\bas\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 /-]{1,60}?)(?:\s+just recently|\s+as well|\.|,|$)/iu);
      const extractedRole = normalizeWhitespace(roleMatch?.[1] ?? "");
      if (
        extractedRole &&
        /\b(?:cto|fractional cto|engineer|founder|owner|lead|designer|pm)\b/iu.test(extractedRole) &&
        /\b(?:working|worked|hired|joined|as)\b/iu.test(sentenceText) &&
        !/\bacting\s+[A-Za-z]/iu.test(sentenceText)
      ) {
        claims.push({
          claimType: "role_assigned",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "project_role",
          objectName: lastProject,
          objectType: "project",
          confidence: 0.84,
          status: "accepted",
          metadata: {
            project_key: normalizeName(lastProject),
            role: extractedRole
          }
        });
      }
    }

    const explicitProjectRoleMatch = sentenceText.match(
      /\b(?:I|We)\s+(?:joined|join|work(?:ing)?\s+on|am|are)\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\s+as\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 /-]{1,60}?)(?:\.|,|$)/iu
    );
    if (resolvedSelfName && explicitProjectRoleMatch) {
      const projectName = normalizeWhitespace(explicitProjectRoleMatch[1] ?? "");
      const role = normalizeWhitespace(explicitProjectRoleMatch[2] ?? "");
      if (projectName && role) {
        lastProject = projectName;
        claims.push({
          claimType: "role_assigned",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "project_role",
          objectName: projectName,
          objectType: "project",
          confidence: 0.9,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            role
          }
        });
      }
    }

    const conferenceMatch = sentenceText.match(
      /\b(?:go(?:ing)?|travel(?:ing)?|demo(?:ing)?|present(?:ing)?)\s+to\s+(?:a\s+)?conference\s+in\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}?)(?=\s+(?:with|for|about|on|this|that)\b|[.,;]|$)/iu
    );
    if (conferenceMatch && resolvedSelfName) {
      const place = canonicalizePlace(conferenceMatch[1] ?? "") ?? normalizeWhitespace(conferenceMatch[1] ?? "");
      if (place) {
        claims.push({
          claimType: "project_focus_changed",
          subjectName: lastProject ?? resolvedSelfName,
          subjectType: lastProject ? "project" : "self",
          predicate: "project_focus",
          objectName: `conference in ${place}`,
          objectType: "concept",
          confidence: lastProject ? 0.78 : 0.6,
          status: lastProject ? "accepted" : "pending",
          metadata: {
            project_key: lastProject ? normalizeName(lastProject) : null,
            event_kind: "conference",
            place
          }
        });
      }
    }

    const actingRoleForProjectMatch = sentenceText.match(
      /\bI(?:'m|\s+am)?\s+the\s+((?!acting\b)[A-Za-z][A-Za-z0-9 /-]{1,60}?)\s+for\s+([A-Z][A-Za-z0-9]+(?:-[A-Z][A-Za-z0-9]+)?(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4}?)(?=\s+(?:and|as|with|who|that|which|we|he|she|they)\b|[.,;]|$)/iu
    );
    if (resolvedSelfName && actingRoleForProjectMatch) {
      const role = normalizeWhitespace(actingRoleForProjectMatch[1] ?? "");
      const projectName = cleanProjectName(actingRoleForProjectMatch[2] ?? "");
      if (role && projectName) {
        lastProject = projectName;
        claims.push({
          claimType: "role_assigned",
          subjectName: resolvedSelfName,
          subjectType: "self",
          predicate: "project_role",
          objectName: projectName,
          objectType: "project",
          confidence: 0.9,
          status: "accepted",
          metadata: {
            project_key: normalizeName(projectName),
            role
          }
        });
      }
    }

    const livedPlacesMatch = sentenceTextForSubject.match(/\b((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+has\s+lived\s+in\s+([A-Z][A-Za-z]+)(?:\s+and\s+([A-Z][A-Za-z]+))?\b/u);
    if (livedPlacesMatch) {
      const person = resolvePersonName(livedPlacesMatch[1], aliasMap, resolvedSelfName, explicitPeople);
      const places = [canonicalizePlace(livedPlacesMatch[2] ?? ""), canonicalizePlace(livedPlacesMatch[3] ?? "")].filter(Boolean) as string[];
      for (const place of places) {
        if (person) {
          claims.push({
            claimType: "location_history",
            subjectName: person,
            subjectType: "person",
            predicate: "lived_in",
            objectName: place,
            objectType: "place",
            confidence: 0.88,
            status: "accepted"
          });
        }
      }
    }

    const currentlyInMatch = sentenceTextForSubject.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bis\s+currently\s+in\s+([A-Z][A-Za-z]+(?:,\s*[A-Z][A-Za-z]+)?(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
    if (currentlyInMatch) {
      const rawSubject = currentlyInMatch[2] ? lastPerson : currentlyInMatch[1];
      const person = resolvePersonName(rawSubject, aliasMap, resolvedSelfName, explicitPeople);
      const places = normalizeWhitespace(currentlyInMatch[3] ?? "")
        .split(/\s*,\s*/u)
        .map((value) => canonicalizePlace(value))
        .filter(Boolean) as string[];

      for (const place of places) {
        if (person) {
          claims.push({
            claimType: "current_location",
            subjectName: person,
            subjectType: "person",
            predicate: "currently_in",
            objectName: place,
            objectType: "place",
            confidence: place === "Vietnam" ? 0.78 : 0.92,
            status: "accepted"
          });
        }
      }
    }

    const futureMoveMatch = sentenceText.match(/\bmove back to\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
    if (futureMoveMatch && lastPerson) {
      claims.push({
        claimType: "future_location",
        subjectName: lastPerson,
        subjectType: "person",
        predicate: "currently_in",
        objectName: canonicalizePlace(futureMoveMatch[1] ?? "") ?? undefined,
        objectType: "place",
        confidence: 0.3,
        status: "abstained",
        metadata: { reason: "future_or_intended_move" }
      });
    }
  }

  return {
    claims,
    aliases: aliasMap
  };
}

function toPredicateLabel(predicate: string): string {
  return predicate.replaceAll("_", " ");
}

function inferEventKind(sceneText: string, claims: readonly ResolvedNarrativeClaim[]): string {
  const lowered = sceneText.toLowerCase();
  const predicates = new Set(claims.filter((claim) => claim.status === "accepted").map((claim) => claim.predicate));

  if (
    predicates.has("lives_in") ||
    predicates.has("lived_in") ||
    predicates.has("currently_in") ||
    predicates.has("from") ||
    /\b(?:live|lived|living|move back|destination thailand visa|dtv)\b/u.test(lowered)
  ) {
    if (
      !(predicates.has("works_at") || predicates.has("works_on") || predicates.has("works_with") || predicates.has("runs")) ||
      /\b(?:chiang mai|koh samui|danang|thailand|vietnam)\b/u.test(lowered)
    ) {
      return "life_update";
    }
  }

  if (
    predicates.has("works_at") ||
    predicates.has("works_on") ||
    predicates.has("works_with") ||
    predicates.has("project_status") ||
    predicates.has("project_deadline") ||
    predicates.has("project_focus") ||
    predicates.has("project_role") ||
    predicates.has("runs") ||
    predicates.has("created_by") ||
    predicates.has("member_of") ||
    /\b(?:cto|fractional cto|company|memoir engine|zoom|application)\b/u.test(lowered)
  ) {
    return "work";
  }

  if (
    predicates.has("friend_of") ||
    predicates.has("with") ||
    predicates.has("hikes_with") ||
    /\b(?:met|friends|introduced|group|hiking)\b/u.test(lowered)
  ) {
    return "social";
  }

  return "story_scene";
}

function buildEventLabel(sceneText: string, claims: readonly ResolvedNarrativeClaim[]): string {
  const predicatePriority = [
    "project_status",
    "project_deadline",
    "project_focus",
    "project_role",
    "works_on",
    "created_by",
    "member_of",
    "works_at",
    "works_with",
    "runs",
    "lives_in",
    "lived_in",
    "currently_in",
    "friend_of",
    "with",
    "hikes_with",
    "from"
  ];
  const acceptedClaims = claims.filter(
    (claim) => claim.status === "accepted" && claim.subjectName && claim.objectName && claim.predicate !== "self_name"
  );
  const primaryClaim =
    predicatePriority
      .map((predicate) => acceptedClaims.find((claim) => claim.predicate === predicate))
      .find(Boolean) ?? acceptedClaims[0];

  if (primaryClaim?.subjectName && primaryClaim.objectName) {
    return normalizeWhitespace(
      `${primaryClaim.subjectName} ${toPredicateLabel(primaryClaim.predicate)} ${primaryClaim.objectName}`
    );
  }

  return normalizeWhitespace(splitSentences(sceneText)[0] ?? sceneText).slice(0, 160);
}

function buildNarrativeEventDraft(scene: SceneRecord, claims: readonly ResolvedNarrativeClaim[]): NarrativeEventDraft {
  const primarySubject = claims.find(
    (claim) =>
      claim.status === "accepted" &&
      claim.subjectEntityId &&
      (claim.resolvedSubjectType === "self" || claim.resolvedSubjectType === "person")
  );
  const primaryLocation = claims.find(
    (claim) =>
      claim.status === "accepted" &&
      claim.objectEntityId &&
      claim.resolvedObjectType === "place"
  );

  return {
    eventKind: inferEventKind(scene.text, claims),
    eventLabel: buildEventLabel(scene.text, claims),
    timeExpressionText: scene.timeExpressionText,
    timeStart: scene.timeStart,
    timeEnd: scene.timeEnd,
    timeGranularity: scene.timeGranularity ?? "unknown",
    timeConfidence: scene.timeConfidence ?? 0.2,
    isRelativeTime: scene.isRelativeTime ?? false,
    primarySubjectEntityId: primarySubject?.subjectEntityId ?? null,
    primaryLocationEntityId: primaryLocation?.objectEntityId ?? null,
    metadata: {
      scene_kind: scene.sceneKind,
      anchor_basis: scene.anchorBasis ?? "fallback",
      anchor_scene_index: scene.anchorSceneIndex ?? null,
      anchor_confidence: scene.anchorConfidence ?? 0.2,
      accepted_claim_count: claims.filter((claim) => claim.status === "accepted").length,
      total_claim_count: claims.length,
      org_project_entity_ids: collectOrgProjectEntityIds(claims)
    }
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function predicateMatchesObjectType(
  predicate: string,
  objectType: EntityType | undefined,
  metadata?: Record<string, unknown>
): boolean {
  if (predicate === "from" || predicate === "lives_in" || predicate === "lived_in" || predicate === "currently_in") {
    return objectType === "place";
  }

  if (predicate === "works_at") {
    return objectType === "org" || objectType === "project";
  }

  if (predicate === "works_on") {
    return objectType === "project";
  }

  if (predicate === "runs" || predicate === "created_by") {
    return objectType === "project" || objectType === "org";
  }

  if (predicate === "member_of") {
    return objectType === "org";
  }

  if (predicate === "works_with" || predicate === "friend_of" || predicate === "with" || predicate === "hikes_with") {
    return objectType === "person" || objectType === "self";
  }

  if (predicate === "project_status" || predicate === "project_deadline" || predicate === "project_focus") {
    return typeof metadata?.project_key === "string";
  }

  return Boolean(objectType);
}

function computeClaimPrior(
  claim: ResolvedNarrativeClaim,
  scene: SceneRecord,
  event: NarrativeEventDraft
): PriorScore {
  let score = 0.15;
  const reasons: string[] = [];

  if (claim.status === "accepted") {
    score += 0.2;
    reasons.push("accepted_claim");
  } else if (claim.status === "pending") {
    score += 0.05;
    reasons.push("pending_claim");
  } else {
    score -= 0.15;
    reasons.push("abstained_or_rejected");
  }

  if (claim.subjectEntityId) {
    score += 0.15;
    reasons.push("resolved_subject");
  }

  if (claim.objectEntityId || claim.objectName) {
    score += 0.15;
    reasons.push("resolved_or_explicit_object");
  }

  if (predicateMatchesObjectType(claim.predicate, claim.resolvedObjectType, claim.metadata)) {
    score += 0.18;
    reasons.push("predicate_role_compatible");
  } else {
    score -= 0.08;
    reasons.push("predicate_role_weak");
  }

  if (scene.timeGranularity && scene.timeGranularity !== "unknown") {
    score += 0.07;
    reasons.push("scene_time_anchor");
  }

  if (event.timeGranularity !== "unknown") {
    score += 0.05;
    reasons.push("event_time_anchor");
  }

  if (claim.confidence >= 0.85) {
    score += 0.1;
    reasons.push("high_extractor_confidence");
  }

  if (!claim.subjectEntityId || (!claim.objectEntityId && !claim.objectName)) {
    score -= 0.05;
    reasons.push("partial_entity_resolution");
  }

  return {
    score: clampScore(score),
    reason: reasons.join(",")
  };
}

function computeRelationshipPrior(
  claim: ResolvedNarrativeClaim,
  scene: SceneRecord,
  event: NarrativeEventDraft,
  mergedIntoCluster: boolean,
  historicalPriorScore = 0
): PriorScore {
  const claimPrior = computeClaimPrior(claim, scene, event);
  let score = claimPrior.score * 0.7;
  const reasons = [claimPrior.reason, "event_co_membership"];

  if (mergedIntoCluster) {
    score += 0.08;
    reasons.push("cluster_continuity");
  }

  if (claim.subjectEntityId && claim.objectEntityId) {
    score += 0.12;
    reasons.push("resolved_edge_endpoints");
  }

  if (claim.resolvedSubjectType === "self" || claim.resolvedSubjectType === "person") {
    score += 0.05;
    reasons.push("human_subject");
  }

  if (scene.isRelativeTime && (scene.timeConfidence ?? 0) < 0.5) {
    score -= 0.05;
    reasons.push("weak_relative_time");
  }

  if (historicalPriorScore > 0) {
    score += Math.min(0.18, historicalPriorScore * 0.22);
    reasons.push("historical_graph_prior");
  }

  return {
    score: clampScore(score),
    reason: reasons.filter(Boolean).join(",")
  };
}

function lookupHistoricalPriorScore(
  priors: HistoricalPriorMap,
  subjectEntityId: string | null,
  objectEntityId: string | null
): number {
  if (!subjectEntityId || !objectEntityId) {
    return 0;
  }

  return priors.get(buildPriorPairKey(subjectEntityId, objectEntityId))?.score ?? 0;
}

function sameTimeBucket(left: NarrativeEventDraft, right: NarrativeEventDraft): boolean {
  if (
    left.timeGranularity === "unknown" ||
    right.timeGranularity === "unknown" ||
    !left.timeStart ||
    !right.timeStart
  ) {
    return false;
  }

  if (left.timeGranularity === "year" && right.timeGranularity === "year") {
    return left.timeStart.slice(0, 4) === right.timeStart.slice(0, 4);
  }

  if (left.timeGranularity === "month" && right.timeGranularity === "month") {
    return left.timeStart.slice(0, 7) === right.timeStart.slice(0, 7);
  }

  if (left.timeGranularity === "day" && right.timeGranularity === "day") {
    return left.timeStart.slice(0, 10) === right.timeStart.slice(0, 10);
  }

  return false;
}

function timesConflict(left: NarrativeEventDraft, right: NarrativeEventDraft): boolean {
  if (!left.timeStart || !right.timeStart) {
    return false;
  }

  if (left.timeGranularity === "unknown" || right.timeGranularity === "unknown") {
    return false;
  }

  if (sameTimeBucket(left, right)) {
    return false;
  }

  return !left.isRelativeTime && !right.isRelativeTime;
}

function collectOrgProjectEntityIds(claims: readonly ResolvedNarrativeClaim[]): string[] {
  return unique(
    claims
      .filter(
        (claim) =>
          claim.status === "accepted" &&
          claim.objectEntityId &&
          (claim.resolvedObjectType === "org" || claim.resolvedObjectType === "project")
      )
      .map((claim) => claim.objectEntityId as string)
  );
}

function buildClusterState(eventIndex: number, event: NarrativeEventDraft, claims: readonly ResolvedNarrativeClaim[]): EventClusterState {
  return {
    eventIndex,
    eventKind: event.eventKind,
    primarySubjectEntityId: event.primarySubjectEntityId ?? null,
    primaryLocationEntityId: event.primaryLocationEntityId ?? null,
    orgProjectEntityIds: collectOrgProjectEntityIds(claims),
    timeStart: event.timeStart,
    timeEnd: event.timeEnd,
    timeGranularity: event.timeGranularity
  };
}

function shouldMergeIntoCluster(cluster: EventClusterState | null, event: NarrativeEventDraft): boolean {
  if (!cluster) {
    return false;
  }

  if (cluster.eventKind !== event.eventKind) {
    return false;
  }

  const syntheticClusterEvent: NarrativeEventDraft = {
    eventKind: cluster.eventKind,
    eventLabel: "",
    timeStart: cluster.timeStart,
    timeEnd: cluster.timeEnd,
    timeGranularity: cluster.timeGranularity,
    timeConfidence: 0.5,
    isRelativeTime: cluster.timeGranularity === "relative_duration" || cluster.timeGranularity === "relative_recent",
    primarySubjectEntityId: cluster.primarySubjectEntityId ?? null,
    primaryLocationEntityId: cluster.primaryLocationEntityId ?? null,
    metadata: {}
  };

  if (timesConflict(syntheticClusterEvent, event)) {
    return false;
  }

  let anchorMatches = 0;

  if (cluster.primarySubjectEntityId && event.primarySubjectEntityId && cluster.primarySubjectEntityId === event.primarySubjectEntityId) {
    anchorMatches += 1;
  }

  if (cluster.primaryLocationEntityId && event.primaryLocationEntityId && cluster.primaryLocationEntityId === event.primaryLocationEntityId) {
    anchorMatches += 1;
  }

  const eventOrgProjectIds = new Set<string>(
    ((event.metadata.org_project_entity_ids as string[] | undefined) ?? []).filter(Boolean)
  );

  if (
    cluster.orgProjectEntityIds.some((entityId) => eventOrgProjectIds.has(entityId))
  ) {
    anchorMatches += 1;
  }

  if (sameTimeBucket(syntheticClusterEvent, event)) {
    anchorMatches += 1;
  }

  return anchorMatches >= 2;
}

function eventMemberRoleForEntityType(entityType: EntityType | undefined, position: "subject" | "object"): string {
  if (position === "subject" && (entityType === "self" || entityType === "person")) {
    return "subject";
  }

  if (entityType === "place") {
    return "location";
  }

  if (entityType === "org") {
    return "organization";
  }

  if (entityType === "project") {
    return "project";
  }

  return "participant";
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: EntityType,
  canonicalName: string,
  aliases: readonly string[] = [],
  metadata: Record<string, unknown> = {}
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
    throw new Error(`Failed to upsert entity ${canonicalName}`);
  }

  for (const alias of unique([canonicalName, ...aliases].map((value) => normalizeWhitespace(value)).filter(Boolean))) {
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
      [entityId, alias, normalizeName(alias), JSON.stringify({ source: "narrative_scene_claims" })]
    );
  }

  return entityId;
}

async function upsertNarrativeEvent(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly artifactId: string;
    readonly observationId: string;
    readonly eventIndex: number;
    readonly sourceSceneId: string;
    readonly event: NarrativeEventDraft;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO narrative_events (
        namespace_id,
        artifact_id,
        artifact_observation_id,
        event_index,
        source_scene_id,
        event_kind,
        event_label,
        time_expression_text,
        time_start,
        time_end,
        time_granularity,
        time_confidence,
        is_relative_time,
        anchor_basis,
        anchor_scene_id,
        anchor_confidence,
        primary_subject_entity_id,
        primary_location_entity_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
      ON CONFLICT (artifact_observation_id, event_index)
      DO UPDATE SET
        source_scene_id = EXCLUDED.source_scene_id,
        event_kind = EXCLUDED.event_kind,
        event_label = EXCLUDED.event_label,
        time_expression_text = EXCLUDED.time_expression_text,
        time_start = EXCLUDED.time_start,
        time_end = EXCLUDED.time_end,
        time_granularity = EXCLUDED.time_granularity,
        time_confidence = EXCLUDED.time_confidence,
        is_relative_time = EXCLUDED.is_relative_time,
        anchor_basis = EXCLUDED.anchor_basis,
        anchor_scene_id = EXCLUDED.anchor_scene_id,
        anchor_confidence = EXCLUDED.anchor_confidence,
        primary_subject_entity_id = EXCLUDED.primary_subject_entity_id,
        primary_location_entity_id = EXCLUDED.primary_location_entity_id,
        metadata = narrative_events.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      options.namespaceId,
      options.artifactId,
      options.observationId,
      options.eventIndex,
      options.sourceSceneId,
      options.event.eventKind,
      options.event.eventLabel,
      options.event.timeExpressionText ?? null,
      options.event.timeStart ?? null,
      options.event.timeEnd ?? null,
      options.event.timeGranularity,
      options.event.timeConfidence,
      options.event.isRelativeTime,
      typeof options.event.metadata.anchor_basis === "string" ? options.event.metadata.anchor_basis : "fallback",
      options.event.metadata.anchor_scene_id ?? null,
      typeof options.event.metadata.anchor_confidence === "number" ? options.event.metadata.anchor_confidence : 0.2,
      options.event.primarySubjectEntityId ?? null,
      options.event.primaryLocationEntityId ?? null,
      JSON.stringify(options.event.metadata)
    ]
  );

  const eventId = result.rows[0]?.id;
  if (!eventId) {
    throw new Error(`Failed to upsert narrative event ${options.eventIndex}`);
  }

  return eventId;
}

async function upsertNarrativeEventMember(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly eventId: string;
    readonly entityId: string;
    readonly memberRole: string;
    readonly confidence: number;
    readonly sourceSceneId: string;
    readonly sourceMemoryId: string | null;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO narrative_event_members (
        namespace_id,
        event_id,
        entity_id,
        member_role,
        confidence,
        source_scene_id,
        source_memory_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (event_id, entity_id, member_role, source_scene_id, source_memory_id)
      DO UPDATE SET
        confidence = GREATEST(narrative_event_members.confidence, EXCLUDED.confidence),
        metadata = narrative_event_members.metadata || EXCLUDED.metadata
    `,
    [
      options.namespaceId,
      options.eventId,
      options.entityId,
      options.memberRole,
      options.confidence,
      options.sourceSceneId,
      options.sourceMemoryId,
      JSON.stringify(options.metadata ?? {})
    ]
  );
}

async function ensurePlaceContainmentCandidate(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly childEntityId: string;
    readonly childName: string;
    readonly parentName: string;
    readonly sourceSceneId: string;
    readonly sourceEventId: string;
    readonly sourceMemoryId: string | null;
    readonly sourceChunkId: string | null;
    readonly occurredAt: string;
  }
): Promise<void> {
  const parentEntityId = await upsertEntity(client, options.namespaceId, "place", options.parentName, [], {
    extraction_method: "place_containment_seed"
  });

  await client.query(
    `
      INSERT INTO relationship_candidates (
        namespace_id,
        subject_entity_id,
        predicate,
        object_entity_id,
        source_scene_id,
        source_event_id,
        source_memory_id,
        source_chunk_id,
        confidence,
        prior_score,
        prior_reason,
        status,
        valid_from,
        metadata
      )
      VALUES ($1, $2, 'contained_in', $3, $4, $5, $6, $7, 0.98, 0.97, 'curated_place_containment', 'pending', $8, $9::jsonb)
      ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
      DO UPDATE SET
        confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
        prior_score = GREATEST(relationship_candidates.prior_score, EXCLUDED.prior_score),
        prior_reason = COALESCE(relationship_candidates.prior_reason, EXCLUDED.prior_reason),
        metadata = relationship_candidates.metadata || EXCLUDED.metadata
    `,
    [
      options.namespaceId,
      options.childEntityId,
      parentEntityId,
      options.sourceSceneId,
      options.sourceEventId,
      options.sourceMemoryId,
      options.sourceChunkId,
      options.occurredAt,
      JSON.stringify({
        extractor: "curated_place_containment",
        child_name: options.childName,
        parent_name: options.parentName
      })
    ]
  );
}

export async function stageNarrativeClaims(
  client: PoolClient,
  input: StageNarrativeClaimsInput
): Promise<StageNarrativeClaimsResult> {
  const selfName = await loadExistingSelfName(client, input.namespaceId);
  const namespaceAliases = await loadNamespacePersonAliases(client, input.namespaceId);
  const historicalPriors = await loadRelationshipPriors(client, input.namespaceId);
  let knownSelfName = selfName;
  let claimCount = 0;
  let relationshipCount = 0;
  let activeCluster: EventClusterState | null = null;
  let nextEventIndex = 0;
  const sceneIdByIndex = new Map<number, string>();

  if (selfName) {
    await upsertNamespaceSelfProfileForClient(client, {
      namespaceId: input.namespaceId,
      canonicalName: selfName,
      aliases: [selfName],
      note: "narrative_bootstrap"
    });
  }

  for (const scene of input.scenes) {
    const sceneSource = input.sceneSources.find((entry) => entry.sceneIndex === scene.sceneIndex);
    const sceneInsert = await client.query<{ id: string }>(
      `
        INSERT INTO narrative_scenes (
          namespace_id,
          artifact_id,
          artifact_observation_id,
          scene_index,
          scene_kind,
          scene_text,
          occurred_at,
          captured_at,
          time_expression_text,
          time_start,
          time_end,
          time_granularity,
          time_confidence,
          is_relative_time,
          anchor_basis,
          anchor_scene_id,
          anchor_confidence,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
        ON CONFLICT (artifact_observation_id, scene_index)
        DO UPDATE SET
          scene_text = EXCLUDED.scene_text,
          occurred_at = EXCLUDED.occurred_at,
          captured_at = EXCLUDED.captured_at,
          time_expression_text = EXCLUDED.time_expression_text,
          time_start = EXCLUDED.time_start,
          time_end = EXCLUDED.time_end,
          time_granularity = EXCLUDED.time_granularity,
          time_confidence = EXCLUDED.time_confidence,
          is_relative_time = EXCLUDED.is_relative_time,
          anchor_basis = EXCLUDED.anchor_basis,
          anchor_scene_id = EXCLUDED.anchor_scene_id,
          anchor_confidence = EXCLUDED.anchor_confidence,
          metadata = narrative_scenes.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING id
      `,
      [
        input.namespaceId,
        input.artifactId,
        input.observationId,
        scene.sceneIndex,
        scene.sceneKind,
        scene.text,
        scene.occurredAt,
        input.capturedAt,
        scene.timeExpressionText ?? null,
        scene.timeStart ?? null,
        scene.timeEnd ?? null,
        scene.timeGranularity ?? "unknown",
        scene.timeConfidence ?? 0.2,
        scene.isRelativeTime ?? false,
        scene.anchorBasis ?? "fallback",
        scene.anchorSceneIndex !== undefined ? sceneIdByIndex.get(scene.anchorSceneIndex) ?? null : null,
        scene.anchorConfidence ?? 0.2,
        JSON.stringify({
          fragment_count: sceneSource?.sourceMemoryIds.length ?? 0,
          extraction_method: "deterministic_scene_claims",
          source_memory_ids: sceneSource?.sourceMemoryIds ?? [],
          source_chunk_ids: sceneSource?.sourceChunkIds ?? []
        })
      ]
    );

    const sceneId = sceneInsert.rows[0]?.id;
    if (!sceneId) {
      throw new Error(`Failed to insert scene ${scene.sceneIndex}`);
    }
    sceneIdByIndex.set(scene.sceneIndex, sceneId);

    const { claims, aliases } = extractClaimsFromScene(scene.text, knownSelfName, namespaceAliases);
    const resolvedClaims: ResolvedNarrativeClaim[] = [];

    for (const claim of claims) {
      const normalizedKnownSelf = knownSelfName ? normalizeName(knownSelfName) : null;
      const normalizedSubject = claim.subjectName ? normalizeName(claim.subjectName) : null;
      const normalizedObject = claim.objectName ? normalizeName(claim.objectName) : null;
      const subjectType =
        normalizedKnownSelf && normalizedSubject === normalizedKnownSelf ? "self" : claim.subjectType;
      const objectType =
        normalizedKnownSelf && normalizedObject === normalizedKnownSelf ? "self" : claim.objectType;
      const aliasList = [...aliases.entries()]
        .filter(([, canonical]) => canonical === claim.subjectName || canonical === claim.objectName)
        .map(([alias]) => alias)
        .filter(Boolean)
        .map((alias) => titleCase(alias));
      const subjectAmbiguousMatches =
        subjectType === "person" && claim.subjectName
          ? KINSHIP_TERMS.has(normalizeName(claim.subjectName))
            ? [claim.subjectName]
            : shouldAbstainPersonResolution(claim.subjectName, namespaceAliases)
          : [];
      const objectAmbiguousMatches =
        objectType === "person" && claim.objectName
          ? KINSHIP_TERMS.has(normalizeName(claim.objectName))
            ? [claim.objectName]
            : shouldAbstainPersonResolution(claim.objectName, namespaceAliases)
          : [];

      const subjectEntityId =
        claim.subjectName && subjectType
          ? subjectType === "person" && subjectAmbiguousMatches.length > 0
            ? null
            : await upsertEntity(client, input.namespaceId, subjectType, claim.subjectName, aliasList, {
                extraction_method: "deterministic_scene_claims"
              })
          : null;

      const objectEntityId =
        claim.objectName && objectType
          ? objectType === "person" && objectAmbiguousMatches.length > 0
            ? null
            : objectType === "place" && isVaguePlaceReference(claim.objectName)
              ? null
              : await upsertEntity(client, input.namespaceId, objectType, claim.objectName, objectType === "person" ? aliasList : [], {
                  extraction_method: "deterministic_scene_claims"
                })
          : null;

      if (subjectType === "self" && claim.subjectName) {
        knownSelfName = claim.subjectName;
        namespaceAliases.set(normalizeName(claim.subjectName), claim.subjectName);
        await upsertNamespaceSelfProfileForClient(client, {
          namespaceId: input.namespaceId,
          canonicalName: claim.subjectName,
          aliases: [claim.subjectName],
          note: "narrative_identity_claim"
        });
      }

      if (subjectType === "person" && claim.subjectName && subjectEntityId) {
        namespaceAliases.set(normalizeName(claim.subjectName), claim.subjectName);
        for (const alias of aliasList) {
          namespaceAliases.set(normalizeName(alias), claim.subjectName);
        }
      }

      if (objectType === "person" && claim.objectName && objectEntityId) {
        namespaceAliases.set(normalizeName(claim.objectName), claim.objectName);
        for (const alias of aliasList) {
          namespaceAliases.set(normalizeName(alias), claim.objectName);
        }
      }

      const ambiguity = classifyAmbiguity(
        {
          ...claim,
          metadata: {
            ...(claim.metadata ?? {}),
            subject_suggested_matches: subjectAmbiguousMatches,
            object_suggested_matches: objectAmbiguousMatches
          },
          subjectEntityId,
          objectEntityId,
          resolvedSubjectType: subjectType,
          resolvedObjectType: objectType
        },
        namespaceAliases
      );
      const claimStatus = ambiguity ? "abstained" : claim.status;

      resolvedClaims.push({
        ...claim,
        status: claimStatus,
        metadata: {
          ...(claim.metadata ?? {}),
          ...(ambiguity
            ? {
                ambiguity_state: ambiguity.state,
                ambiguity_type: ambiguity.type,
                ambiguity_reason: ambiguity.reason,
                ambiguity_target_role: ambiguity.targetRole,
                suggested_matches: ambiguity.suggestedMatches,
                raw_ambiguous_text: ambiguity.rawText
              }
            : {})
        },
        subjectEntityId,
        objectEntityId,
        resolvedSubjectType: subjectType,
        resolvedObjectType: objectType
      });
    }

    const narrativeEventBase = buildNarrativeEventDraft(scene, resolvedClaims);
    const narrativeEvent = {
      ...narrativeEventBase,
      metadata: {
        ...narrativeEventBase.metadata,
        anchor_scene_id: scene.anchorSceneIndex !== undefined ? sceneIdByIndex.get(scene.anchorSceneIndex) ?? null : null
      }
    };
    const mergeIntoCluster = shouldMergeIntoCluster(activeCluster, narrativeEvent);
    const eventIndex: number = mergeIntoCluster && activeCluster ? activeCluster.eventIndex : nextEventIndex++;
    const eventId = await upsertNarrativeEvent(client, {
      namespaceId: input.namespaceId,
      artifactId: input.artifactId,
      observationId: input.observationId,
      eventIndex,
      sourceSceneId: sceneId,
      event: narrativeEvent
    });

    const nextClusterState = buildClusterState(eventIndex, narrativeEvent, resolvedClaims);
    activeCluster =
      mergeIntoCluster && activeCluster
        ? {
            eventIndex,
            eventKind: nextClusterState.eventKind,
            primarySubjectEntityId: nextClusterState.primarySubjectEntityId ?? activeCluster.primarySubjectEntityId,
            primaryLocationEntityId: nextClusterState.primaryLocationEntityId ?? activeCluster.primaryLocationEntityId,
            orgProjectEntityIds: unique([...activeCluster.orgProjectEntityIds, ...nextClusterState.orgProjectEntityIds]),
            timeStart: nextClusterState.timeStart ?? activeCluster.timeStart,
            timeEnd: nextClusterState.timeEnd ?? activeCluster.timeEnd,
            timeGranularity:
              nextClusterState.timeGranularity !== "unknown"
                ? nextClusterState.timeGranularity
                : activeCluster.timeGranularity
          }
        : nextClusterState;

    await client.query(
      `
        UPDATE narrative_scenes
        SET source_event_id = $2
        WHERE id = $1
      `,
      [sceneId, eventId]
    );

    for (const claim of resolvedClaims) {
      const subjectEntityId = claim.subjectEntityId;
      const objectEntityId = claim.objectEntityId;
      const subjectType = claim.resolvedSubjectType;
      const objectType = claim.resolvedObjectType;

      const claimPrior = computeClaimPrior(claim, scene, narrativeEvent);

      await client.query(
        `
          INSERT INTO claim_candidates (
            namespace_id,
            source_scene_id,
            source_event_id,
            source_memory_id,
            source_chunk_id,
            subject_entity_id,
            object_entity_id,
            claim_type,
            subject_text,
            subject_entity_type,
            predicate,
            object_text,
            object_entity_type,
            normalized_text,
            confidence,
            prior_score,
            prior_reason,
            status,
            ambiguity_state,
            ambiguity_type,
            ambiguity_reason,
            occurred_at,
            time_expression_text,
            time_start,
            time_end,
            time_granularity,
            time_confidence,
            is_relative_time,
            anchor_basis,
            anchor_scene_id,
            anchor_confidence,
            extraction_method,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, 'deterministic_scene_claims', $32::jsonb)
        `,
        [
          input.namespaceId,
          sceneId,
          eventId,
          sceneSource?.sourceMemoryIds[0] ?? null,
          sceneSource?.sourceChunkIds[0] ?? null,
          subjectEntityId,
          objectEntityId,
          claim.claimType,
          claim.subjectName ?? null,
          subjectType ?? null,
          claim.predicate,
          claim.objectName ?? null,
          objectType ?? null,
          normalizeWhitespace(
            [claim.subjectName ?? "", claim.predicate, claim.objectName ?? ""].filter(Boolean).join(" ")
          ),
          claim.confidence,
          claimPrior.score,
          claimPrior.reason,
          claim.status,
          typeof claim.metadata?.ambiguity_state === "string" ? claim.metadata.ambiguity_state : "none",
          typeof claim.metadata?.ambiguity_type === "string" ? claim.metadata.ambiguity_type : null,
          typeof claim.metadata?.ambiguity_reason === "string" ? claim.metadata.ambiguity_reason : null,
          scene.occurredAt,
          scene.timeExpressionText ?? null,
          scene.timeStart ?? null,
          scene.timeEnd ?? null,
          scene.timeGranularity ?? "unknown",
          scene.timeConfidence ?? 0.2,
          scene.isRelativeTime ?? false,
          scene.anchorBasis ?? "fallback",
          scene.anchorSceneIndex !== undefined ? sceneIdByIndex.get(scene.anchorSceneIndex) ?? null : null,
          scene.anchorConfidence ?? 0.2,
          JSON.stringify({
            ...(claim.metadata ?? {}),
            prior_score: claimPrior.score,
            prior_reason: claimPrior.reason,
            source_event_id: eventId,
            cluster_event_index: eventIndex
          })
        ]
      );
      claimCount += 1;

      if (subjectEntityId) {
        await client.query(
          `
            INSERT INTO memory_entity_mentions (
              namespace_id,
              entity_id,
              source_scene_id,
              source_memory_id,
              source_chunk_id,
              mention_text,
              mention_role,
              confidence,
              occurred_at,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'subject', $7, $8, $9::jsonb)
            ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
            DO UPDATE SET
              confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
              metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            subjectEntityId,
            sceneId,
            sceneSource?.sourceMemoryIds[0] ?? null,
            sceneSource?.sourceChunkIds[0] ?? null,
            claim.subjectName ?? "",
            claim.confidence,
            scene.occurredAt,
            JSON.stringify({ extractor: "deterministic_scene_claims", entity_type: claim.subjectType ?? null })
          ]
        );

        await upsertNarrativeEventMember(client, {
          namespaceId: input.namespaceId,
          eventId,
          entityId: subjectEntityId,
          memberRole: eventMemberRoleForEntityType(subjectType, "subject"),
          confidence: claim.confidence,
          sourceSceneId: sceneId,
          sourceMemoryId: sceneSource?.sourceMemoryIds[0] ?? null,
          metadata: {
            extractor: "deterministic_scene_claims",
            predicate: claim.predicate
          }
        });
      }

      if (objectEntityId && claim.objectName) {
        await client.query(
          `
            INSERT INTO memory_entity_mentions (
              namespace_id,
              entity_id,
              source_scene_id,
              source_memory_id,
              source_chunk_id,
              mention_text,
              mention_role,
              confidence,
              occurred_at,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
            DO UPDATE SET
              confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
              metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            objectEntityId,
            sceneId,
            sceneSource?.sourceMemoryIds[0] ?? null,
            sceneSource?.sourceChunkIds[0] ?? null,
            claim.objectName,
            objectType === "place" ? "location" : objectType === "project" ? "project" : objectType === "org" ? "organization" : "participant",
            claim.confidence,
            scene.occurredAt,
            JSON.stringify({ extractor: "deterministic_scene_claims", entity_type: objectType ?? null })
          ]
        );

        await upsertNarrativeEventMember(client, {
          namespaceId: input.namespaceId,
          eventId,
          entityId: objectEntityId,
          memberRole: eventMemberRoleForEntityType(objectType, "object"),
          confidence: claim.confidence,
          sourceSceneId: sceneId,
          sourceMemoryId: sceneSource?.sourceMemoryIds[0] ?? null,
          metadata: {
            extractor: "deterministic_scene_claims",
            predicate: claim.predicate
          }
        });

        if (objectType === "place") {
          const parentPlace = PLACE_CONTAINMENT.get(claim.objectName);
          if (parentPlace && parentPlace !== claim.objectName) {
            await ensurePlaceContainmentCandidate(client, {
              namespaceId: input.namespaceId,
              childEntityId: objectEntityId,
              childName: claim.objectName,
              parentName: parentPlace,
              sourceSceneId: sceneId,
              sourceEventId: eventId,
              sourceMemoryId: sceneSource?.sourceMemoryIds[0] ?? null,
              sourceChunkId: sceneSource?.sourceChunkIds[0] ?? null,
              occurredAt: scene.occurredAt
            });
          }
        }
      }

      if (
        claim.status === "accepted" &&
        subjectEntityId &&
        objectEntityId &&
        claim.objectName &&
        ["friend_of", "with", "from", "lives_in", "lived_in", "currently_in", "runs", "works_at", "works_on", "works_with", "hikes_with", "member_of", "created_by"].includes(
          claim.predicate
        )
      ) {
        const relationshipPrior = computeRelationshipPrior(
          claim,
          scene,
          narrativeEvent,
          mergeIntoCluster,
          lookupHistoricalPriorScore(historicalPriors, subjectEntityId, objectEntityId)
        );
        await client.query(
          `
            INSERT INTO relationship_candidates (
              namespace_id,
              subject_entity_id,
              predicate,
              object_entity_id,
              source_scene_id,
              source_event_id,
              source_memory_id,
              source_chunk_id,
              confidence,
              prior_score,
              prior_reason,
              status,
              valid_from,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13::jsonb)
            ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
            DO UPDATE SET
              confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
              prior_score = GREATEST(relationship_candidates.prior_score, EXCLUDED.prior_score),
              prior_reason = COALESCE(relationship_candidates.prior_reason, EXCLUDED.prior_reason),
              metadata = relationship_candidates.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            subjectEntityId,
            claim.predicate,
            objectEntityId,
            sceneId,
            eventId,
            sceneSource?.sourceMemoryIds[0] ?? null,
            sceneSource?.sourceChunkIds[0] ?? null,
            claim.confidence,
            relationshipPrior.score,
            relationshipPrior.reason,
            scene.occurredAt,
            JSON.stringify({
              extractor: "deterministic_scene_claims",
              claim_type: claim.claimType,
              source_event_id: eventId,
              prior_score: relationshipPrior.score,
              prior_reason: relationshipPrior.reason,
              cluster_event_index: eventIndex,
              event_kind: narrativeEvent.eventKind,
              event_label: narrativeEvent.eventLabel,
              ...claim.metadata
            })
          ]
        );
        relationshipCount += 1;
      }

      if (
        claim.status === "accepted" &&
        claim.claimType === "employment" &&
        claim.subjectName &&
        claim.objectName &&
        sceneSource?.sourceMemoryIds[0]
      ) {
        await client.query(
          `
            INSERT INTO memory_candidates (
              namespace_id,
              source_scene_id,
              source_memory_id,
              source_chunk_id,
              source_artifact_observation_id,
              candidate_type,
              content,
              confidence,
              canonical_key,
              normalized_value,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, 'semantic_note', $6, $7, $8, $9::jsonb, $10::jsonb)
            ON CONFLICT (source_memory_id, source_chunk_id, candidate_type, content)
            DO NOTHING
          `,
          [
            input.namespaceId,
            sceneId,
            sceneSource.sourceMemoryIds[0],
            sceneSource.sourceChunkIds[0] ?? null,
            input.observationId,
            `${claim.subjectName} ${claim.predicate.replaceAll("_", " ")} ${claim.objectName}`,
            claim.confidence,
            `${normalizeName(claim.subjectName)}:${claim.predicate}`,
            JSON.stringify({
              subject: claim.subjectName,
              predicate: claim.predicate,
              object: claim.objectName,
              role: claim.metadata?.role ?? null
            }),
            JSON.stringify({
              extractor: "deterministic_scene_claims",
              scene_id: sceneId,
              event_id: eventId
            })
          ]
        );
      }
    }
  }

  return {
    sceneCount: input.scenes.length,
    claimCount,
    relationshipCount
  };
}
