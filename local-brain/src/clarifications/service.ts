import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";

type ClarificationAction = "resolve" | "ignore";
type ClarificationTargetRole = "subject" | "object";
type AmbiguityType =
  | "possible_misspelling"
  | "undefined_kinship"
  | "vague_place"
  | "alias_collision"
  | "unknown_reference";

interface ClarificationSummaryRow {
  readonly ambiguity_type: string | null;
  readonly total: string;
}

interface ClarificationInboxRow {
  readonly candidate_id: string;
  readonly claim_type: string;
  readonly predicate: string;
  readonly subject_text: string | null;
  readonly object_text: string | null;
  readonly subject_entity_type: string | null;
  readonly object_entity_type: string | null;
  readonly confidence: number;
  readonly prior_score: number;
  readonly ambiguity_type: AmbiguityType;
  readonly ambiguity_reason: string | null;
  readonly occurred_at: string;
  readonly scene_text: string | null;
  readonly source_uri: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ClaimCandidateRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly source_scene_id: string | null;
  readonly source_event_id: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly claim_type: string;
  readonly predicate: string;
  readonly subject_text: string | null;
  readonly subject_entity_type: string | null;
  readonly subject_entity_id: string | null;
  readonly object_text: string | null;
  readonly object_entity_type: string | null;
  readonly object_entity_id: string | null;
  readonly confidence: number;
  readonly prior_score: number;
  readonly occurred_at: string;
  readonly ambiguity_state: string;
  readonly ambiguity_type: AmbiguityType | null;
  readonly ambiguity_reason: string | null;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
}

interface OutboxEventRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly aggregate_id: string | null;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly retry_count: number;
}

interface ResolveClarificationInput {
  readonly namespaceId: string;
  readonly candidateId: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly targetRole?: ClarificationTargetRole;
  readonly aliases?: readonly string[];
  readonly note?: string;
}

interface IgnoreClarificationInput {
  readonly namespaceId: string;
  readonly candidateId: string;
  readonly note?: string;
}

export interface ClarificationInboxItem {
  readonly candidateId: string;
  readonly claimType: string;
  readonly predicate: string;
  readonly targetRole: ClarificationTargetRole;
  readonly rawText: string;
  readonly subjectText?: string | null;
  readonly objectText?: string | null;
  readonly confidence: number;
  readonly priorScore: number;
  readonly ambiguityType: AmbiguityType;
  readonly ambiguityReason?: string | null;
  readonly suggestedMatches: readonly string[];
  readonly occurredAt: string;
  readonly sceneText?: string | null;
  readonly sourceUri?: string | null;
}

export interface ClarificationInbox {
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly items: readonly ClarificationInboxItem[];
}

export interface ClarificationCommandResult {
  readonly namespaceId: string;
  readonly candidateId: string;
  readonly action: ClarificationAction;
  readonly outboxEventId: string;
  readonly affectedCandidates: number;
}

export interface BrainOutboxProcessResult {
  readonly scanned: number;
  readonly processed: number;
  readonly failed: number;
  readonly touchedNamespaces: readonly string[];
}

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
  return normalizeWhitespace(value.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, ""));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function inferTargetRole(row: ClarificationInboxRow | ClaimCandidateRow): ClarificationTargetRole {
  const metadataRole = typeof row.metadata?.ambiguity_target_role === "string" ? row.metadata.ambiguity_target_role : null;
  if (metadataRole === "subject" || metadataRole === "object") {
    return metadataRole;
  }

  if (row.object_text && !("object_entity_id" in row) ? false : !(row as ClaimCandidateRow).object_entity_id) {
    return "object";
  }

  return "subject";
}

function rawTextForRole(row: ClarificationInboxRow | ClaimCandidateRow, targetRole: ClarificationTargetRole): string {
  return normalizeWhitespace(targetRole === "subject" ? row.subject_text ?? "" : row.object_text ?? "");
}

function parseSuggestedMatches(metadata: Record<string, unknown>): string[] {
  const raw = metadata.suggested_matches;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
        return (entry as { name: string }).name;
      }
      return "";
    })
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
}

