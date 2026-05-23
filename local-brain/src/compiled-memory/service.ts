import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";

type JsonRecord = Record<string, unknown>;

export interface CompiledMemoryRebuildCounts {
  readonly factObservations: number;
  readonly eventObservations: number;
  readonly relationshipObservations: number;
  readonly coverageRows: number;
}

export interface CompiledMemoryRebuildSummary {
  readonly namespaceId: string;
  readonly counts: CompiledMemoryRebuildCounts;
}

export interface CompiledFactObservationLookupRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly subject_entity_id: string | null;
  readonly pair_subject_entity_id: string | null;
  readonly query_family: string;
  readonly exact_detail_family: string | null;
  readonly predicate_family: string | null;
  readonly property_key: string | null;
  readonly answer_value: string | null;
  readonly normalized_answer_value: string;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly source_table: string;
  readonly source_row_id: string | null;
  readonly source_scene_id: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_uri: string | null;
  readonly support_phrase: string | null;
  readonly source_text: string | null;
  readonly extractor: string | null;
  readonly model_id: string | null;
  readonly schema_version: string | null;
  readonly promotion_status: "compiled" | "rejected" | "ambiguous";
  readonly admissibility_status: string | null;
  readonly rejection_reason: string | null;
  readonly metadata: JsonRecord | null;
}

interface ExactDetailFactKeyCompileRow {
  readonly id: string;
  readonly fact_table: string;
  readonly fact_row_id: string;
  readonly subject_entity_id: string | null;
  readonly exact_detail_family: string;
  readonly property_key: string | null;
  readonly key_text: string;
  readonly normalized_key_text: string;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord | null;
  readonly support_phrase: string | null;
}

interface TemporalEventCompileRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly pair_subject_entity_id: string | null;
  readonly predicate_family: string | null;
  readonly event_key: string | null;
  readonly event_type: string | null;
  readonly event_label: string | null;
  readonly object_entity_id: string | null;
  readonly object_value: string | null;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly start_at: string | null;
  readonly end_at: string | null;
  readonly time_granularity: string | null;
  readonly exactness: string | null;
  readonly support_count: number;
  readonly metadata: JsonRecord | null;
  readonly support_phrase: string | null;
}

interface RelationshipCompileRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly object_entity_id: string | null;
  readonly predicate: string | null;
  readonly confidence: number | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly metadata: JsonRecord | null;
}

