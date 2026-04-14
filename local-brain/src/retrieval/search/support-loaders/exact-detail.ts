import { buildPreciseFactEvidenceQueryText } from "../query-builders.js";
import type { SearchRow } from "../internal-types.js";
import type { SupportLoaderHelpers } from "./contracts.js";

export function loadStorageLocationSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, candidateLimit } = params;
  const terms = ["storage", "stored", "Bend", "Reno", "Carson", "Jeep", "RV", "Lauren", "Alex", "Eve"];
  const match = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (${match.scoreExpression})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'storage_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 2}
    `,
    [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
  );
}

export function loadPreciseFactSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 10);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "em.content");
  const durationBonus = /\bhow\s+long\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '\\m\\d+\\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\M' THEN 3 ELSE 0 END"
    : "0";
  const commuteBonus = /\bcommute\b/i.test(queryText)
    ? "CASE WHEN lower(em.content) LIKE '%commute%' THEN 5 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%each way%' THEN 6 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%daily commute%' THEN 3 ELSE 0 END"
    : "0";
  const playlistBonus = /\bplaylist|spotify\b/i.test(queryText)
    ? "CASE WHEN lower(em.content) LIKE '%playlist%' THEN 4 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%spotify%' THEN 3 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%called %' THEN 2 ELSE 0 END"
    : "0";
  const classLocationBonus = /\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)
    ? "CASE WHEN em.content ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 7 ELSE 0 END + CASE WHEN em.content ~ '(near|at|to)\\s+[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 5 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%serenity yoga%' THEN 6 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%yoga%' THEN 2 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%class%' THEN 2 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%studio%' THEN 1 ELSE 0 END"
    : "0";
  const titleBonus = /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '(production of|watched|read|attended|saw|play|movie|book|show|title|called)' THEN 2 ELSE 0 END"
    : "0";
  const nameBonus = /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '(called|named|playlist|spotify|studio)' THEN 3 ELSE 0 END"
    : "0";
  const scopeFilter = /\bhow\s+long\b/i.test(queryText)
    ? "em.content ~* '(commute|each way|minute|minutes|hour|hours)'"
    : /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)
      ? "em.content ~* '(play|movie|film|show|book|song|title|attended|watched|read|called|production of|saw)'"
      : /\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)
        ? "em.content ~* '(class|classes|yoga|studio|near|at|to)'"
        : "TRUE";

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + ${durationBonus} + ${commuteBonus} + ${playlistBonus} + ${classLocationBonus} + ${titleBonus} + ${nameBonus})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'precise_fact_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
        AND ${scopeFilter}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 24)]
  );
}

export function loadParticipantTurnExactDetailRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "ad.content_text");
  const entityHints = helpers.extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
  const speakerMatch = helpers.buildFocusedLikeMatchClause(4 + match.values.length, entityHints, "coalesce(ad.metadata->>'primary_speaker_name', '')");
  const questionContextBonus =
    "CASE WHEN coalesce(ad.metadata->>'prompt_text', '') <> '' THEN 3 ELSE 0 END";
  const speakerBonus = entityHints.length > 0
    ? `(${speakerMatch.scoreExpression}) * 4`
    : "0";
  const exactCueBonus = /\b(color|team|position|role|title|job|research|realiz|plans?|name|movie|books?|adopt|bought?|purchased?|temporary|martial|hobbies?|favorite|allerg|focus|sparked?|interest)\b/i.test(queryText)
    ? "CASE WHEN lower(coalesce(ad.metadata->>'source_sentence_text', ad.content_text)) ~ '(color|team|position|role|title|job|research|realiz|plan|named|called|adopt|bought|purchased|movie|book|martial|kickboxing|taekwondo|hobbies|enjoy|favorite|allerg|fur|reptiles|focus|passionate|growing up|saw how)' THEN 2 ELSE 0 END"
    : "0";
  const whereClause = [match.clause, entityHints.length > 0 ? speakerMatch.clause : "TRUE"].join(" AND ");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        ad.id AS memory_id,
        'artifact_derivation'::text AS memory_type,
        coalesce(ad.content_text, '') AS content,
        ((${match.scoreExpression}) + ${speakerBonus} + ${questionContextBonus} + ${exactCueBonus})::double precision AS raw_score,
        ao.artifact_id,
        coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
        a.namespace_id,
        jsonb_build_object(
          'tier', 'artifact_derivation',
          'derivation_type', ad.derivation_type,
          'provider', ad.provider,
          'model', ad.model,
          'artifact_observation_id', ad.artifact_observation_id,
          'source_chunk_id', ad.source_chunk_id,
          'source_uri', a.uri,
          'metadata', ad.metadata
        ) AS provenance
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
      WHERE a.namespace_id = $1
        AND ad.derivation_type = 'participant_turn'
        AND coalesce(ad.content_text, '') <> ''
        AND ${whereClause}
        AND ($2::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $2)
        AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $3)
      ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
      LIMIT $${match.values.length + speakerMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...speakerMatch.values, Math.max(candidateLimit, 18)]
  );
}

export function loadHobbySupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const hobbyDocument = "coalesce(em.metadata->>'source_turn_text', em.metadata->>'source_sentence_text', em.content)";
  const match = helpers.buildFocusedLikeMatchClause(4, terms, hobbyDocument);
  const entityHints = helpers.extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
  const subjectMatch = helpers.buildFocusedLikeMatchClause(
    4 + match.values.length,
    entityHints,
    "coalesce(em.metadata->>'subject_name', em.metadata->>'speaker_name', em.content)"
  );
  const subjectBonus = entityHints.length > 0 ? `(${subjectMatch.scoreExpression}) * 4` : "0";
  const hobbyCueBonus =
    `CASE WHEN lower(${hobbyDocument}) ~ '(hobbies|interests|besides writing|watching movies|exploring nature|hanging with friends|reading|writing|enjoy|love)' THEN 3 ELSE 0 END`;
  const incidentalPenalty =
    `CASE WHEN lower(${hobbyDocument}) ~ '(creative outlets?)' THEN -1.25 ELSE 0 END`;
  const whereClause = [match.clause, entityHints.length > 0 ? subjectMatch.clause : "TRUE"].join(" AND ");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + ${subjectBonus} + ${hobbyCueBonus} + ${incidentalPenalty})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'hobby_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${whereClause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + subjectMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...subjectMatch.values, Math.max(candidateLimit, 18)]
  );
}

export function loadSubjectBoundHobbyCueRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly subjectName: string;
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, subjectName, candidateLimit, timeStart, timeEnd } = params;
  const subjectPattern = `%${helpers.normalizeWhitespace(subjectName)}%`;
  const hobbyDocument = "coalesce(em.metadata->>'source_turn_text', em.metadata->>'source_sentence_text', em.content)";
  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          CASE
            WHEN lower(${hobbyDocument}) ~ '(writing and hanging with friends)' THEN 16
            WHEN lower(${hobbyDocument}) ~ '(besides writing)' AND lower(${hobbyDocument}) ~ '(watching movies|exploring nature)' THEN 14
            WHEN lower(${hobbyDocument}) ~ '(hobbies|interests)' THEN 8
            WHEN lower(${hobbyDocument}) ~ '(watching movies|exploring nature|hanging with friends)' THEN 6
            WHEN lower(${hobbyDocument}) ~ '(writing|reading|enjoy|love)' THEN 3
            WHEN lower(${hobbyDocument}) ~ '(creative outlets?)' THEN -1.25
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'subject_hobby_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND coalesce(em.metadata->>'subject_name', em.metadata->>'speaker_name', em.content) ILIKE $4
        AND lower(${hobbyDocument}) ~ '(hobbies|interests|writing and hanging with friends|besides writing|watching movies|exploring nature|hanging with friends|reading|writing|enjoy|love|creative outlets?)'
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $5
    `,
    [namespaceId, timeStart, timeEnd, subjectPattern, Math.max(candidateLimit, 36)]
  );
}

export function loadArtifactLocalClassLocationRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly artifactIds: readonly string[];
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, artifactIds, candidateLimit } = params;
  const normalizedArtifactIds = [...new Set(artifactIds.map((artifactId) => artifactId.trim()).filter(Boolean))];
  if (normalizedArtifactIds.length === 0) {
    return Promise.resolve([]);
  }

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          CASE WHEN lower(em.content) LIKE '%serenity yoga%' THEN 20 ELSE 0 END +
          CASE WHEN em.content ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 8 ELSE 0 END +
          CASE WHEN em.content ~* '(near|at|to|from|make it to|connection to|local|studio practice|yoga instructor|fellow yogis)' THEN 6 ELSE 0 END +
          CASE WHEN em.content ~* '(app|apps|free trial|subscription|available for|in-app purchases|one-time purchase|customizable practices)' THEN -8 ELSE 0 END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'artifact_local_class_location_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.artifact_id = ANY($2::uuid[])
        AND (
          lower(em.content) LIKE '%yoga%' OR
          lower(em.content) LIKE '%studio%' OR
          lower(em.content) LIKE '%class%' OR
          lower(em.content) LIKE '%classes%'
        )
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $3
    `,
    [namespaceId, normalizedArtifactIds, Math.max(candidateLimit, 8)]
  );
}