function mentionRoleForEntityType(entityType: string | null, targetRole: ClarificationTargetRole): string {
  if (targetRole === "subject") {
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

function inferFollowUpAmbiguity(candidate: ClaimCandidateRow): {
  readonly targetRole: ClarificationTargetRole;
  readonly type: AmbiguityType;
  readonly reason: string;
  readonly rawText: string;
} | null {
  const checks: Array<{ readonly role: ClarificationTargetRole; readonly text: string | null; readonly entityId: string | null }> = [
    { role: "subject", text: candidate.subject_text, entityId: candidate.subject_entity_id },
    { role: "object", text: candidate.object_text, entityId: candidate.object_entity_id }
  ];

  for (const check of checks) {
    const rawText = normalizeWhitespace(check.text ?? "");
    if (!rawText || check.entityId) {
      continue;
    }

    const normalized = normalizeName(rawText);
    if (!normalized) {
      continue;
    }

    if (KINSHIP_TERMS.has(normalized)) {
      return {
        targetRole: check.role,
        type: "undefined_kinship",
        reason: `The ${check.role} reference "${rawText}" still needs a concrete person.`,
        rawText
      };
    }

    if (VAGUE_PLACE_PHRASES.some((pattern) => pattern.test(rawText))) {
      return {
        targetRole: check.role,
        type: "vague_place",
        reason: `The ${check.role} reference "${rawText}" still needs a concrete place.`,
        rawText
      };
    }

    return {
      targetRole: check.role,
      type: "unknown_reference",
      reason: `The ${check.role} reference "${rawText}" is still unresolved.`,
      rawText
    };
  }

  return null;
}

function isRelationshipPredicate(predicate: string): boolean {
  return ["friend_of", "with", "from", "lives_in", "lived_in", "currently_in", "runs", "works_at", "works_with", "hikes_with"].includes(
    predicate
  );
}

async function upsertEntity(
  client: PoolClient,
  namespaceId: string,
  entityType: string,
  canonicalName: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const [row] = (
    await client.query<{ id: string }>(
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
    )
  ).rows;

  return row.id;
}

async function upsertAlias(
  client: PoolClient,
  entityId: string,
  alias: string,
  aliasType: "manual" | "derived" | "observed",
  metadata: Record<string, unknown>
): Promise<void> {
  await client.query(
    `
      INSERT INTO entity_aliases (
        entity_id,
        alias,
        normalized_alias,
        alias_type,
        is_user_verified,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (entity_id, normalized_alias)
      DO UPDATE SET
        alias_type = EXCLUDED.alias_type,
        is_user_verified = entity_aliases.is_user_verified OR EXCLUDED.is_user_verified,
        metadata = entity_aliases.metadata || EXCLUDED.metadata
    `,
    [entityId, alias, normalizeName(alias), aliasType, aliasType === "manual", JSON.stringify(metadata)]
  );
}

async function fetchCandidateForUpdate(client: PoolClient, namespaceId: string, candidateId: string): Promise<ClaimCandidateRow> {
  const result = await client.query<ClaimCandidateRow>(
    `
      SELECT
        id,
        namespace_id,
        source_scene_id,
        source_event_id,
        source_memory_id,
        source_chunk_id,
        claim_type,
        predicate,
        subject_text,
        subject_entity_type,
        subject_entity_id::text,
        object_text,
        object_entity_type,
        object_entity_id::text,
        confidence,
        prior_score,
        occurred_at::text,
        status,
        ambiguity_state,
        ambiguity_type,
        ambiguity_reason,
        metadata
      FROM claim_candidates
      WHERE namespace_id = $1
        AND id = $2
      FOR UPDATE
    `,
    [namespaceId, candidateId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Clarification candidate ${candidateId} not found in namespace ${namespaceId}.`);
  }

  return row;
}

export async function getClarificationInbox(namespaceId: string, limit = 40): Promise<ClarificationInbox> {
  const [summaryRows, itemRows] = await Promise.all([
    queryRows<ClarificationSummaryRow>(
      `
        SELECT ambiguity_type, COUNT(*)::text AS total
        FROM claim_candidates
        WHERE namespace_id = $1
          AND ambiguity_state = 'requires_clarification'
        GROUP BY ambiguity_type
      `,
      [namespaceId]
    ),
    queryRows<ClarificationInboxRow>(
      `
        SELECT
          cc.id AS candidate_id,
          cc.claim_type,
          cc.predicate,
          cc.subject_text,
          cc.object_text,
          cc.subject_entity_type,
          cc.object_entity_type,
          cc.confidence,
          cc.prior_score,
          cc.ambiguity_type,
          cc.ambiguity_reason,
          cc.occurred_at::text,
          ns.scene_text,
          a.uri AS source_uri,
          cc.metadata
        FROM claim_candidates cc
        LEFT JOIN narrative_scenes ns ON ns.id = cc.source_scene_id
        LEFT JOIN artifacts a ON a.id = ns.artifact_id
        WHERE cc.namespace_id = $1
          AND cc.ambiguity_state = 'requires_clarification'
        ORDER BY cc.prior_score DESC, cc.occurred_at DESC, cc.created_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(1, limit)]
    )
  ]);

  const byType: Record<string, number> = {};
  for (const row of summaryRows) {
    byType[row.ambiguity_type ?? "unknown"] = Number(row.total);
  }

  return {
    namespaceId,
    summary: {
      total: Object.values(byType).reduce((sum, value) => sum + value, 0),
      byType
    },
    items: itemRows.map((row) => {
      const targetRole = inferTargetRole(row);
      return {
        candidateId: row.candidate_id,
        claimType: row.claim_type,
        predicate: row.predicate,
        targetRole,
        rawText: rawTextForRole(row, targetRole),
        subjectText: row.subject_text,
        objectText: row.object_text,
        confidence: row.confidence,
        priorScore: row.prior_score,
        ambiguityType: row.ambiguity_type,
        ambiguityReason: row.ambiguity_reason,
        suggestedMatches:
          row.ambiguity_type === "possible_misspelling" || row.ambiguity_type === "alias_collision"
            ? parseSuggestedMatches(row.metadata)
            : [],
        occurredAt: row.occurred_at,
        sceneText: row.scene_text,
        sourceUri: row.source_uri
      };
    })
  };
}