interface NarrativeCoverageRow {
  readonly id: string;
  readonly scene_text: string | null;
  readonly metadata: JsonRecord | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeValue(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function asUuid(value: unknown): string | null {
  const text = readString(value);
  return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text) ? text : null;
}

function queryFamilyForExactDetailFamily(family: string | null): "current_state" | "exact_detail" {
  switch (family) {
    case "speed":
    case "brand":
    case "breed":
    case "count":
    case "service_name":
    case "pet_name":
    case "time_of_day":
    case "capacity":
      return "current_state";
    default:
      return "exact_detail";
  }
}

function authoritativeSourceFromMetadata(row: ExactDetailFactKeyCompileRow): string {
  const source = readString(row.metadata?.authoritative_source);
  if (source) {
    return source;
  }
  return row.fact_table === "temporal_event_facts" ? "active_event_fact" : "active_scalar_fact";
}

async function clearCompiledNamespace(client: PoolClient, namespaceId: string): Promise<void> {
  await client.query("DELETE FROM compiled_memory_coverage WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM compiled_relationship_observations WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM compiled_event_observations WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM compiled_fact_observations WHERE namespace_id = $1", [namespaceId]);
}

async function compileFactObservationsFromFactKeys(client: PoolClient, namespaceId: string): Promise<number> {
  const rows = await client.query<ExactDetailFactKeyCompileRow>(
    `
      SELECT
        value_key.id::text,
        value_key.fact_table,
        value_key.fact_row_id::text,
        value_key.subject_entity_id::text,
        value_key.exact_detail_family,
        value_key.property_key,
        value_key.key_text,
        value_key.normalized_key_text,
        value_key.truth_status,
        value_key.valid_from::text,
        value_key.valid_until::text,
        value_key.confidence,
        value_key.metadata,
        COALESCE(
          NULLIF(value_key.metadata->>'support_phrase', ''),
          support_key.key_text
        ) AS support_phrase
      FROM exact_detail_fact_keys value_key
      LEFT JOIN LATERAL (
        SELECT key_text
        FROM exact_detail_fact_keys support_key
        WHERE support_key.namespace_id = value_key.namespace_id
          AND support_key.fact_table = value_key.fact_table
          AND support_key.fact_row_id = value_key.fact_row_id
          AND support_key.exact_detail_family = value_key.exact_detail_family
          AND support_key.key_type = 'support_phrase'
        ORDER BY support_key.confidence DESC NULLS LAST, support_key.created_at DESC
        LIMIT 1
      ) support_key ON true
      WHERE value_key.namespace_id = $1
        AND value_key.key_type = 'value'
        AND value_key.key_text IS NOT NULL
    `,
    [namespaceId]
  );

  let inserted = 0;
  for (const row of rows.rows) {
    const answerValue = readString(row.key_text);
    if (!answerValue) {
      continue;
    }
    const metadata = row.metadata ?? {};
    const sourceSceneId = asUuid(metadata.source_scene_id);
    const sourceMemoryId = asUuid(metadata.source_memory_id);
    const sourceChunkId = asUuid(metadata.source_chunk_id);
    const supportPhrase = readString(row.support_phrase) ?? readString(metadata.support_phrase);
    const queryFamily = queryFamilyForExactDetailFamily(row.exact_detail_family);
    const result = await client.query<{ readonly id: string }>(
      `
        INSERT INTO compiled_fact_observations (
          namespace_id,
          subject_entity_id,
          query_family,
          exact_detail_family,
          predicate_family,
          property_key,
          answer_value,
          normalized_answer_value,
          truth_status,
          valid_from,
          valid_until,
          confidence,
          source_table,
          source_row_id,
          source_scene_id,
          source_memory_id,
          source_chunk_id,
          support_phrase,
          source_text,
          extractor,
          model_id,
          schema_version,
          promotion_status,
          admissibility_status,
          rejection_reason,
          metadata
        )
        VALUES (
          $1,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::timestamptz,
          $11::timestamptz,
          $12,
          $13,
          $14::uuid,
          $15::uuid,
          $16::uuid,
          $17::uuid,
          $18,
          $19,
          $20,
          $21,
          $22,
          'compiled',
          COALESCE($23, 'admissible'),
          NULL,
          $24::jsonb
        )
        ON CONFLICT (
          namespace_id,
          source_table,
          source_row_id,
          exact_detail_family,
          property_key,
          normalized_answer_value,
          subject_entity_id
        )
        DO UPDATE SET
          answer_value = EXCLUDED.answer_value,
          truth_status = EXCLUDED.truth_status,
          valid_from = EXCLUDED.valid_from,
          valid_until = EXCLUDED.valid_until,
          confidence = EXCLUDED.confidence,
          support_phrase = EXCLUDED.support_phrase,
          source_text = EXCLUDED.source_text,
          metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING id::text
      `,
      [
        namespaceId,
        row.subject_entity_id,
        queryFamily,
        row.exact_detail_family,
        readString(metadata.predicate_family) ?? row.property_key,
        row.property_key,
        answerValue,
        normalizeValue(answerValue),
        row.truth_status,
        row.valid_from,
        row.valid_until,
        row.confidence,
        row.fact_table,
        row.fact_row_id,
        sourceSceneId,
        sourceMemoryId,
        sourceChunkId,
        supportPhrase,
        supportPhrase ?? answerValue,
        readString(metadata.extractor),
        readString(metadata.model_id),
        readString(metadata.schema_version),
        readString(metadata.valueAdmissibilityStatus),
        JSON.stringify({
          ...metadata,
          support_phrase: supportPhrase ?? metadata.support_phrase ?? null,
          compiled_from_fact_key_id: row.id,
          authoritative_source: authoritativeSourceFromMetadata(row),
          fact_key_source_table: row.fact_table
        })
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function compileEventObservations(client: PoolClient, namespaceId: string): Promise<number> {
  const rows = await client.query<TemporalEventCompileRow>(
    `
      SELECT
        tef.id::text,
        tef.subject_entity_id::text,
        tef.pair_subject_entity_id::text,
        tef.predicate_family,
        tef.event_key,
        tef.event_type,
        tef.event_label,
        tef.object_entity_id::text,
        tef.object_value,
        tef.truth_status,
        tef.valid_from::text,
        tef.valid_until::text,
        tef.start_at::text,
        tef.end_at::text,
        tef.time_granularity,
        tef.exactness,
        tef.support_count,
        tef.metadata,
        (
          SELECT tes.snippet
          FROM temporal_event_support tes
          WHERE tes.temporal_event_fact_id = tef.id
            AND tes.snippet IS NOT NULL
          ORDER BY
            CASE tes.support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
            tes.occurred_at DESC NULLS LAST
          LIMIT 1
        ) AS support_phrase
      FROM temporal_event_facts tef
      WHERE tef.namespace_id = $1
    `,
    [namespaceId]
  );

  let inserted = 0;
  for (const row of rows.rows) {
    const objectValue = readString(row.object_value);
    const result = await client.query<{ readonly id: string }>(
      `
        INSERT INTO compiled_event_observations (
          namespace_id,
          subject_entity_id,
          pair_subject_entity_id,
          query_family,
          predicate_family,
          event_key,
          event_type,
          event_label,
          object_entity_id,
          object_value,
          normalized_object_value,
          location_value,
          time_granularity,
          exactness,
          truth_status,
          valid_from,
          valid_until,
          start_at,
          end_at,
          confidence,
          source_table,
          source_row_id,
          support_phrase,
          source_text,
          promotion_status,
          admissibility_status,
          rejection_reason,
          metadata
        )
        VALUES (
          $1,
          $2::uuid,
          $3::uuid,
          'temporal_detail',
          $4,
          $5,
          $6,
          $7,
          $8::uuid,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15::timestamptz,
          $16::timestamptz,
          $17::timestamptz,
          $18::timestamptz,
          $19,
          'temporal_event_facts',
          $20::uuid,
          $21,
          $22,
          $23,
          $24,
          $25,
          $26::jsonb
        )
        ON CONFLICT (
          namespace_id,
          source_table,
          source_row_id,
          predicate_family,
          event_key,
          normalized_object_value,
          subject_entity_id
        )
        DO UPDATE SET
          object_value = EXCLUDED.object_value,
          truth_status = EXCLUDED.truth_status,
          valid_from = EXCLUDED.valid_from,
          valid_until = EXCLUDED.valid_until,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          confidence = EXCLUDED.confidence,
          support_phrase = EXCLUDED.support_phrase,
          metadata = compiled_event_observations.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING id::text
      `,
      [
        namespaceId,
        row.subject_entity_id,
        row.pair_subject_entity_id,
        row.predicate_family,
        row.event_key,
        row.event_type,
        row.event_label,
        row.object_entity_id,
        objectValue,
        normalizeValue(objectValue),
        readString(row.metadata?.location_value) ?? readString(row.metadata?.location),
        row.time_granularity,
        row.exactness,
        row.truth_status,
        row.valid_from,
        row.valid_until,
        row.start_at,
        row.end_at,
        Math.min(0.99, Math.max(0.5, 0.65 + (row.support_count ?? 0) * 0.05)),
        row.id,
        row.support_phrase,
        row.support_phrase ?? objectValue ?? row.event_label ?? row.event_key,
        row.truth_status === "superseded" ? "rejected" : "compiled",
        objectValue ? "admissible" : "missing",
        objectValue ? null : "event_missing_object_value",
        JSON.stringify({
          ...(row.metadata ?? {}),
          support_count: row.support_count
        })
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function compileRelationshipObservations(client: PoolClient, namespaceId: string): Promise<number> {
  const rows = await client.query<RelationshipCompileRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        object_entity_id::text,
        predicate,
        confidence,
        valid_from::text,
        valid_until::text,
        source_memory_id::text,
        source_chunk_id::text,
        metadata
      FROM relationship_candidates
      WHERE namespace_id = $1
        AND status = 'accepted'
    `,
    [namespaceId]
  );
  let inserted = 0;
  for (const row of rows.rows) {
    const relationshipValue = readString(row.predicate);
    if (!relationshipValue) {
      continue;
    }
    const result = await client.query<{ readonly id: string }>(
      `
        INSERT INTO compiled_relationship_observations (
          namespace_id,
          subject_entity_id,
          object_entity_id,
          query_family,
          predicate_family,
          relationship_value,
          normalized_relationship_value,
          truth_status,
          valid_from,
          valid_until,
          confidence,
          source_table,
          source_row_id,
          source_memory_id,
          source_chunk_id,
          support_phrase,
          source_text,
          promotion_status,
          metadata
        )
        VALUES (
          $1,
          $2::uuid,
          $3::uuid,
          'profile_report',
          $4,
          $5,
          $6,
          'active',
          $7::timestamptz,
          $8::timestamptz,
          $9,
          'relationship_candidates',
          $10::uuid,
          $11::uuid,
          $12::uuid,
          $13,
          $14,
          'compiled',
          $15::jsonb
        )
      `,
      [
        namespaceId,
        row.subject_entity_id,
        row.object_entity_id,
        relationshipValue,
        relationshipValue,
        normalizeValue(relationshipValue),
        row.valid_from,
        row.valid_until,
        row.confidence,
        row.id,
        row.source_memory_id,
        row.source_chunk_id,
        readString(row.metadata?.snippet),
        readString(row.metadata?.snippet),
        JSON.stringify(row.metadata ?? {})
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function compileCoverageDiagnostics(client: PoolClient, namespaceId: string): Promise<number> {
  const rows = await client.query<NarrativeCoverageRow>(
    `
      SELECT id::text, scene_text, metadata
      FROM narrative_scenes
      WHERE namespace_id = $1
        AND metadata#>'{external_relation_ie,promotion_review,diagnostics}' IS NOT NULL
    `,
    [namespaceId]
  );
  let inserted = 0;
  for (const row of rows.rows) {
    const diagnostics = row.metadata?.external_relation_ie;
    const promotionReview =
      diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
        ? (diagnostics as JsonRecord).promotion_review
        : null;
    const diagnosticRows =
      promotionReview && typeof promotionReview === "object" && !Array.isArray(promotionReview)
        ? (promotionReview as JsonRecord).diagnostics
        : null;
    if (!Array.isArray(diagnosticRows)) {
      continue;
    }
    for (const diagnostic of diagnosticRows) {
      if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
        continue;
      }
      const record = diagnostic as JsonRecord;
      const promotionEligible = record.promotionEligible === true;
      const promotionRejectedReason = readString(record.promotionRejectedReason);
      const promotionStatus = promotionEligible ? "compiled" : promotionRejectedReason === "ambiguous_self_binding" ? "ambiguous" : "rejected";
      const result = await client.query<{ readonly id: string }>(
        `
          INSERT INTO compiled_memory_coverage (
            namespace_id,
            source_table,
            source_row_id,
            source_scene_id,
            compiler_stage,
            query_family,
            exact_detail_family,
            promotion_status,
            rejection_reason,
            support_phrase,
            source_text,
            confidence,
            metadata
          )
          VALUES (
            $1,
            'narrative_scenes',
            $2::uuid,
            $2::uuid,
            'exact_detail_fact_key_promotion',
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::jsonb
          )
        `,
        [
          namespaceId,
          row.id,
          record.inferredFamily ? queryFamilyForExactDetailFamily(String(record.inferredFamily)) : null,
          readString(record.inferredFamily),
          promotionStatus,
          promotionRejectedReason,
          readString(record.supportPhrase),
          row.scene_text,
          typeof record.extractorConfidence === "number" ? record.extractorConfidence : null,
          JSON.stringify(record)
        ]
      );
      inserted += result.rowCount ?? 0;
    }
  }
  return inserted;
}

export async function rebuildCompiledMemoryNamespaceForClient(
  client: PoolClient,
  namespaceId: string
): Promise<CompiledMemoryRebuildSummary> {
  await clearCompiledNamespace(client, namespaceId);
  const factObservations = await compileFactObservationsFromFactKeys(client, namespaceId);
  const eventObservations = await compileEventObservations(client, namespaceId);
  const relationshipObservations = await compileRelationshipObservations(client, namespaceId);
  const coverageRows = await compileCoverageDiagnostics(client, namespaceId);
  return {
    namespaceId,
    counts: {
      factObservations,
      eventObservations,
      relationshipObservations,
      coverageRows
    }
  };
}

export async function rebuildCompiledMemoryNamespace(namespaceId: string): Promise<CompiledMemoryRebuildSummary> {
  return withTransaction((client) => rebuildCompiledMemoryNamespaceForClient(client, namespaceId));
}

export async function loadCompiledExactDetailObservationRows(params: {
  readonly namespaceId: string;
  readonly exactDetailFamily: string;
  readonly subjectEntityId?: string | null;
  readonly allowUnboundSelfOwned?: boolean;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<readonly CompiledFactObservationLookupRow[]> {
  return queryRows<CompiledFactObservationLookupRow>(
    `
      SELECT
        id::text,
        namespace_id,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        query_family,
        exact_detail_family,
        predicate_family,
        property_key,
        answer_value,
        normalized_answer_value,
        truth_status,
        valid_from::text,
        valid_until::text,
        confidence,
        source_table,
        source_row_id::text,
        source_scene_id::text,
        source_memory_id::text,
        source_chunk_id::text,
        NULLIF(metadata->>'source_uri', '') AS source_uri,
        support_phrase,
        source_text,
        extractor,
        model_id,
        schema_version,
        promotion_status,
        admissibility_status,
        rejection_reason,
        metadata
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND promotion_status = 'compiled'
        AND truth_status <> 'superseded'
	        AND answer_value IS NOT NULL
	        AND (
	          ($3::uuid IS NOT NULL AND subject_entity_id = $3::uuid)
	          OR (
	            $4::boolean = true
	            AND subject_entity_id IS NULL
	            AND (
	              metadata->>'ownershipEvidenceStatus' IN ('explicit_ownership_cue', 'scene_self_binding', 'owner_bound', 'self_owned')
	              OR metadata->>'ownerBindingStatus' IN ('self_owned', 'owner_bound', 'explicit')
	              OR support_phrase ~* '\\m(i|me|my|mine|i''m|i''ve|i''d|i''ll)\\M'
	              OR source_text ~* '\\m(i|me|my|mine|i''m|i''ve|i''d|i''ll)\\M'
	            )
	          )
	        )
        AND ($5::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR (valid_from IS NOT NULL AND valid_from <= $6::timestamptz))
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        CASE source_table WHEN 'narrative_scenes' THEN 0 WHEN 'temporal_event_facts' THEN 1 WHEN 'canonical_facts' THEN 2 WHEN 'contract_projection_entries' THEN 3 WHEN 'canonical_states' THEN 4 ELSE 5 END,
        confidence DESC NULLS LAST,
        valid_from DESC NULLS LAST,
        created_at DESC
      LIMIT 12
    `,
    [
      params.namespaceId,
      params.exactDetailFamily,
      params.subjectEntityId ?? null,
      params.allowUnboundSelfOwned === true,
      params.timeStart ?? null,
      params.timeEnd ?? null
    ]
  );
}

export async function loadCompiledExactDetailObservationSubjectCounts(params: {
  readonly namespaceId: string;
  readonly exactDetailFamily: string;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<readonly { readonly subject_entity_id: string | null; readonly candidate_count: number }[]> {
  return queryRows<{ readonly subject_entity_id: string | null; readonly candidate_count: number }>(
    `
      SELECT
        subject_entity_id::text,
        SUM(
          CASE
            WHEN metadata->>'ownershipEvidenceStatus' IN ('explicit_ownership_cue', 'scene_self_binding') THEN 6
            WHEN source_table = 'narrative_scenes' THEN 4
            WHEN source_table = 'temporal_event_facts' THEN 3
            WHEN source_table = 'exact_detail_fact_keys' THEN 3
            WHEN source_table = 'canonical_facts' THEN 1
            WHEN source_table = 'contract_projection_entries' THEN 1
            ELSE 1
          END
        )::double precision AS candidate_count
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND promotion_status = 'compiled'
        AND truth_status <> 'superseded'
        AND answer_value IS NOT NULL
        AND subject_entity_id IS NOT NULL
        AND ($3::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $4::timestamptz)
      GROUP BY subject_entity_id
      ORDER BY candidate_count DESC, subject_entity_id ASC
      LIMIT 2
    `,
    [params.namespaceId, params.exactDetailFamily, params.timeStart ?? null, params.timeEnd ?? null]
  );
}

export async function loadCompiledDirectFactObservationRows(params: {
  readonly namespaceId: string;
  readonly directFactFamily: string;
  readonly names?: readonly string[];
  readonly limit?: number;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<readonly CompiledFactObservationLookupRow[]> {
  const names = [...new Set((params.names ?? []).map((name) => name.trim()).filter(Boolean))];
  return queryRows<CompiledFactObservationLookupRow>(
    `
      WITH requested_names AS (
        SELECT unnest($2::text[]) AS requested_name
      ),
      matched_entities AS (
        SELECT DISTINCT e.id
        FROM requested_names rn
        JOIN entities e
          ON e.namespace_id = $1
         AND e.entity_type IN ('self', 'person')
         AND e.normalized_name = lower(regexp_replace(rn.requested_name, '[^a-zA-Z0-9]+', ' ', 'g'))
        UNION
        SELECT DISTINCT e.id
        FROM requested_names rn
        JOIN entity_aliases ea
          ON ea.normalized_alias = lower(regexp_replace(rn.requested_name, '[^a-zA-Z0-9]+', ' ', 'g'))
        JOIN entities e ON e.id = ea.entity_id AND e.namespace_id = $1 AND e.entity_type IN ('self', 'person')
      )
      SELECT
        id::text,
        namespace_id,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        query_family,
        exact_detail_family,
        predicate_family,
        property_key,
        answer_value,
        normalized_answer_value,
        truth_status,
        valid_from::text,
        valid_until::text,
        confidence,
        source_table,
        source_row_id::text,
        source_scene_id::text,
        source_memory_id::text,
        source_chunk_id::text,
        NULLIF(metadata->>'source_uri', '') AS source_uri,
        support_phrase,
        source_text,
        extractor,
        model_id,
        schema_version,
        promotion_status,
        admissibility_status,
        rejection_reason,
        metadata
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family = 'direct_fact'
        AND property_key = $3
        AND promotion_status = 'compiled'
        AND admissibility_status = 'admissible'
        AND truth_status = 'active'
        AND answer_value IS NOT NULL
        AND support_phrase IS NOT NULL
        AND ($5::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR (valid_from IS NOT NULL AND valid_from <= $6::timestamptz))
        AND (
          cardinality($2::text[]) = 0
          OR subject_entity_id IN (SELECT id FROM matched_entities)
          OR lower(COALESCE(metadata->>'subject', '')) IN (SELECT lower(requested_name) FROM requested_names)
        )
      ORDER BY
        confidence DESC NULLS LAST,
        valid_from DESC NULLS LAST,
        created_at DESC
      LIMIT $4
    `,
    [
      params.namespaceId,
      names,
      `direct_fact:${params.directFactFamily}`,
      Math.max(1, params.limit ?? 8),
      params.timeStart ?? null,
      params.timeEnd ?? null
    ]
  );
}

export async function loadCompiledProfileInferenceObservationRows(params: {
  readonly namespaceId: string;
  readonly profileInferenceFamily: string;
  readonly names?: readonly string[];
  readonly limit?: number;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<readonly CompiledFactObservationLookupRow[]> {
  const names = [...new Set((params.names ?? []).map((name) => name.trim()).filter(Boolean))];
  return queryRows<CompiledFactObservationLookupRow>(
    `
      WITH requested_names AS (
        SELECT unnest($2::text[]) AS requested_name
      ),
      matched_entities AS (
        SELECT DISTINCT e.id
        FROM requested_names rn
        JOIN entities e
          ON e.namespace_id = $1
         AND e.entity_type IN ('self', 'person')
         AND e.normalized_name = lower(regexp_replace(rn.requested_name, '[^a-zA-Z0-9]+', ' ', 'g'))
        UNION
        SELECT DISTINCT e.id
        FROM requested_names rn
        JOIN entity_aliases ea
          ON ea.normalized_alias = lower(regexp_replace(rn.requested_name, '[^a-zA-Z0-9]+', ' ', 'g'))
        JOIN entities e ON e.id = ea.entity_id AND e.namespace_id = $1 AND e.entity_type IN ('self', 'person')
      )
      SELECT
        id::text,
        namespace_id,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        query_family,
        exact_detail_family,
        predicate_family,
        property_key,
        answer_value,
        normalized_answer_value,
        truth_status,
        valid_from::text,
        valid_until::text,
        confidence,
        source_table,
        source_row_id::text,
        source_scene_id::text,
        source_memory_id::text,
        source_chunk_id::text,
        NULLIF(metadata->>'source_uri', '') AS source_uri,
        support_phrase,
        source_text,
        extractor,
        model_id,
        schema_version,
        promotion_status,
        admissibility_status,
        rejection_reason,
        metadata
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family = 'profile_inference'
        AND property_key = $3
        AND promotion_status = 'compiled'
        AND admissibility_status = 'admissible'
        AND truth_status = 'active'
        AND answer_value IS NOT NULL
        AND support_phrase IS NOT NULL
        AND ($5::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR (valid_from IS NOT NULL AND valid_from <= $6::timestamptz))
        AND (
          cardinality($2::text[]) = 0
          OR subject_entity_id IN (SELECT id FROM matched_entities)
          OR pair_subject_entity_id IN (SELECT id FROM matched_entities)
          OR lower(COALESCE(metadata->>'subject', '')) IN (SELECT lower(requested_name) FROM requested_names)
          OR lower(COALESCE(metadata->>'pairSubject', '')) IN (SELECT lower(requested_name) FROM requested_names)
        )
      ORDER BY
        confidence DESC NULLS LAST,
        COALESCE((metadata->>'premiseCount')::int, 0) DESC,
        valid_from DESC NULLS LAST,
        created_at DESC
      LIMIT $4
    `,
    [
      params.namespaceId,
      names,
      `inference:${params.profileInferenceFamily}`,
      Math.max(1, params.limit ?? 8),
      params.timeStart ?? null,
      params.timeEnd ?? null
    ]
  );
}
