import type { PoolClient } from "pg";

type EntityType = "self" | "person" | "place" | "project" | "decision" | "constraint" | "routine" | "style_spec" | "goal" | "plan" | "concept" | "unknown";
type MentionRole = "subject" | "participant" | "location" | "project" | "mentioned";

interface EntityMentionCandidate {
  readonly entityType: EntityType;
  readonly canonicalName: string;
  readonly mentionText: string;
  readonly mentionRole: MentionRole;
  readonly confidence: number;
}

interface RelationshipCandidateInput {
  readonly subjectName: string;
  readonly subjectType: EntityType;
  readonly predicate: string;
  readonly objectName: string;
  readonly objectType: EntityType;
  readonly confidence: number;
}

const PLACE_NAMES = new Map<string, string>([
  ["japan", "Japan"],
  ["tokyo", "Tokyo"],
  ["kyoto", "Kyoto"],
  ["osaka", "Osaka"],
  ["bangkok", "Bangkok"],
  ["san francisco", "San Francisco"],
  ["new york", "New York"]
]);

const STOP_PERSON_TOKENS = new Set([
  "I",
  "In",
  "The",
  "They",
  "Three",
  "Project",
  "Brain",
  "June",
  "January",
  "February",
  "March",
  "April",
  "May",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Japan",
  "Tokyo",
  "Kyoto",
  "Osaka"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

function splitNameList(value: string): string[] {
  return value
    .split(/\s*(?:,|and)\s*/iu)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function extractPlaces(text: string): EntityMentionCandidate[] {
  const mentions: EntityMentionCandidate[] = [];
  const lowered = text.toLowerCase();

  for (const [needle, canonical] of PLACE_NAMES.entries()) {
    if (!lowered.includes(needle)) {
      continue;
    }

    mentions.push({
      entityType: "place",
      canonicalName: canonical,
      mentionText: canonical,
      mentionRole: "location",
      confidence: 0.92
    });
  }

  return mentions;
}

function extractProjects(text: string): EntityMentionCandidate[] {
  const matches = text.matchAll(/\bProject\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*)*)/gu);
  const mentions: EntityMentionCandidate[] = [];

  for (const match of matches) {
    const projectName = normalizeWhitespace(match[1] ?? "");
    if (!projectName) {
      continue;
    }

    mentions.push({
      entityType: "project",
      canonicalName: projectName,
      mentionText: projectName,
      mentionRole: "project",
      confidence: 0.72
    });
  }

  return mentions;
}

function extractPeople(text: string): EntityMentionCandidate[] {
  const mentions: EntityMentionCandidate[] = [];
  const properNameMatches = text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/gu);

  for (const match of properNameMatches) {
    const name = normalizeWhitespace(match[0] ?? "");
    const tokens = name.split(/\s+/u);

    if (
      !name ||
      name.length < 3 ||
      tokens.length > 3 ||
      STOP_PERSON_TOKENS.has(name) ||
      tokens.some((token) => STOP_PERSON_TOKENS.has(token)) ||
      PLACE_NAMES.has(name.toLowerCase())
    ) {
      continue;
    }

    mentions.push({
      entityType: "person",
      canonicalName: name,
      mentionText: name,
      mentionRole: "mentioned",
      confidence: 0.7
    });
  }

  return mentions;
}

function deriveRoles(text: string, mentions: EntityMentionCandidate[]): EntityMentionCandidate[] {
  const people = mentions.filter((mention) => mention.entityType === "person");
  const primarySubject = people[0]?.canonicalName;
  const participantNames = new Set<string>();
  const withMatches = text.matchAll(
    /\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s*(?:,|and)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)*)/gu
  );

  for (const match of withMatches) {
    const rawNames = match[1] ?? "";
    for (const name of splitNameList(rawNames)) {
      participantNames.add(name);
    }
  }

  return mentions.map((mention) => {
    if (mention.entityType === "place" || mention.entityType === "project") {
      return mention;
    }

    if (mention.canonicalName === primarySubject) {
      return {
        ...mention,
        mentionRole: "subject",
        confidence: Math.max(mention.confidence, 0.82)
      };
    }

    if (participantNames.has(mention.canonicalName)) {
      return {
        ...mention,
        mentionRole: "participant",
        confidence: Math.max(mention.confidence, 0.86)
      };
    }

    return mention;
  });
}

function dedupeMentions(mentions: EntityMentionCandidate[]): EntityMentionCandidate[] {
  const seen = new Map<string, EntityMentionCandidate>();

  for (const mention of mentions) {
    const key = `${mention.entityType}:${normalizeName(mention.canonicalName)}:${mention.mentionRole}`;
    const existing = seen.get(key);
    if (!existing || existing.confidence < mention.confidence) {
      seen.set(key, mention);
    }
  }

  return [...seen.values()];
}

