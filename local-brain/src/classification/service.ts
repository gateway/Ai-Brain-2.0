import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";

type BrainEntityType = "self" | "person" | "place" | "org" | "project" | "concept" | "unknown";
type MentionRole = "subject" | "participant" | "location" | "organization" | "project" | "mentioned";
type BrainAmbiguityType =
  | "possible_misspelling"
  | "undefined_kinship"
  | "vague_place"
  | "alias_collision"
  | "unknown_reference"
  | "asr_correction"
  | "kinship_resolution"
  | "place_grounding";

interface EntityPacket {
  readonly name: string;
  readonly entity_type?: string;
  readonly aliases?: readonly string[];
  readonly confidence?: number;
  readonly role?: string;
}

interface RelationshipPacket {
  readonly subject: string;
  readonly subject_type?: string;
  readonly predicate: string;
  readonly object: string;
  readonly object_type?: string;
  readonly confidence?: number;
  readonly time_expression_text?: string;
  readonly valid_from?: string;
  readonly valid_until?: string;
  readonly ambiguity_type?: string;
  readonly ambiguity_reason?: string;
}

interface ClaimPacket {
  readonly candidate_type?: string;
  readonly claim_type?: string;
  readonly content: string;
  readonly subject?: string;
  readonly subject_type?: string;
  readonly predicate?: string;
  readonly object?: string;
  readonly object_type?: string;
  readonly confidence?: number;
  readonly time_expression_text?: string;
  readonly ambiguity_type?: string;
  readonly ambiguity_reason?: string;
}

interface AmbiguityPacket {
  readonly text: string;
  readonly ambiguity_type?: string;
  readonly reason?: string;
  readonly entity_type?: string;
  readonly suggestions?: readonly string[];
}

interface TripartiteHints {
  readonly episodic_hints?: readonly string[];
  readonly semantic_hints?: readonly string[];
  readonly procedural_hints?: readonly {
    readonly state_type?: string;
    readonly content?: string;
    readonly confidence?: number;
    readonly metadata?: Record<string, unknown>;
  }[];
}

interface DerivationContextRow {
  readonly derivation_id: string;
  readonly namespace_id: string;
  readonly artifact_id: string;
  readonly artifact_observation_id: string;
  readonly source_chunk_id: string | null;
  readonly content_text: string | null;
}