export async function resolveClarification(input: ResolveClarificationInput): Promise<ClarificationCommandResult> {
  const aliases = unique([input.canonicalName, ...(input.aliases ?? [])]);

  return withTransaction(async (client) => {
    const candidate = await fetchCandidateForUpdate(client, input.namespaceId, input.candidateId);
    const targetRole = input.targetRole ?? inferTargetRole(candidate);
    const rawText = rawTextForRole(candidate, targetRole);
    if (!rawText) {
      throw new Error(`Candidate ${input.candidateId} does not expose an ambiguous ${targetRole} text value.`);
    }

    const canonicalName = normalizeWhitespace(input.canonicalName);
    const entityType = normalizeWhitespace(input.entityType || (targetRole === "subject" ? candidate.subject_entity_type ?? "person" : candidate.object_entity_type ?? "person"));
    const entityId = await upsertEntity(client, input.namespaceId, entityType, canonicalName, {
      clarification_source: "manual",
      clarified_at: new Date().toISOString()
    });

    for (const alias of unique([rawText, ...aliases])) {
      await upsertAlias(client, entityId, alias, "manual", {
        clarification_source: "manual",
        source_candidate_id: input.candidateId
      });
    }

    const fieldText = targetRole === "subject" ? "subject_text" : "object_text";
    const fieldEntityType = targetRole === "subject" ? "subject_entity_type" : "object_entity_type";
    const fieldEntityId = targetRole === "subject" ? "subject_entity_id" : "object_entity_id";
    const affected = await client.query<{ id: string }>(
      `
        UPDATE claim_candidates
        SET
          ${fieldText} = $3,
          ${fieldEntityType} = $4,
          ${fieldEntityId} = $5::uuid,
          confidence = GREATEST(confidence, 0.92),
          status = CASE
            WHEN (CASE WHEN $2 = 'subject' THEN object_entity_id IS NOT NULL ELSE subject_entity_id IS NOT NULL END)
              THEN 'accepted'
            ELSE status
          END,
          ambiguity_state = 'resolved',
          ambiguity_reason = NULL,
          metadata = claim_candidates.metadata || $6::jsonb
        WHERE namespace_id = $1
          AND ambiguity_state = 'requires_clarification'
          AND lower(${fieldText}) = lower($7)
        RETURNING id
      `,
      [
        input.namespaceId,
        targetRole,
        canonicalName,
        entityType,
        entityId,
        JSON.stringify({
          clarification_action: "resolved",
          clarification_note: input.note ?? null,
          clarification_target_role: targetRole,
          clarification_entity_id: entityId,
          clarified_at: new Date().toISOString(),
          raw_ambiguous_text: rawText
        }),
        rawText
      ]
    );

    const idempotencyKey = `clarification:resolve:${input.namespaceId}:${input.candidateId}:${normalizeName(rawText)}:${normalizeName(canonicalName)}`;
    const payload = JSON.stringify({
      action: "resolve",
      namespace_id: input.namespaceId,
      source_candidate_id: input.candidateId,
      target_role: targetRole,
      raw_text: rawText,
      canonical_name: canonicalName,
      entity_type: entityType,
      entity_id: entityId,
      affected_candidate_ids: affected.rows.map((row) => row.id),
      aliases: unique([rawText, ...aliases]),
      note: input.note ?? null
    });
    const existingOutbox = await client.query<{ id: string }>(
      `
        SELECT id
        FROM brain_outbox_events
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    );
    const outbox =
      existingOutbox.rows[0] ??
      (
        await client.query<{ id: string }>(
          `
            INSERT INTO brain_outbox_events (
              namespace_id,
              aggregate_type,
              aggregate_id,
              event_type,
              payload,
              idempotency_key
            )
            VALUES ($1, 'claim_candidate', $2::uuid, 'clarification.resolved', $3::jsonb, $4)
            RETURNING id
          `,
          [input.namespaceId, input.candidateId, payload, idempotencyKey]
        )
      ).rows?.[0];

    if (existingOutbox.rows[0]) {
      await client.query(
        `
          UPDATE brain_outbox_events
          SET
            payload = $2::jsonb,
            status = 'pending',
            next_attempt_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [existingOutbox.rows[0].id, payload]
      );
    }

    if (affected.rows.length > 0) {
      const updatedCandidates = await client.query<ClaimCandidateRow>(
        `
          SELECT
            id,
            namespace_id,
            source_scene_id,
            source_event_id,
            source_memory_id,
            source_chunk_id,
            claim_type,
            predicate,
            subject_text,
            subject_entity_type,
            subject_entity_id::text,
            object_text,
            object_entity_type,
            object_entity_id::text,
            confidence,
            prior_score,
            occurred_at::text,
            status,
            ambiguity_state,
            ambiguity_type,
            ambiguity_reason,
            metadata
          FROM claim_candidates
          WHERE id = ANY($1::uuid[])
        `,
        [affected.rows.map((row) => row.id)]
      );

      for (const updated of updatedCandidates.rows) {
        const nextAmbiguity = inferFollowUpAmbiguity(updated);
        await client.query(
          `
            UPDATE claim_candidates
            SET
              ambiguity_state = $2,
              ambiguity_type = $3,
              ambiguity_reason = $4,
              metadata = claim_candidates.metadata || $5::jsonb
            WHERE id = $1
          `,
          [
            updated.id,
            nextAmbiguity ? "requires_clarification" : "resolved",
            nextAmbiguity?.type ?? null,
            nextAmbiguity?.reason ?? null,
            JSON.stringify(
              nextAmbiguity
                ? {
                    ambiguity_target_role: nextAmbiguity.targetRole,
                    raw_ambiguous_text: nextAmbiguity.rawText
                  }
                : {
                    ambiguity_target_role: null,
                    raw_ambiguous_text: null
                  }
            )
          ]
        );
      }
    }

    return {
      namespaceId: input.namespaceId,
      candidateId: input.candidateId,
      action: "resolve",
      outboxEventId: outbox?.id ?? "",
      affectedCandidates: affected.rowCount ?? 0
    };
  });
}