function extractRelationshipCandidates(mentions: EntityMentionCandidate[]): RelationshipCandidateInput[] {
  const people = mentions.filter((mention) => mention.entityType === "person");
  const places = mentions.filter((mention) => mention.entityType === "place");
  const projects = mentions.filter((mention) => mention.entityType === "project");
  const subject = people.find((mention) => mention.mentionRole === "subject") ?? people[0];
  const relationships: RelationshipCandidateInput[] = [];

  if (subject) {
    for (const participant of people) {
      if (participant.canonicalName === subject.canonicalName) {
        continue;
      }

      relationships.push({
        subjectName: subject.canonicalName,
        subjectType: subject.entityType,
        predicate: "with",
        objectName: participant.canonicalName,
        objectType: participant.entityType,
        confidence: 0.82
      });
    }

    for (const place of places) {
      relationships.push({
        subjectName: subject.canonicalName,
        subjectType: subject.entityType,
        predicate: "visited",
        objectName: place.canonicalName,
        objectType: place.entityType,
        confidence: 0.74
      });
    }

    for (const project of projects) {
      relationships.push({
        subjectName: subject.canonicalName,
        subjectType: subject.entityType,
        predicate: "works_on",
        objectName: project.canonicalName,
        objectType: project.entityType,
        confidence: 0.65
      });
    }
  }

  return relationships;
}

async function upsertEntity(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly entityType: EntityType;
    readonly canonicalName: string;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<{ readonly id: string; readonly canonicalName: string }> {
  const canonicalName = normalizeWhitespace(options.canonicalName);
  const normalizedName = normalizeName(canonicalName);

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
    [options.namespaceId, options.entityType, canonicalName, normalizedName, JSON.stringify(options.metadata ?? {})]
  );

  const entityId = result.rows[0]?.id;
  if (!entityId) {
    throw new Error(`Failed to upsert entity: ${canonicalName}`);
  }

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
    [entityId, canonicalName, normalizedName, JSON.stringify({ source: "heuristic_ingest" })]
  );

  return {
    id: entityId,
    canonicalName
  };
}

export async function stageEntityGraph(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly sourceMemoryId: string;
    readonly sourceChunkId: string;
    readonly occurredAt: string;
    readonly content: string;
  }
): Promise<{
  readonly entityCount: number;
  readonly relationshipCount: number;
}> {
  const mentions = dedupeMentions(
    deriveRoles(options.content, [
      ...extractPlaces(options.content),
      ...extractProjects(options.content),
      ...extractPeople(options.content)
    ])
  );

  if (mentions.length === 0) {
    return {
      entityCount: 0,
      relationshipCount: 0
    };
  }

  const entityIds = new Map<string, string>();
  let entityCount = 0;

  for (const mention of mentions) {
    const entity = await upsertEntity(client, {
      namespaceId: options.namespaceId,
      entityType: mention.entityType,
      canonicalName: mention.canonicalName,
      metadata: {
        first_mention_role: mention.mentionRole
      }
    });

    entityIds.set(`${mention.entityType}:${normalizeName(mention.canonicalName)}`, entity.id);

    await client.query(
      `
        INSERT INTO memory_entity_mentions (
          namespace_id,
          entity_id,
          source_memory_id,
          source_chunk_id,
          mention_text,
          mention_role,
          confidence,
          occurred_at,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
        DO UPDATE SET
          mention_role = EXCLUDED.mention_role,
          confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
          metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
      `,
      [
        options.namespaceId,
        entity.id,
        options.sourceMemoryId,
        options.sourceChunkId,
        mention.mentionText,
        mention.mentionRole,
        mention.confidence,
        options.occurredAt,
        JSON.stringify({
          extractor: "heuristic_ingest",
          entity_type: mention.entityType
        })
      ]
    );

    entityCount += 1;
  }

  const relationships = extractRelationshipCandidates(mentions);
  let relationshipCount = 0;

  for (const relationship of relationships) {
    const subjectEntityId = entityIds.get(`${relationship.subjectType}:${normalizeName(relationship.subjectName)}`);
    const objectEntityId = entityIds.get(`${relationship.objectType}:${normalizeName(relationship.objectName)}`);

    if (!subjectEntityId || !objectEntityId) {
      continue;
    }

    await client.query(
      `
        INSERT INTO relationship_candidates (
          namespace_id,
          subject_entity_id,
          predicate,
          object_entity_id,
          source_memory_id,
          source_chunk_id,
          confidence,
          status,
          valid_from,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9::jsonb)
        ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
        DO UPDATE SET
          confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
          metadata = relationship_candidates.metadata || EXCLUDED.metadata
      `,
      [
        options.namespaceId,
        subjectEntityId,
        relationship.predicate,
        objectEntityId,
        options.sourceMemoryId,
        options.sourceChunkId,
        relationship.confidence,
        options.occurredAt,
        JSON.stringify({
          extractor: "heuristic_ingest"
        })
      ]
    );

    relationshipCount += 1;
  }

  return {
    entityCount,
    relationshipCount
  };
}
