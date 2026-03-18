-- 005_retrieval_functions.sql
-- Safe baseline retrieval functions for the local brain.
-- Uses PostgreSQL full-text + pgvector. Upgrade lexical ranking later if a
-- richer BM25 extension path is installed.

CREATE OR REPLACE FUNCTION brain_recall_candidates(
    p_namespace_id text,
    p_query_text text,
    p_query_embedding vector(1536),
    p_time_start timestamptz DEFAULT NULL,
    p_time_end timestamptz DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE (
    memory_id uuid,
    memory_type text,
    content text,
    score double precision,
    artifact_id uuid,
    occurred_at timestamptz,
    namespace_id text,
    provenance jsonb
)
LANGUAGE sql
STABLE
AS $$
WITH lexical_episodic AS (
    SELECT
        e.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        e.artifact_id,
        e.occurred_at,
        e.namespace_id,
        jsonb_build_object(
            'source_offset', e.source_offset,
            'metadata', e.metadata
        ) AS provenance,
        ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(e.search_vector, plainto_tsquery('english', p_query_text)) DESC
        ) AS rank_position
    FROM episodic_memory e
    WHERE e.namespace_id = p_namespace_id
      AND (p_time_start IS NULL OR e.occurred_at >= p_time_start)
      AND (p_time_end IS NULL OR e.occurred_at <= p_time_end)
      AND e.search_vector @@ plainto_tsquery('english', p_query_text)
    LIMIT 25
),
lexical_semantic AS (
    SELECT
        s.id AS memory_id,
        'semantic_memory'::text AS memory_type,
        s.content_abstract AS content,
        s.source_episodic_id AS artifact_id,
        s.valid_from AS occurred_at,
        s.namespace_id,
        jsonb_build_object(
            'status', s.status,
            'metadata', s.metadata
        ) AS provenance,
        ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(s.search_vector, plainto_tsquery('english', p_query_text)) DESC
        ) AS rank_position
    FROM semantic_memory s
    WHERE s.namespace_id = p_namespace_id
      AND s.status = 'active'
      AND s.search_vector @@ plainto_tsquery('english', p_query_text)
    LIMIT 25
),
vector_semantic AS (
    SELECT
        s.id AS memory_id,
        'semantic_memory'::text AS memory_type,
        s.content_abstract AS content,
        s.source_episodic_id AS artifact_id,
        s.valid_from AS occurred_at,
        s.namespace_id,
        jsonb_build_object(
            'status', s.status,
            'metadata', s.metadata
        ) AS provenance,
        ROW_NUMBER() OVER (
            ORDER BY s.embedding <=> p_query_embedding
        ) AS rank_position
    FROM semantic_memory s
    WHERE s.namespace_id = p_namespace_id
      AND s.status = 'active'
      AND s.embedding IS NOT NULL
    LIMIT 25
),
vector_temporal AS (
    SELECT
        t.id AS memory_id,
        'temporal_nodes'::text AS memory_type,
        t.summary_text AS content,
        NULL::uuid AS artifact_id,
        t.starts_at AS occurred_at,
        t.namespace_id,
        jsonb_build_object(
            'node_level', t.node_level,
            'range', jsonb_build_object('starts_at', t.starts_at, 'ends_at', t.ends_at),
            'metadata', t.metadata
        ) AS provenance,
        ROW_NUMBER() OVER (
            ORDER BY t.embedding <=> p_query_embedding
        ) AS rank_position
    FROM temporal_nodes t
    WHERE t.namespace_id = p_namespace_id
      AND (p_time_start IS NULL OR t.ends_at >= p_time_start)
      AND (p_time_end IS NULL OR t.starts_at <= p_time_end)
      AND t.embedding IS NOT NULL
    LIMIT 15
),
unioned AS (
    SELECT *, 1.0 / (60 + rank_position) AS partial_score FROM lexical_episodic
    UNION ALL
    SELECT *, 1.0 / (60 + rank_position) AS partial_score FROM lexical_semantic
    UNION ALL
    SELECT *, 1.0 / (60 + rank_position) AS partial_score FROM vector_semantic
    UNION ALL
    SELECT *, 1.0 / (60 + rank_position) AS partial_score FROM vector_temporal
),
scored AS (
    SELECT
        memory_id,
        memory_type,
        max(content) AS content,
        max(artifact_id) AS artifact_id,
        max(occurred_at) AS occurred_at,
        max(namespace_id) AS namespace_id,
        max(provenance) AS provenance,
        SUM(partial_score) AS score
    FROM unioned
    GROUP BY memory_id, memory_type
)
SELECT
    memory_id,
    memory_type,
    content,
    score,
    artifact_id,
    occurred_at,
    namespace_id,
    provenance
FROM scored
ORDER BY score DESC, occurred_at DESC NULLS LAST
LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION brain_timeline_candidates(
    p_namespace_id text,
    p_time_start timestamptz,
    p_time_end timestamptz,
    p_limit integer DEFAULT 20
)
RETURNS TABLE (
    memory_id uuid,
    memory_type text,
    content text,
    occurred_at timestamptz,
    artifact_id uuid,
    provenance jsonb
)
LANGUAGE sql
STABLE
AS $$
SELECT
    e.id AS memory_id,
    'episodic_memory'::text AS memory_type,
    e.content,
    e.occurred_at,
    e.artifact_id,
    jsonb_build_object(
        'source_offset', e.source_offset,
        'metadata', e.metadata
    ) AS provenance
FROM episodic_memory e
WHERE e.namespace_id = p_namespace_id
  AND e.occurred_at >= p_time_start
  AND e.occurred_at <= p_time_end
ORDER BY e.occurred_at ASC
LIMIT p_limit;
$$;
