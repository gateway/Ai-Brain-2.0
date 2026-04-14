import {
  buildCausalMotiveEvidenceQueryText,
  buildIdentityEvidenceQueryText,
  buildProfileInferenceRetrievalSpec,
  buildSharedCommonalityEvidenceQueryText
} from "../query-builders.js";
import type { SearchRow } from "../internal-types.js";
import type { AnswerRetrievalPlan } from "../../types.js";
import type { SupportLoaderHelpers } from "./contracts.js";
import { mergeAndLimitSearchRowsByScore } from "./contracts.js";

export function loadCurrentProjectSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, candidateLimit } = params;
  const terms = [
    "working on",
    "project",
    "projects",
    "focused on",
    "Well Inked",
    "Two Way",
    "2way",
    "Preset Kitchen",
    "AI brain"
  ];
  const episodicMatch = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = helpers.buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  return Promise.all([
    helpers.queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ((
            ${episodicMatch.scoreExpression}
          ) +
            CASE
              WHEN em.content ~* '(well inked|two way|2way|preset kitchen|ai brain)' THEN 5.1
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(working on|projects? i am working on|current project|focused on|this week)' THEN 2.2
              ELSE 0
            END +
            2.0
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'current_project_scope',
            'source_uri', a.uri,
            'artifact_observation_id', em.artifact_observation_id,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND ${trustedSourceClause}
          AND ${episodicMatch.clause}
        ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
        LIMIT $${episodicMatch.values.length + 2}
      `,
      [namespaceId, ...episodicMatch.values, Math.max(candidateLimit, 8)]
    ),
    helpers.queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${helpers.artifactDerivationContentExpression()} AS content,
          ((
            ${derivationMatch.scoreExpression}
          ) +
            CASE
              WHEN ad.content_text ~* '(well inked|two way|2way|preset kitchen|ai brain)' THEN 4.7
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(working on|projects? i am working on|current project|focused on|this week)' THEN 2.0
              ELSE 0
            END +
            1.8
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'current_project_scope',
            'derivation_type', ad.derivation_type,
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
          AND ${trustedSourceClause}
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${derivationMatch.values.length + 2}
      `,
      [namespaceId, ...derivationMatch.values, Math.max(candidateLimit, 8)]
    )
  ]).then(([episodicRows, derivationRows]) =>
    mergeAndLimitSearchRowsByScore([...episodicRows, ...derivationRows], Math.max(candidateLimit, 10), helpers)
  );
}

export function loadProfileInferenceSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly retrievalPlan: AnswerRetrievalPlan | null;
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, retrievalPlan, candidateLimit, timeStart, timeEnd } = params;
  const retrievalSpec = buildProfileInferenceRetrievalSpec(queryText, plannerTerms, retrievalPlan);
  const match = helpers.buildFocusedLikeMatchClause(4, retrievalSpec.terms, "em.content");
  const bannedMatch = helpers.buildFocusedLikeMatchClause(4 + match.values.length, retrievalSpec.bannedTerms, "em.content");
  const scorePieces = [
    `(${match.scoreExpression})`,
    ...retrievalSpec.positiveScoreExpressions,
    ...retrievalSpec.penaltyScoreExpressions
  ];
  if (bannedMatch.values.length > 0) {
    scorePieces.push(`(-0.75 * (${bannedMatch.scoreExpression}))`);
  }
  const scoreExpression = scorePieces.length > 0 ? scorePieces.join(" + ") : "0::double precision";

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (${scoreExpression})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'profile_inference_scope',
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
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + bannedMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...bannedMatch.values, Math.max(candidateLimit, 8)]
  );
}

export function loadIdentitySupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildIdentityEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "em.content");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(transgender|nonbinary|gender identity|transition|trans community|trans woman|trans man|queer|lgbtq|identity)' THEN 3
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(accept(?:ed|ance)?|embrace|safe place|self-expression|community)' THEN 1.5
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'identity_scope',
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
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 10)]
  );
}

export function loadSharedCommonalityRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildSharedCommonalityEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 16);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "em.content");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(both|same here|me too|we both|shared|in common)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(dance|dancing|stress relief|de-stress|destress|business|job|lost my job|own business)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(volunteer|volunteering|homeless shelter|shelter|fundraiser|food and supplies|food|supplies)' THEN 3
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'shared_commonality_scope',
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
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit * 2, 16)]
  );
}

export function loadCausalNarrativeRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildCausalMotiveEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "em.content");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(because|decided|started|starting|wanted to|want to|dream|passion|share|inspired)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(lost my job|job was hard|pushed me|gave me the push|take the plunge)' THEN 2
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'causal_motive_scope',
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
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit * 2, 14)]
  );
}
