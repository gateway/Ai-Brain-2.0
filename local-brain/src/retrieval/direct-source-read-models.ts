import { queryRows } from "../db/client.js";
import type { RecallResult } from "../types.js";

interface DirectSourceChunkRow {
  readonly chunk_id: string;
  readonly artifact_id: string;
  readonly source_uri: string | null;
  readonly observed_at: string | null;
  readonly chunk_index: number;
  readonly text_content: string;
  readonly seed_match?: boolean | null;
  readonly topic_match?: boolean | null;
  readonly vector_distance?: number | null;
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function postgresRegexToJavascript(value: string | null | undefined): RegExp | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  try {
    return new RegExp(normalized.replace(/\\m|\\M/gu, "\\b"), "iu");
  } catch {
    return null;
  }
}

function boundedDirectSourceSnippet(params: {
  readonly text: string;
  readonly seedPattern?: string | null;
  readonly topicPattern?: string | null;
  readonly requiredPattern?: string | null;
}): string {
  const normalizedFallback = normalizeSnippet(params.text);
  const lines = params.text
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+(?=[A-Z][A-Za-z'’-]{1,40}:\s)/gu, "\n")
    .split(/\n+/u)
    .map(normalizeSnippet)
    .filter(Boolean);
  const seedRegex = postgresRegexToJavascript(params.seedPattern);
  const topicRegex = postgresRegexToJavascript(params.topicPattern);
  const requiredRegex = postgresRegexToJavascript(params.requiredPattern);
  const matchingIndexes = new Set<number>();
  lines.forEach((line, index) => {
    const topicMatches = topicRegex ? topicRegex.test(line) : true;
    const seedMatches = seedRegex ? seedRegex.test(line) : false;
    const requiredMatches = requiredRegex ? requiredRegex.test(line) : true;
    if (requiredMatches && (topicMatches || seedMatches)) {
      matchingIndexes.add(index);
      if (index > 0) matchingIndexes.add(index - 1);
      if (index + 1 < lines.length) matchingIndexes.add(index + 1);
    }
  });
  if (matchingIndexes.size === 0) {
    return normalizedFallback.slice(0, 1800);
  }
  const selected = [...matchingIndexes]
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n");
  return normalizeSnippet(selected).slice(0, 3600);
}

export function boundedDirectSourceSnippetForTest(params: {
  readonly text: string;
  readonly seedPattern?: string | null;
  readonly topicPattern?: string | null;
  readonly requiredPattern?: string | null;
}): string {
  return boundedDirectSourceSnippet(params);
}

function toRecallResult(
  namespaceId: string,
  row: DirectSourceChunkRow,
  tier: string,
  score: number,
  patterns?: {
    readonly seedPattern?: string | null;
    readonly topicPattern?: string | null;
    readonly requiredPattern?: string | null;
  },
  retrieval?: {
    readonly lexicalRank?: number;
    readonly vectorRank?: number;
  }
): RecallResult {
  return {
    memoryId: `${tier}:${row.chunk_id}`,
    memoryType: "artifact_derivation",
    content: boundedDirectSourceSnippet({
      text: row.text_content,
      seedPattern: patterns?.seedPattern,
      topicPattern: patterns?.topicPattern,
      requiredPattern: patterns?.requiredPattern
    }),
    score,
    artifactId: row.artifact_id,
    occurredAt: row.observed_at,
    namespaceId,
    provenance: {
      tier,
      source_chunk_id: row.chunk_id,
      source_uri: row.source_uri,
      chunk_index: row.chunk_index,
      retrieval: {
        rrfScore: score,
        lexicalRawScore: score,
        lexicalRank: retrieval?.lexicalRank,
        vectorRank: retrieval?.vectorRank
      }
    }
  };
}

interface RankedDirectSourceChunk {
  readonly row: DirectSourceChunkRow;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
}

function directSourceObservedAtEpoch(row: DirectSourceChunkRow): number {
  if (!row.observed_at) {
    return 0;
  }
  const parsed = Date.parse(row.observed_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function directSourceHybridScore(entry: RankedDirectSourceChunk): number {
  const lexicalScore = typeof entry.lexicalRank === "number" ? 1 / (entry.lexicalRank + 1) : 0;
  const vectorScore = typeof entry.vectorRank === "number" ? 1.25 / (entry.vectorRank + 1) : 0;
  const seedBoost = entry.row.seed_match === true ? 1 : 0;
  const topicBoost = entry.row.topic_match === true ? 2 : 0;
  const recencyBoost = directSourceObservedAtEpoch(entry.row) / 1_000_000_000_000_000;
  return topicBoost + seedBoost + lexicalScore + vectorScore + recencyBoost;
}

function mergeDirectSourceRows(params: {
  readonly namespaceId: string;
  readonly tier: string;
  readonly limit: number;
  readonly lexicalRows: readonly DirectSourceChunkRow[];
  readonly vectorRows: readonly DirectSourceChunkRow[];
  readonly patterns?: {
    readonly seedPattern?: string | null;
    readonly topicPattern?: string | null;
    readonly requiredPattern?: string | null;
  };
}): readonly RecallResult[] {
  const merged = new Map<string, RankedDirectSourceChunk>();

  params.lexicalRows.forEach((row, index) => {
    merged.set(row.chunk_id, {
      row,
      lexicalRank: index + 1
    });
  });

  params.vectorRows.forEach((row, index) => {
    const existing = merged.get(row.chunk_id);
    if (existing) {
      merged.set(row.chunk_id, {
        row: {
          ...existing.row,
          seed_match: existing.row.seed_match ?? row.seed_match ?? null,
          topic_match: existing.row.topic_match ?? row.topic_match ?? null,
          vector_distance: existing.row.vector_distance ?? row.vector_distance ?? null
        },
        lexicalRank: existing.lexicalRank,
        vectorRank: index + 1
      });
      return;
    }
    merged.set(row.chunk_id, {
      row,
      vectorRank: index + 1
    });
  });

  return [...merged.values()]
    .sort((left, right) => {
      const scoreDelta = directSourceHybridScore(right) - directSourceHybridScore(left);
      if (Math.abs(scoreDelta) > 1e-9) {
        return scoreDelta;
      }
      const observedDelta = directSourceObservedAtEpoch(right.row) - directSourceObservedAtEpoch(left.row);
      if (observedDelta !== 0) {
        return observedDelta;
      }
      return left.row.chunk_index - right.row.chunk_index;
    })
    .slice(0, params.limit)
    .map((entry, index) =>
      toRecallResult(params.namespaceId, entry.row, params.tier, 1 - index * 0.03, params.patterns, {
        lexicalRank: entry.lexicalRank,
        vectorRank: entry.vectorRank
      })
    );
}

export async function loadDirectOmiArtifactContextResults(params: {
  readonly namespaceId: string;
  readonly seedPattern: string;
  readonly topicPattern: string;
  readonly requiredPattern?: string | null;
  readonly seedArtifactLimit?: number;
  readonly tier: string;
  readonly limit: number;
}): Promise<readonly RecallResult[]> {
  const limit = Math.max(1, params.limit);
  const seedArtifactLimit = Math.max(1, params.seedArtifactLimit ?? 3);
  const rows = await queryRows<DirectSourceChunkRow>(
    `
      WITH seed_artifacts AS (
        SELECT DISTINCT ac.artifact_id, max(ao.observed_at) AS observed_at
        FROM (
          SELECT a.id
          FROM artifacts a
          LEFT JOIN artifact_observations ao_recent ON ao_recent.artifact_id = a.id
          WHERE a.namespace_id = $1
            AND (
              a.uri LIKE '%/omi-archive/normalized/%'
              OR a.uri LIKE '%/data/inbox/omi/normalized/%'
              OR a.uri LIKE '%/omi-watch-smoke/%'
              OR a.source_channel IN ('omi', 'personal_omi_review_fixture')
              OR a.metadata->>'benchmark' = 'personal_omi_review'
            )
          GROUP BY a.id, a.uri
          ORDER BY max(ao_recent.observed_at) DESC NULLS LAST, a.uri DESC
          LIMIT 512
        ) omi_artifacts
        JOIN artifact_chunks ac ON ac.artifact_id = omi_artifacts.id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE lower(ac.text_content) ~ $2
          AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
        GROUP BY ac.artifact_id
        ORDER BY max(ao.observed_at) DESC NULLS LAST
        LIMIT $6
      )
      SELECT
        ac.id AS chunk_id,
        ac.artifact_id,
        a.uri AS source_uri,
        ao.observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifact_chunks ac
      JOIN seed_artifacts seed ON seed.artifact_id = ac.artifact_id
      JOIN artifacts a ON a.id = ac.artifact_id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE lower(ac.text_content) ~ $3
        AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
      ORDER BY
        CASE WHEN lower(ac.text_content) ~ $2 THEN 0 ELSE 1 END,
        ao.observed_at DESC NULLS LAST,
        ac.chunk_index ASC
      LIMIT $4
    `,
    [params.namespaceId, params.seedPattern, params.topicPattern, limit, params.requiredPattern?.trim() || null, seedArtifactLimit]
  );
  return rows.map((row, index) =>
    toRecallResult(params.namespaceId, row, params.tier, 1 - index * 0.03, {
      seedPattern: params.seedPattern,
      topicPattern: params.topicPattern,
      requiredPattern: params.requiredPattern
    })
  );
}

export async function loadDirectArtifactContextResults(params: {
  readonly namespaceId: string;
  readonly seedPattern: string;
  readonly topicPattern: string;
  readonly requiredPattern?: string | null;
  readonly seedArtifactLimit?: number;
  readonly tier: string;
  readonly limit: number;
  readonly queryEmbedding?: readonly number[] | null;
}): Promise<readonly RecallResult[]> {
  const limit = Math.max(1, params.limit);
  const seedArtifactLimit = Math.max(1, params.seedArtifactLimit ?? 6);
  const lexicalRows = await queryRows<DirectSourceChunkRow>(
    `
      WITH seed_artifacts AS (
        SELECT
          ac.artifact_id,
          max(COALESCE(ao.observed_at, a.created_at)) AS observed_at
        FROM artifact_chunks ac
        JOIN artifacts a ON a.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE a.namespace_id = $1
          AND lower(ac.text_content) ~ $2
          AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
        GROUP BY ac.artifact_id
        ORDER BY max(COALESCE(ao.observed_at, a.created_at)) DESC NULLS LAST, ac.artifact_id DESC
        LIMIT $6
      )
      SELECT
        ac.id AS chunk_id,
        ac.artifact_id,
        a.uri AS source_uri,
        ao.observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifact_chunks ac
      JOIN seed_artifacts seed ON seed.artifact_id = ac.artifact_id
      JOIN artifacts a ON a.id = ac.artifact_id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE lower(ac.text_content) ~ $3
        AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
      ORDER BY
        CASE WHEN lower(ac.text_content) ~ $2 THEN 0 ELSE 1 END,
        seed.observed_at DESC NULLS LAST,
        ao.observed_at DESC NULLS LAST,
        ac.chunk_index ASC
      LIMIT $4
    `,
    [params.namespaceId, params.seedPattern, params.topicPattern, limit, params.requiredPattern?.trim() || null, seedArtifactLimit]
  );
  if (!params.queryEmbedding || params.queryEmbedding.length === 0) {
    return lexicalRows.map((row, index) =>
      toRecallResult(params.namespaceId, row, params.tier, 1 - index * 0.03, {
        seedPattern: params.seedPattern,
        topicPattern: params.topicPattern,
        requiredPattern: params.requiredPattern
      }, {
        lexicalRank: index + 1
      })
    );
  }

  const vectorLiteral = `[${params.queryEmbedding.join(",")}]`;
  const vectorRows = await queryRows<DirectSourceChunkRow>(
    `
      WITH seed_artifacts AS (
        SELECT
          ac.artifact_id,
          max(COALESCE(ao.observed_at, a.created_at)) AS observed_at
        FROM artifact_chunks ac
        JOIN artifacts a ON a.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE a.namespace_id = $1
          AND lower(ac.text_content) ~ $2
          AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
        GROUP BY ac.artifact_id
        ORDER BY max(COALESCE(ao.observed_at, a.created_at)) DESC NULLS LAST, ac.artifact_id DESC
        LIMIT $7
      ),
      vector_chunk_rows AS (
        SELECT DISTINCT ON (ac.id)
          ac.id AS chunk_id,
          ac.artifact_id,
          a.uri AS source_uri,
          ao.observed_at,
          ac.chunk_index,
          ac.text_content,
          (lower(ac.text_content) ~ $2) AS seed_match,
          (lower(ac.text_content) ~ $3) AS topic_match,
          (ad.embedding <=> $6::vector) AS vector_distance
        FROM artifact_derivations ad
        JOIN artifact_chunks ac ON ac.id = ad.source_chunk_id
        JOIN seed_artifacts seed ON seed.artifact_id = ac.artifact_id
        JOIN artifacts a ON a.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE a.namespace_id = $1
          AND ad.embedding IS NOT NULL
          AND ad.source_chunk_id IS NOT NULL
          AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
        ORDER BY ac.id, (ad.embedding <=> $6::vector) ASC, ad.created_at DESC
      )
      SELECT
        chunk_id,
        artifact_id,
        source_uri,
        observed_at,
        chunk_index,
        text_content,
        seed_match,
        topic_match,
        vector_distance
      FROM vector_chunk_rows
      ORDER BY
        topic_match DESC,
        seed_match DESC,
        vector_distance ASC,
        observed_at DESC NULLS LAST,
        chunk_index ASC
      LIMIT $4
    `,
    [params.namespaceId, params.seedPattern, params.topicPattern, Math.max(limit * 3, 12), params.requiredPattern?.trim() || null, vectorLiteral, seedArtifactLimit]
  );

  return mergeDirectSourceRows({
    namespaceId: params.namespaceId,
    tier: params.tier,
    limit,
    lexicalRows,
    vectorRows,
    patterns: {
      seedPattern: params.seedPattern,
      topicPattern: params.topicPattern,
      requiredPattern: params.requiredPattern
    }
  });
}

export async function loadDirectArtifactWindowResults(params: {
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly tier: string;
  readonly limit: number;
  readonly topicPattern?: string | null;
  readonly requiredPattern?: string | null;
  readonly sortOrder?: "asc" | "desc";
}): Promise<readonly RecallResult[]> {
  const limit = Math.max(1, params.limit);
  const sortOrder = params.sortOrder === "asc" ? "ASC" : "DESC";
  const rows = await queryRows<DirectSourceChunkRow>(
    `
      SELECT
        ac.id AS chunk_id,
        ac.artifact_id,
        a.uri AS source_uri,
        COALESCE(ao.observed_at, a.created_at) AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE a.namespace_id = $1
        AND COALESCE(ao.observed_at, a.created_at) >= $2::timestamptz
        AND COALESCE(ao.observed_at, a.created_at) <= $3::timestamptz
        AND ($4::text IS NULL OR lower(ac.text_content) ~ $4)
        AND ($5::text IS NULL OR lower(ac.text_content) ~ $5)
      ORDER BY
        CASE WHEN $4::text IS NOT NULL AND lower(ac.text_content) ~ $4 THEN 0 ELSE 1 END,
        COALESCE(ao.observed_at, a.created_at) ${sortOrder},
        ac.chunk_index ASC
      LIMIT $6
    `,
    [
      params.namespaceId,
      params.timeStart,
      params.timeEnd,
      params.topicPattern?.trim() || null,
      params.requiredPattern?.trim() || null,
      limit
    ]
  );
  return rows.map((row, index) =>
    toRecallResult(params.namespaceId, row, params.tier, 1 - index * 0.03, {
      seedPattern: params.topicPattern,
      topicPattern: params.topicPattern,
      requiredPattern: params.requiredPattern
    })
  );
}

export async function loadDirectWarmStartTopicResults(params: {
  readonly namespaceId: string;
  readonly limit: number;
}): Promise<readonly RecallResult[]> {
  const rows = await queryRows<DirectSourceChunkRow & { readonly priority: number; readonly topic: string }>(
    `
      SELECT
        topic_rows.chunk_id,
        topic_rows.artifact_id,
        a.uri AS source_uri,
        ao.observed_at,
        topic_rows.chunk_index,
        topic_rows.text_content,
        topic_rows.priority,
        topic_rows.topic
      FROM (
        SELECT DISTINCT ON (topic)
          priority,
          topic,
          chunk_id,
          artifact_id,
          artifact_observation_id,
          chunk_index,
          text_content,
          observed_at
        FROM (
          WITH recent_omi_artifacts AS (
            SELECT a.id
            FROM artifacts a
            LEFT JOIN artifact_observations ao_recent ON ao_recent.artifact_id = a.id
            WHERE a.namespace_id = $1
              AND (
              a.uri LIKE '%/omi-archive/normalized/%'
              OR a.uri LIKE '%/data/inbox/omi/normalized/%'
              OR a.uri LIKE '%/omi-watch-smoke/%'
              OR a.source_channel IN ('omi', 'personal_omi_review_fixture')
              OR a.metadata->>'benchmark' = 'personal_omi_review'
            )
            GROUP BY a.id, a.uri
            ORDER BY max(ao_recent.observed_at) DESC NULLS LAST, a.uri DESC
            LIMIT 64
          )
          SELECT
            t.priority,
            t.topic,
            ac.id AS chunk_id,
            ac.artifact_id,
            ac.artifact_observation_id,
            ac.chunk_index,
            ac.text_content,
            ao.observed_at
          FROM (
            VALUES
              (1, 'ai_brain', 'ai brain'),
              (2, 'preset_kitchen', 'preset kitchen'),
              (3, 'bumblebee', 'bumblebee'),
              (4, 'two_way', 'two[- ]?way'),
              (5, 'well_inked', 'well ?inked|wellinked')
          ) AS t(priority, topic, pattern)
          JOIN recent_omi_artifacts roa ON true
          JOIN artifact_chunks ac ON ac.artifact_id = roa.id AND lower(ac.text_content) ~ t.pattern
          JOIN artifacts a ON a.id = ac.artifact_id
          LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        ) matches
        ORDER BY topic, observed_at DESC NULLS LAST, chunk_index ASC
      ) topic_rows
      JOIN artifacts a ON a.id = topic_rows.artifact_id
      LEFT JOIN artifact_observations ao ON ao.id = topic_rows.artifact_observation_id
      ORDER BY topic_rows.priority ASC
      LIMIT $2
    `,
    [params.namespaceId, Math.max(1, params.limit)]
  );
  return rows.map((row, index) => toRecallResult(params.namespaceId, row, "warm_start_recent_context", 1 - index * 0.03));
}
