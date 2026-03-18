import type { PoolClient } from "pg";
import type { SceneRecord } from "../types.js";

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
  ["vietnam", "Vietnam"]
]);

const STOP_PERSON_NAMES = new Set([
  "He",
  "She",
  "They",
  "I",
  "We",
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

async function loadExistingSelfName(client: PoolClient, namespaceId: string): Promise<string | null> {
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

async function loadNamespacePersonAliases(client: PoolClient, namespaceId: string): Promise<Map<string, string>> {
  const result = await client.query<{ alias: string; canonical_name: string }>(
    `
      SELECT ea.alias, e.canonical_name
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('self', 'person')
    `,
    [namespaceId]
  );

  const aliases = new Map<string, string>();
  for (const row of result.rows) {
    aliases.set(normalizeName(row.alias), row.canonical_name);
  }

  return aliases;
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

  return titleCase(cleaned);
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
    const selfMatch = sentenceText.match(/\bmy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu);
    if (selfMatch) {
      resolvedSelfName = normalizeWhitespace(selfMatch[1] ?? "");
    }

    const sentencePeople = extractExplicitPeople(sentenceText, aliasPairs).map((name) =>
      resolvePersonName(name, aliasMap, resolvedSelfName, explicitPeople)
    );
    const explicitSubject = sentencePeople.find(Boolean);
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

    if (subject && /\b(?:I|He|She|They|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:live|lives|living)\s+(?:out here too|in)\b/u.test(sentenceText)) {
      const placeMentions = unique(
        [...PLACE_NAMES.values()].filter((place) => new RegExp(`\\b${place.replace(/\s+/gu, "\\s+")}\\b`, "iu").test(sentenceText))
      );

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

    const fromMatch = sentenceText.match(/^(?:((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She|They))\b.*?\bis\s+from\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u);
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

    const passportMatch = sentenceText.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\b([A-Z][A-Za-z]+)\s+passport\b/u);
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

    const pilotForMatch = sentenceText.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bpilot\s+for\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.&-]+){0,3})\b/u);
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

    const companyMatch = sentenceText.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bruns\s+(?:a\s+company\s+called\s+)?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9.&-]+){0,4})\b/u);
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

    const livedPlacesMatch = sentenceText.match(/\b((?!(?:He|She|They)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+has\s+lived\s+in\s+([A-Z][A-Za-z]+)(?:\s+and\s+([A-Z][A-Za-z]+))?\b/u);
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

    const currentlyInMatch = sentenceText.match(/^(?:((?!(?:He|She)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})|(He|She))\b.*?\bis\s+currently\s+in\s+([A-Z][A-Za-z]+(?:,\s*[A-Z][A-Za-z]+)?(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
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

export async function stageNarrativeClaims(
  client: PoolClient,
  input: StageNarrativeClaimsInput
): Promise<StageNarrativeClaimsResult> {
  const selfName = await loadExistingSelfName(client, input.namespaceId);
  const namespaceAliases = await loadNamespacePersonAliases(client, input.namespaceId);
  let knownSelfName = selfName;
  let claimCount = 0;
  let relationshipCount = 0;

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
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (artifact_observation_id, scene_index)
        DO UPDATE SET
          scene_text = EXCLUDED.scene_text,
          occurred_at = EXCLUDED.occurred_at,
          captured_at = EXCLUDED.captured_at,
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
        JSON.stringify({
          fragment_count: sceneSource?.sourceMemoryIds.length ?? 0,
          extraction_method: "deterministic_scene_claims"
        })
      ]
    );

    const sceneId = sceneInsert.rows[0]?.id;
    if (!sceneId) {
      throw new Error(`Failed to insert scene ${scene.sceneIndex}`);
    }

    const { claims, aliases } = extractClaimsFromScene(scene.text, knownSelfName, namespaceAliases);
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

      const subjectEntityId =
        claim.subjectName && subjectType
          ? await upsertEntity(client, input.namespaceId, subjectType, claim.subjectName, aliasList, {
              extraction_method: "deterministic_scene_claims"
            })
          : null;

      const objectEntityId =
        claim.objectName && objectType
          ? await upsertEntity(client, input.namespaceId, objectType, claim.objectName, objectType === "person" ? aliasList : [], {
              extraction_method: "deterministic_scene_claims"
            })
          : null;

      if (subjectType === "self" && claim.subjectName) {
        knownSelfName = claim.subjectName;
        namespaceAliases.set(normalizeName(claim.subjectName), claim.subjectName);
      }

      if (subjectType === "person" && claim.subjectName) {
        namespaceAliases.set(normalizeName(claim.subjectName), claim.subjectName);
        for (const alias of aliasList) {
          namespaceAliases.set(normalizeName(alias), claim.subjectName);
        }
      }

      if (objectType === "person" && claim.objectName) {
        namespaceAliases.set(normalizeName(claim.objectName), claim.objectName);
        for (const alias of aliasList) {
          namespaceAliases.set(normalizeName(alias), claim.objectName);
        }
      }

      await client.query(
        `
          INSERT INTO claim_candidates (
            namespace_id,
            source_scene_id,
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
            status,
            occurred_at,
            extraction_method,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'deterministic_scene_claims', $17::jsonb)
        `,
        [
          input.namespaceId,
          sceneId,
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
          claim.status,
          scene.occurredAt,
          JSON.stringify(claim.metadata ?? {})
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
            objectType === "place" ? "location" : objectType === "project" ? "project" : "participant",
            claim.confidence,
            scene.occurredAt,
            JSON.stringify({ extractor: "deterministic_scene_claims", entity_type: objectType ?? null })
          ]
        );
      }

      if (
        claim.status === "accepted" &&
        subjectEntityId &&
        objectEntityId &&
        claim.objectName &&
        ["friend_of", "with", "from", "lives_in", "lived_in", "currently_in", "runs", "works_at", "works_with", "hikes_with"].includes(
          claim.predicate
        )
      ) {
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
              status,
              valid_from,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10::jsonb)
            ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
            DO UPDATE SET
              confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
              metadata = relationship_candidates.metadata || EXCLUDED.metadata
          `,
          [
            input.namespaceId,
            subjectEntityId,
            claim.predicate,
            objectEntityId,
            sceneId,
            sceneSource?.sourceMemoryIds[0] ?? null,
            sceneSource?.sourceChunkIds[0] ?? null,
            claim.confidence,
            scene.occurredAt,
            JSON.stringify({
              extractor: "deterministic_scene_claims",
              claim_type: claim.claimType,
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
              scene_id: sceneId
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
