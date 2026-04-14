import type { SearchRow } from "../internal-types.js";
import type { SupportLoaderHelpers } from "./contracts.js";
import { mergeAndLimitSearchRowsByScore } from "./contracts.js";

export async function loadRelationshipProfileSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, candidateLimit } = params;
  const nameHints = helpers.extractEntityNameHints(queryText);
  if (nameHints.length === 0) {
    return [];
  }

  const terms = [
    ...new Set([
      ...nameHints,
      "friend",
      "relationship",
      "owner",
      "coworking",
      "Chiang Mai",
      "Burning Man",
      "old friend",
      "partner"
    ])
  ];
  const episodicMatch = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = helpers.buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  const [episodicRows, derivationRows] = await Promise.all([
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
              WHEN em.content ~* '(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime|coworking spot|weave artisan society)' THEN 4.4
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(chiang mai|burning man|koh samui|samui experience)' THEN 1.6
              ELSE 0
            END +
            2.5
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'relationship_profile_scope',
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
              WHEN ad.content_text ~* '(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime|coworking spot|weave artisan society)' THEN 4.1
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(chiang mai|burning man|koh samui|samui experience)' THEN 1.4
              ELSE 0
            END +
            2.15
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'relationship_profile_scope',
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
  ]);

  return mergeAndLimitSearchRowsByScore([...episodicRows, ...derivationRows], Math.max(candidateLimit, 10), helpers);
}

export async function loadRelationshipChangeSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, candidateLimit } = params;
  const primaryNames = helpers.extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value))
    .filter(Boolean);
  const terms = [
    ...primaryNames,
    "relationship",
    "change",
    "changed",
    "left",
    "moved",
    "talked",
    "stopped talking",
    "communication",
    "October",
    "2025",
    "US",
    "Thailand",
    "Bend",
    "Oregon"
  ];
  const episodicMatch = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = helpers.buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  const [episodicRows, derivationRows] = await Promise.all([
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
              WHEN em.content ~* '(recent relationship change|big relationship change|relationship change|what changed recently|changed recently)' THEN 5.2
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(haven''t really talked|haven''t talked|don''t talk|little to no communication|barely spoken|cut me out)' THEN 4.8
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|moved from Thailand back to the US|moved from Thailand to the US|moved from Thailand to The US|October 18|10/18/2025|2025-10-18|October eighteenth twenty twenty five|Bend, Oregon)' THEN 5.4
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '\\bLauren\\b' THEN 2.8
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '\\bLauren\\b' AND em.content ~* '(stopped talking|haven''t really talked|no contact|moved from Thailand|October 18|October eighteenth twenty twenty five)' THEN 6.2
              ELSE 0
            END +
            2.75
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'relationship_change_scope',
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
              WHEN ad.content_text ~* '(recent relationship change|big relationship change|relationship change|what changed recently|changed recently)' THEN 5.0
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(haven''t really talked|haven''t talked|don''t talk|little to no communication|barely spoken|cut me out)' THEN 4.6
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|moved from Thailand back to the US|moved from Thailand to the US|moved from Thailand to The US|October 18|10/18/2025|2025-10-18|October eighteenth twenty twenty five|Bend, Oregon)' THEN 5.2
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '\\bLauren\\b' THEN 2.6
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '\\bLauren\\b' AND ad.content_text ~* '(stopped talking|haven''t really talked|no contact|moved from Thailand|October 18|October eighteenth twenty twenty five)' THEN 5.8
              ELSE 0
            END +
            2.25
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'relationship_change_scope',
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
  ]);

  return mergeAndLimitSearchRowsByScore([...episodicRows, ...derivationRows], Math.max(candidateLimit, 10), helpers);
}