export interface ClassifyTextToCandidatesRequest {
  readonly namespaceId: string;
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
  readonly presetId?: string;
  readonly maxOutputTokens?: number;
  readonly artifactId?: string;
  readonly artifactObservationId?: string;
  readonly sourceChunkId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ClassifyDerivationRequest {
  readonly derivationId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly presetId?: string;
  readonly maxOutputTokens?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ClassificationStagingResult {
  readonly provider: string;
  readonly model: string;
  readonly inserted: {
    readonly entities: number;
    readonly relationships: number;
    readonly claims: number;
    readonly ambiguities: number;
    readonly memoryCandidates: number;
  };
  readonly rawText: string;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")).toLowerCase();
}

function clampConfidence(value: unknown, fallback = 0.7): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceEntityType(value: unknown): BrainEntityType {
  switch (asString(value)?.toLowerCase()) {
    case "self":
      return "self";
    case "person":
      return "person";
    case "place":
    case "location":
      return "place";
    case "org":
    case "organization":
    case "company":
      return "org";
    case "project":
      return "project";
    case "concept":
    case "thing":
      return "concept";
    default:
      return "unknown";
  }
}

function coerceMentionRole(value: unknown, entityType: BrainEntityType): MentionRole {
  const role = asString(value)?.toLowerCase();
  if (role === "subject") return "subject";
  if (role === "participant") return "participant";
  if (role === "location") return "location";
  if (role === "organization") return "organization";
  if (role === "project") return "project";
  if (role === "mentioned") return "mentioned";

  switch (entityType) {
    case "place":
      return "location";
    case "org":
      return "organization";
    case "project":
      return "project";
    case "person":
    case "self":
      return "participant";
    default:
      return "mentioned";
  }
}

function normalizeAmbiguityType(value: unknown): BrainAmbiguityType | null {
  const normalized = asString(value)?.toLowerCase().replace(/[\s-]+/gu, "_");
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "possible_misspelling":
    case "undefined_kinship":
    case "vague_place":
    case "alias_collision":
    case "unknown_reference":
    case "asr_correction":
    case "kinship_resolution":
    case "place_grounding":
      return normalized;
    case "misspelling":
    case "spelling_error":
    case "name_misspelling":
      return "possible_misspelling";
    case "kinship":
    case "unknown_kinship":
      return "undefined_kinship";
    case "place":
    case "location":
    case "place_alias":
      return "vague_place";
    case "alias":
    case "nickname":
    case "entity_collision":
    case "name_collision":
      return "alias_collision";
    default:
      if (normalized.includes("misspell") || normalized.includes("spelling")) {
        return "possible_misspelling";
      }
      if (normalized.includes("kinship") || normalized.includes("uncle") || normalized.includes("aunt")) {
        return normalized.includes("resolution") ? "kinship_resolution" : "undefined_kinship";
      }
      if (normalized.includes("place") || normalized.includes("location") || normalized.includes("ground")) {
        return normalized.includes("ground") ? "place_grounding" : "vague_place";
      }
      if (normalized.includes("alias") || normalized.includes("nickname") || normalized.includes("collision")) {
        return "alias_collision";
      }
      if (normalized.includes("asr") || normalized.includes("transcrib")) {
        return "asr_correction";
      }
      return "unknown_reference";
  }
}

function acceptedStatus(confidence: number): "accepted" | "pending" {
  return confidence >= 0.85 ? "accepted" : "pending";
}

function buildInstruction(): string {
  return [
    "Return strict JSON only. No markdown, no prose, no code fences.",
    "Extract candidate memory for a local AI brain.",
    "Respect the tripartite memory model:",
    "- episodic_hints: what happened or was directly observed",
    "- semantic_hints: general facts or durable learned abstractions",
    "- procedural_hints: active current-truth state candidates like roles or project state",
    "Classify people, places, organizations, projects, concepts, relationships, claims, and ambiguities.",
    "Use low confidence and ambiguities instead of inventing certainty.",
    "JSON shape:",
    JSON.stringify(
      {
        summary: "short summary",
        tripartite: {
          episodic_hints: ["..."],
          semantic_hints: ["..."],
          procedural_hints: [
            {
              state_type: "project_role",
              content: "Steve is acting CTO for Two-Way",
              confidence: 0.91,
              metadata: {}
            }
          ]
        },
        entities: [
          {
            name: "Steve",
            entity_type: "person",
            aliases: ["Steven"],
            confidence: 0.98,
            role: "subject"
          }
        ],
        relationships: [
          {
            subject: "Steve",
            subject_type: "person",
            predicate: "works_on",
            object: "Two-Way",
            object_type: "project",
            confidence: 0.93,
            time_expression_text: "right now"
          }
        ],
        claims: [
          {
            candidate_type: "project_role",
            content: "Steve is the acting CTO for Two-Way",
            subject: "Steve",
            subject_type: "person",
            predicate: "project_role",
            object: "Two-Way",
            object_type: "project",
            confidence: 0.93
          }
        ],
        ambiguities: [
          {
            text: "Gumee",
            ambiguity_type: "possible_misspelling",
            reason: "May refer to Gummi"
          }
        ]
      },
      null,
      2
    )
  ].join("\n");
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: BrainEntityType,
  canonicalName: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [namespaceId, entityType, canonicalName, normalizeName(canonicalName), JSON.stringify(metadata)]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to upsert entity ${canonicalName}`);
  }
  return row.id;
}

async function upsertAlias(
  client: PoolClient,
  entityId: string,
  alias: string,
  aliasType: "observed" | "derived" | "manual",
  metadata: Record<string, unknown>
): Promise<void> {
  if (!alias.trim()) {
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
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (entity_id, normalized_alias)
      DO UPDATE SET
        alias_type = EXCLUDED.alias_type,
        metadata = entity_aliases.metadata || EXCLUDED.metadata
    `,
    [entityId, alias, normalizeName(alias), aliasType, JSON.stringify(metadata)]
  );
}