export async function ignoreClarification(input: IgnoreClarificationInput): Promise<ClarificationCommandResult> {
  return withTransaction(async (client) => {
    await fetchCandidateForUpdate(client, input.namespaceId, input.candidateId);

    const affected = await client.query<{ id: string }>(
      `
        UPDATE claim_candidates
        SET
          ambiguity_state = 'ignored',
          metadata = claim_candidates.metadata || $3::jsonb
        WHERE namespace_id = $1
          AND id = $2
        RETURNING id
      `,
      [
        input.namespaceId,
        input.candidateId,
        JSON.stringify({
          clarification_action: "ignored",
          clarification_note: input.note ?? null,
          clarified_at: new Date().toISOString()
        })
      ]
    );

    const idempotencyKey = `clarification:ignore:${input.namespaceId}:${input.candidateId}`;
    const payload = JSON.stringify({
      action: "ignore",
      namespace_id: input.namespaceId,
      source_candidate_id: input.candidateId,
      note: input.note ?? null
    });
    const existingOutbox = await client.query<{ id: string }>(
      `
        SELECT id
        FROM brain_outbox_events
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    );
    const outbox =
      existingOutbox.rows[0] ??
      (
        await client.query<{ id: string }>(
          `
            INSERT INTO brain_outbox_events (
              namespace_id,
              aggregate_type,
              aggregate_id,
              event_type,
              payload,
              idempotency_key
            )
            VALUES ($1, 'claim_candidate', $2::uuid, 'clarification.ignored', $3::jsonb, $4)
            RETURNING id
          `,
          [input.namespaceId, input.candidateId, payload, idempotencyKey]
        )
      ).rows?.[0];

    if (existingOutbox.rows[0]) {
      await client.query(
        `
          UPDATE brain_outbox_events
          SET
            payload = $2::jsonb,
            status = 'pending',
            next_attempt_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [existingOutbox.rows[0].id, payload]
      );
    }

    return {
      namespaceId: input.namespaceId,
      candidateId: input.candidateId,
      action: "ignore",
      outboxEventId: outbox?.id ?? "",
      affectedCandidates: affected.rowCount ?? 0
    };
  });
}

