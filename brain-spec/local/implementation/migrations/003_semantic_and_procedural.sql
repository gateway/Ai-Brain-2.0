-- 003_semantic_and_procedural.sql

CREATE TABLE IF NOT EXISTS semantic_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    content_abstract text NOT NULL,
    embedding vector(1536),
    embedding_model text,
    importance_score double precision NOT NULL DEFAULT 0.5,
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,
    is_anchor boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'invalid', 'archived')),
    source_episodic_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content_abstract, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_semantic_namespace_validity
    ON semantic_memory (namespace_id, valid_from DESC, valid_until);

CREATE INDEX IF NOT EXISTS idx_semantic_status
    ON semantic_memory (status);

CREATE INDEX IF NOT EXISTS idx_semantic_search_vector
    ON semantic_memory USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_semantic_embedding_ivfflat
    ON semantic_memory USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Local upgrade once vectorscale is installed:
-- CREATE INDEX idx_semantic_embedding_diskann
--     ON semantic_memory USING diskann (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS procedural_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    state_type text NOT NULL,
    state_key text NOT NULL,
    state_value jsonb NOT NULL DEFAULT '{}'::jsonb,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,
    supersedes_id uuid REFERENCES procedural_memory(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, state_type, state_key, version)
);

CREATE INDEX IF NOT EXISTS idx_procedural_namespace_type_key
    ON procedural_memory (namespace_id, state_type, state_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    candidate_type text NOT NULL,
    content text NOT NULL,
    confidence double precision,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_namespace_status
    ON memory_candidates (namespace_id, status, created_at DESC);