async function insertMention(
  client: PoolClient,
  input: {
    namespaceId: string;
    entityId: string;
    sourceChunkId?: string;
    mentionText: string;
    mentionRole: MentionRole;
    confidence: number;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO memory_entity_mentions (
        namespace_id,
        entity_id,
        source_chunk_id,
        mention_text,
        mention_role,
        confidence,
        occurred_at,
        metadata
      )
      VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, now(), $7::jsonb)
      ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
      DO UPDATE SET
        confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
        metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
    `,
    [
      input.namespaceId,
      input.entityId,
      input.sourceChunkId ?? null,
      input.mentionText,
      input.mentionRole,
      input.confidence,
      JSON.stringify(input.metadata)
    ]
  );
}

async function resolveDerivationContext(derivationId: string): Promise<DerivationContextRow> {
  const rows = await queryRows<DerivationContextRow>(
    `
      SELECT
        ad.id AS derivation_id,
        a.namespace_id,
        a.id AS artifact_id,
        ao.id AS artifact_observation_id,
        ad.source_chunk_id::text,
        ad.content_text
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      WHERE ad.id = $1::uuid
      LIMIT 1
    `,
    [derivationId]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Artifact derivation ${derivationId} not found`);
  }
  return row;
}

export async function classifyTextToCandidates(
  request: ClassifyTextToCandidatesRequest
): Promise<ClassificationStagingResult> {
  const text = normalizeWhitespace(request.text);
  if (!text) {
    throw new Error("classifyTextToCandidates requires non-empty text");
  }

  const adapter = getProviderAdapter(request.provider);
  const classification = await adapter.classifyText({
    text,
    model: request.model,
    maxOutputTokens: request.maxOutputTokens,
    systemPrompt:
      "You extract portable candidate memory packets for a local-first AI brain. Be conservative, abstain when uncertain, and return strict JSON only.",
    instruction: buildInstruction(),
    metadata: {
      preset_id: request.presetId,
      ...(request.metadata ?? {})
    }
  });

  const output = classification.output;
  const entities = asArray<EntityPacket>(output.entities);
  const relationships = asArray<RelationshipPacket>(output.relationships);
  const claims = asArray<ClaimPacket>(output.claims);
  const ambiguities = asArray<AmbiguityPacket>(output.ambiguities);
  const tripartite = asRecord(output.tripartite) as TripartiteHints;

  return withTransaction(async (client) => {
    const entityMap = new Map<string, { id: string; type: BrainEntityType }>();
    let insertedEntities = 0;
    let insertedRelationships = 0;
    let insertedClaims = 0;
    let insertedAmbiguities = 0;
    let insertedMemoryCandidates = 0;

    for (const packet of entities) {
      const name = normalizeWhitespace(packet.name ?? "");
      if (!name) {
        continue;
      }
      const entityType = coerceEntityType(packet.entity_type);
      const entityId = await upsertEntity(client, request.namespaceId, entityType, name, {
        source: "provider_classification",
        provider: classification.provider,
        model: classification.model
      });
      entityMap.set(normalizeName(name), { id: entityId, type: entityType });
      insertedEntities += 1;

      await upsertAlias(client, entityId, name, "derived", {
        source: "provider_classification"
      });

      for (const alias of asArray<string>(packet.aliases)) {
        if (asString(alias)) {
          await upsertAlias(client, entityId, alias, "derived", {
            source: "provider_classification"
          });
        }
      }

      if (request.sourceChunkId) {
        await insertMention(client, {
          namespaceId: request.namespaceId,
          entityId,
          sourceChunkId: request.sourceChunkId,
          mentionText: name,
          mentionRole: coerceMentionRole(packet.role, entityType),
          confidence: clampConfidence(packet.confidence, 0.7),
          metadata: {
            source: "provider_classification"
          }
        });
      }
    }

    async function ensureEntityByName(name: string, entityType?: string): Promise<{ id: string; type: BrainEntityType }> {
      const normalized = normalizeName(name);
      const existing = entityMap.get(normalized);
      if (existing) {
        return existing;
      }
      const coercedType = coerceEntityType(entityType);
      const entityId = await upsertEntity(client, request.namespaceId, coercedType, name, {
        source: "provider_classification",
        provider: classification.provider,
        model: classification.model
      });
      await upsertAlias(client, entityId, name, "derived", {
        source: "provider_classification"
      });
      const resolved = { id: entityId, type: coercedType };
      entityMap.set(normalized, resolved);
      insertedEntities += 1;
      return resolved;
    }

    for (const relation of relationships) {
      const subject = asString(relation.subject);
      const predicate = asString(relation.predicate);
      const object = asString(relation.object);
      if (!subject || !predicate || !object) {
        continue;
      }

      const subjectEntity = await ensureEntityByName(subject, relation.subject_type);
      const objectEntity = await ensureEntityByName(object, relation.object_type);
      const confidence = clampConfidence(relation.confidence, 0.78);

      await client.query(
        `
          INSERT INTO relationship_candidates (
            namespace_id,
            subject_entity_id,
            predicate,
            object_entity_id,
            source_chunk_id,
            confidence,
            status,
            valid_from,
            valid_until,
            created_at,
            metadata
          )
          VALUES ($1, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8::timestamptz, $9::timestamptz, now(), $10::jsonb)
          ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
          DO UPDATE SET
            confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
            status = CASE
              WHEN relationship_candidates.status = 'accepted' THEN relationship_candidates.status
              ELSE EXCLUDED.status
            END,
            metadata = relationship_candidates.metadata || EXCLUDED.metadata
        `,
        [
          request.namespaceId,
          subjectEntity.id,
          predicate,
          objectEntity.id,
          request.sourceChunkId ?? null,
          confidence,
          acceptedStatus(confidence),
          asString(relation.valid_from) ?? null,
          asString(relation.valid_until) ?? null,
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model,
            time_expression_text: relation.time_expression_text ?? null,
            ambiguity_type: relation.ambiguity_type ?? null,
            ambiguity_reason: relation.ambiguity_reason ?? null
          })
        ]
      );
      insertedRelationships += 1;
    }

    for (const claim of claims) {
      const content = normalizeWhitespace(claim.content ?? "");
      if (!content) {
        continue;
      }
      const confidence = clampConfidence(claim.confidence, 0.72);
      const subjectText = asString(claim.subject);
      const objectText = asString(claim.object);
      const subjectEntity =
        subjectText ? await ensureEntityByName(subjectText, claim.subject_type) : null;
      const objectEntity =
        objectText ? await ensureEntityByName(objectText, claim.object_type) : null;

      await client.query(
        `
          INSERT INTO claim_candidates (
            namespace_id,
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
            time_expression_text,
            ambiguity_state,
            ambiguity_type,
            ambiguity_reason,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            now(),
            $14,
            $15,
            $16,
            $17,
            $18,
            $19::jsonb
          )
        `,
        [
          request.namespaceId,
          request.sourceChunkId ?? null,
          subjectEntity?.id ?? null,
          objectEntity?.id ?? null,
          asString(claim.candidate_type) ?? asString(claim.claim_type) ?? "classified_claim",
          subjectText ?? null,
          subjectEntity?.type ?? coerceEntityType(claim.subject_type),
          asString(claim.predicate) ?? "classified_as",
          objectText ?? null,
          objectEntity?.type ?? coerceEntityType(claim.object_type),
          content.toLowerCase(),
          confidence,
          acceptedStatus(confidence),
          "provider_classification",
          asString(claim.time_expression_text) ?? null,
          claim.ambiguity_type || claim.ambiguity_reason ? "requires_clarification" : "none",
          normalizeAmbiguityType(claim.ambiguity_type),
          asString(claim.ambiguity_reason) ?? null,
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model,
            content
          })
        ]
      );
      insertedClaims += 1;
    }

    for (const ambiguity of ambiguities) {
      const textValue = normalizeWhitespace(ambiguity.text ?? "");
      if (!textValue) {
        continue;
      }
      await client.query(
        `
          INSERT INTO claim_candidates (
            namespace_id,
            source_chunk_id,
            claim_type,
            predicate,
            object_text,
            object_entity_type,
            normalized_text,
            confidence,
            status,
            occurred_at,
            extraction_method,
            ambiguity_state,
            ambiguity_type,
            ambiguity_reason,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            'ambiguity',
            'needs_clarification',
            $3,
            $4,
            $5,
            0.4,
            'pending',
            now(),
            'provider_classification',
            'requires_clarification',
            $6,
            $7,
            $8::jsonb
          )
        `,
        [
          request.namespaceId,
          request.sourceChunkId ?? null,
          textValue,
          coerceEntityType(ambiguity.entity_type),
          textValue.toLowerCase(),
          normalizeAmbiguityType(ambiguity.ambiguity_type) ?? "unknown_reference",
          asString(ambiguity.reason) ?? "Needs clarification",
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model,
            suggestions: asArray<string>(ambiguity.suggestions)
          })
        ]
      );
      insertedAmbiguities += 1;
    }

    const episodicHints = asArray<string>(tripartite.episodic_hints);
    const semanticHints = asArray<string>(tripartite.semantic_hints);
    const proceduralHints = asArray<Record<string, unknown>>(tripartite.procedural_hints);

    for (const hint of episodicHints) {
      const content = asString(hint);
      if (!content) continue;
      await client.query(
        `
          INSERT INTO memory_candidates (
            namespace_id,
            source_chunk_id,
            candidate_type,
            content,
            confidence,
            status,
            metadata
          )
          VALUES ($1, $2::uuid, 'episodic_hint', $3, 0.75, 'accepted', $4::jsonb)
          ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
          DO UPDATE SET
            confidence = GREATEST(memory_candidates.confidence, EXCLUDED.confidence),
            status = CASE
              WHEN memory_candidates.status = 'accepted' THEN memory_candidates.status
              ELSE EXCLUDED.status
            END,
            metadata = memory_candidates.metadata || EXCLUDED.metadata
        `,
        [
          request.namespaceId,
          request.sourceChunkId ?? null,
          content,
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model
          })
        ]
      );
      insertedMemoryCandidates += 1;
    }

    for (const hint of semanticHints) {
      const content = asString(hint);
      if (!content) continue;
      await client.query(
        `
          INSERT INTO memory_candidates (
            namespace_id,
            source_chunk_id,
            candidate_type,
            content,
            confidence,
            status,
            metadata
          )
          VALUES ($1, $2::uuid, 'semantic_hint', $3, 0.8, 'accepted', $4::jsonb)
          ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
          DO UPDATE SET
            confidence = GREATEST(memory_candidates.confidence, EXCLUDED.confidence),
            status = CASE
              WHEN memory_candidates.status = 'accepted' THEN memory_candidates.status
              ELSE EXCLUDED.status
            END,
            metadata = memory_candidates.metadata || EXCLUDED.metadata
        `,
        [
          request.namespaceId,
          request.sourceChunkId ?? null,
          content,
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model
          })
        ]
      );
      insertedMemoryCandidates += 1;
    }

    for (const hint of proceduralHints) {
      const content = asString(hint.content);
      if (!content) continue;
      const confidence = clampConfidence(hint.confidence, 0.82);
      await client.query(
        `
          INSERT INTO memory_candidates (
            namespace_id,
            source_chunk_id,
            candidate_type,
            content,
            confidence,
            status,
            metadata
          )
          VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb)
          ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
          DO UPDATE SET
            confidence = GREATEST(memory_candidates.confidence, EXCLUDED.confidence),
            status = CASE
              WHEN memory_candidates.status = 'accepted' THEN memory_candidates.status
              ELSE EXCLUDED.status
            END,
            metadata = memory_candidates.metadata || EXCLUDED.metadata
        `,
        [
          request.namespaceId,
          request.sourceChunkId ?? null,
          asString(hint.state_type) ?? "procedural_hint",
          content,
          confidence,
          acceptedStatus(confidence),
          JSON.stringify({
            source: "provider_classification",
            provider: classification.provider,
            model: classification.model,
            ...(asRecord(hint.metadata) ?? {})
          })
        ]
      );
      insertedMemoryCandidates += 1;
    }

    return {
      provider: classification.provider,
      model: classification.model,
      inserted: {
        entities: insertedEntities,
        relationships: insertedRelationships,
        claims: insertedClaims,
        ambiguities: insertedAmbiguities,
        memoryCandidates: insertedMemoryCandidates
      },
      rawText: classification.rawText,
      tokenUsage: classification.tokenUsage
    };
  });
}

export async function classifyDerivationTextToCandidates(
  request: ClassifyDerivationRequest
): Promise<ClassificationStagingResult> {
  const context = await resolveDerivationContext(request.derivationId);
  const text = normalizeWhitespace(context.content_text ?? "");
  if (!text) {
    throw new Error(`Artifact derivation ${request.derivationId} has no text to classify`);
  }

  return classifyTextToCandidates({
    namespaceId: context.namespace_id,
    text,
    provider: request.provider,
    model: request.model,
    presetId: request.presetId,
    maxOutputTokens: request.maxOutputTokens,
    artifactId: context.artifact_id,
    artifactObservationId: context.artifact_observation_id,
    sourceChunkId: context.source_chunk_id ?? undefined,
    metadata: {
      derivation_id: request.derivationId,
      ...(request.metadata ?? {})
    }
  });
}