async function claimOutboxEvents(limit: number, workerId: string, namespaceId?: string): Promise<readonly OutboxEventRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<OutboxEventRow>(
      `
        WITH next_events AS (
          SELECT id
          FROM brain_outbox_events
          WHERE status IN ('pending', 'failed')
            AND next_attempt_at <= now()
            AND ($1::text IS NULL OR namespace_id = $1)
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE brain_outbox_events boe
        SET
          status = 'processing',
          locked_at = now(),
          locked_by = $3,
          updated_at = now()
        FROM next_events
        WHERE boe.id = next_events.id
        RETURNING boe.id, boe.namespace_id, boe.aggregate_id::text, boe.event_type, boe.payload, boe.retry_count
      `,
      [namespaceId ?? null, Math.max(1, limit), workerId]
    );

    return result.rows;
  });
}

async function markOutboxProcessed(eventId: string): Promise<void> {
  await queryRows(
    `
      UPDATE brain_outbox_events
      SET
        status = 'processed',
        processed_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
      WHERE id = $1
    `,
    [eventId]
  );
}

async function markOutboxFailed(eventId: string, retryCount: number, errorMessage: string): Promise<void> {
  await queryRows(
    `
      UPDATE brain_outbox_events
      SET
        status = 'failed',
        retry_count = $2,
        next_attempt_at = now() + interval '5 minutes',
        last_error = $3,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
      WHERE id = $1
    `,
    [eventId, retryCount + 1, errorMessage.slice(0, 1500)]
  );
}

