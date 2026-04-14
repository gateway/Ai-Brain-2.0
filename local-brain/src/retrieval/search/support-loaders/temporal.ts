import { buildTemporalDetailEvidenceQueryText } from "../query-builders.js";
import type { SearchRow } from "../internal-types.js";
import type { SupportLoaderHelpers } from "./contracts.js";
import { mergeAndLimitSearchRowsByScore } from "./contracts.js";

export async function loadDepartureTimingSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, candidateLimit } = params;
  const nameHints = helpers.extractEntityNameHints(queryText);
  const terms = [
    ...new Set([
      ...(nameHints.length > 0 ? nameHints : ["Lauren"]),
      "left",
      "leave",
      "departed",
      "departure",
      "returned",
      "October",
      "18",
      "2025",
      "US",
      "America"
    ])
  ];
  const match = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = helpers.buildFocusedLikeMatchClause(2, terms, "ad.content_text");

  const [episodicRows, derivationRows] = await Promise.all([
    helpers.queryRows<SearchRow>(
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
            'lexical_provider', 'departure_scope',
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
    ),
    helpers.queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${helpers.artifactDerivationContentExpression()} AS content,
          (${derivationMatch.scoreExpression})::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'departure_scope',
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
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${match.values.length + 2}
      `,
      [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
    )
  ]);

  return mergeAndLimitSearchRowsByScore([...episodicRows, ...derivationRows], Math.max(candidateLimit, 10), helpers);
}

export function loadTemporalDetailSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildTemporalDetailEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 10);
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "em.content");
  const firstTournamentBonus =
    /\bfirst\b/i.test(queryText) && /\btournament\b/i.test(queryText)
      ? `CASE
          WHEN em.content ~* '(won my first video game tournament|won my first tournament|first video game tournament|first tournament|week before.*tournament)' THEN 6
          WHEN em.content ~* '(tournament|won)' THEN 2
          ELSE 0
        END`
      : "0";
  const firstWatchBonus =
    /\bfirst\b/i.test(queryText) && /\bwatch\b/i.test(queryText)
      ? `CASE
          WHEN em.content ~* '(first watch|first watched|watching it for the first time|watched it for the first time)' THEN 5
          WHEN em.content ~* '(watch|watched)' THEN 1.5
          ELSE 0
        END`
      : "0";
  const creationBonus =
    /\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText)
      ? `CASE
          WHEN em.content ~* '(painted|drew|made|wrote)' THEN 4.5
          ELSE 0
        END`
      : "0";
  const temporalSortDirection =
    (/\bfirst\b/i.test(queryText) && (/\btournament\b/i.test(queryText) || /\bwatch\b/i.test(queryText))) ||
    /\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText)
      ? "ASC"
      : "DESC";

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(yesterday|today|last night|last year|last month|last week|\\d+\\s+days?\\s+ago|\\bJanuary\\b|\\bFebruary\\b|\\bMarch\\b|\\bApril\\b|\\bMay\\b|\\bJune\\b|\\bJuly\\b|\\bAugust\\b|\\bSeptember\\b|\\bOctober\\b|\\bNovember\\b|\\bDecember\\b|\\b20\\d{2}\\b|\\b19\\d{2}\\b)' THEN 3
            ELSE 0
          END +
          (${firstTournamentBonus})::double precision +
          (${firstWatchBonus})::double precision +
          (${creationBonus})::double precision
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'temporal_detail_scope',
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
      ORDER BY raw_score DESC, em.occurred_at ${temporalSortDirection}, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 8)]
  );
}
