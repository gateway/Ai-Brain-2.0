-- 008_timescale_episodic_timeline.sql

CREATE TABLE IF NOT EXISTS episodic_timeline (
    occurred_at timestamptz NOT NULL,
    memory_id uuid NOT NULL REFERENCES episodic_memory(id) ON DELETE CASCADE,
    namespace_id text NOT NULL,
    session_id text,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'import')),
    content text NOT NULL,
    captured_at timestamptz NOT NULL,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    artifact_observation_id uuid REFERENCES artifact_observations(id) ON DELETE SET NULL,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
    source_offset jsonb NOT NULL DEFAULT '{}'::jsonb,
    token_count integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
    PRIMARY KEY (occurred_at, memory_id)
);

SELECT create_hypertable(
    'episodic_timeline',
    'occurred_at',
    chunk_time_interval => interval '7 days',
    if_not_exists => TRUE
);

INSERT INTO episodic_timeline (
    occurred_at,
    memory_id,
    namespace_id,
    session_id,
    role,
    content,
    captured_at,
    artifact_id,
    artifact_observation_id,
    source_chunk_id,
    source_offset,
    token_count,
    metadata
)
SELECT
    em.occurred_at,
    em.id,
    em.namespace_id,
    em.session_id,
    em.role,
    em.content,
    em.captured_at,
    em.artifact_id,
    em.artifact_observation_id,
    em.source_chunk_id,
    em.source_offset,
    em.token_count,
    em.metadata
FROM episodic_memory em
ON CONFLICT (occurred_at, memory_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_episodic_timeline_namespace_occurred
    ON episodic_timeline (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_timeline_memory_id
    ON episodic_timeline (memory_id);

CREATE INDEX IF NOT EXISTS idx_episodic_timeline_session_occurred
    ON episodic_timeline (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_timeline_search_vector
    ON episodic_timeline USING GIN (search_vector);