async function materializeResolvedClaim(client: PoolClient, candidate: ClaimCandidateRow, eventId: string): Promise<void> {
  if (candidate.subject_entity_id && candidate.subject_text) {
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
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'subject', $7, $8::timestamptz, $9::jsonb)
        ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
        DO UPDATE SET
          confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
          metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
      `,
      [
        candidate.namespace_id,
        candidate.subject_entity_id,
        candidate.source_scene_id,
        candidate.source_memory_id,
        candidate.source_chunk_id,
        candidate.subject_text,
        Math.max(candidate.confidence, 0.92),
        candidate.occurred_at,
        JSON.stringify({
          extractor: "clarification_outbox",
          source_outbox_event_id: eventId
        })
      ]
    );
  }

  if (candidate.object_entity_id && candidate.object_text) {
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
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::timestamptz, $10::jsonb)
        ON CONFLICT (entity_id, source_memory_id, source_chunk_id, mention_text)
        DO UPDATE SET
          confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
          metadata = memory_entity_mentions.metadata || EXCLUDED.metadata
      `,
      [
        candidate.namespace_id,
        candidate.object_entity_id,
        candidate.source_scene_id,
        candidate.source_memory_id,
        candidate.source_chunk_id,
        candidate.object_text,
        mentionRoleForEntityType(candidate.object_entity_type, "object"),
        Math.max(candidate.confidence, 0.92),
        candidate.occurred_at,
        JSON.stringify({
          extractor: "clarification_outbox",
          source_outbox_event_id: eventId
        })
      ]
    );
  }

  if (
    candidate.status === "accepted" &&
    candidate.subject_entity_id &&
    candidate.object_entity_id &&
    isRelationshipPredicate(candidate.predicate)
  ) {
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
        VALUES ($1, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11, 'pending', $12::timestamptz, $13::jsonb)
        ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
        DO UPDATE SET
          confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
          prior_score = GREATEST(relationship_candidates.prior_score, EXCLUDED.prior_score),
          metadata = relationship_candidates.metadata || EXCLUDED.metadata
      `,
      [
        candidate.namespace_id,
        candidate.subject_entity_id,
        candidate.predicate,
        candidate.object_entity_id,
        candidate.source_scene_id,
        candidate.source_event_id,
        candidate.source_memory_id,
        candidate.source_chunk_id,
        Math.max(candidate.confidence, 0.92),
        Math.max(candidate.prior_score, 0.88),
        "manual_clarification",
        candidate.occurred_at,
        JSON.stringify({
          extractor: "clarification_outbox",
          source_outbox_event_id: eventId,
          source_claim_candidate_id: candidate.id
        })
      ]
    );
  }
}

async function processResolvedEvent(event: OutboxEventRow): Promise<void> {
  const affectedCandidateIds = Array.isArray(event.payload.affected_candidate_ids)
    ? event.payload.affected_candidate_ids.filter((value): value is string => typeof value === "string")
    : [];

  if (affectedCandidateIds.length === 0) {
    await markOutboxProcessed(event.id);
    return;
  }

  await withTransaction(async (client) => {
    const candidates = await client.query<ClaimCandidateRow>(
      `
        SELECT
          id,
          namespace_id,
          source_scene_id,
          source_event_id,
          source_memory_id,
          source_chunk_id,
          claim_type,
          predicate,
          subject_text,
          subject_entity_type,
          subject_entity_id::text,
          object_text,
          object_entity_type,
          object_entity_id::text,
          confidence,
          prior_score,
          occurred_at::text,
          ambiguity_state,
          ambiguity_type,
          ambiguity_reason,
          metadata,
          status
        FROM claim_candidates
        WHERE id = ANY($1::uuid[])
      `,
      [affectedCandidateIds]
    );

    for (const candidate of candidates.rows as Array<ClaimCandidateRow & { status: string }>) {
      await materializeResolvedClaim(client, candidate, event.id);
    }

    await client.query(
      `
        UPDATE brain_outbox_events
        SET
          status = 'processed',
          processed_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [event.id]
    );
  });
}

export async function processBrainOutboxEvents(options?: {
  readonly namespaceId?: string;
  readonly limit?: number;
  readonly workerId?: string;
}): Promise<BrainOutboxProcessResult> {
  const workerId = options?.workerId ?? `brain-outbox-${randomUUID().slice(0, 8)}`;
  const events = await claimOutboxEvents(options?.limit ?? 25, workerId, options?.namespaceId);
  const touchedNamespaces = new Set<string>();
  let processed = 0;
  let failed = 0;

  for (const event of events) {
    try {
      if (event.event_type === "clarification.resolved") {
        await processResolvedEvent(event);
        touchedNamespaces.add(event.namespace_id);
        processed += 1;
      } else if (event.event_type === "clarification.ignored") {
        await markOutboxProcessed(event.id);
        processed += 1;
      } else {
        await queryRows(
          `
            UPDATE brain_outbox_events
            SET
              status = 'ignored',
              processed_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
            WHERE id = $1
          `,
          [event.id]
        );
      }
    } catch (error) {
      failed += 1;
      await markOutboxFailed(event.id, event.retry_count, error instanceof Error ? error.message : String(error));
    }
  }

  for (const namespaceId of touchedNamespaces) {
    await runCandidateConsolidation(namespaceId, 100);
    await runRelationshipAdjudication(namespaceId, {
      limit: 200,
      acceptThreshold: 0.6,
      rejectThreshold: 0.4
    });
  }

  return {
    scanned: events.length,
    processed,
    failed,
    touchedNamespaces: [...touchedNamespaces]
  };
}
