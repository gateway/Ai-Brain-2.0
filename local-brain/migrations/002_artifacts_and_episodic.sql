-- 002_artifacts_and_episodic.sql

CREATE TABLE IF NOT EXISTS artifacts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_type text NOT NULL,
    uri text NOT NULL,
    latest_checksum_sha256 text NOT NULL,
    mime_type text,
    source_channel text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, uri)
);

CREATE TABLE IF NOT EXISTS artifact_observations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version integer NOT NULL,
    checksum_sha256 text NOT NULL,
    byte_size integer,
    observed_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (artifact_id, version),
    UNIQUE (artifact_id, checksum_sha256)
);

CREATE TABLE IF NOT EXISTS artifact_chunks (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    chunk_index integer NOT NULL,
    char_start integer,
    char_end integer,
    text_content text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (artifact_observation_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS episodic_memory (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    session_id text,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'import')),
    content text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    captured_at timestamptz NOT NULL DEFAULT now(),
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    artifact_observation_id uuid REFERENCES artifact_observations(id) ON DELETE SET NULL,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
    source_offset jsonb NOT NULL DEFAULT '{}'::jsonb,
    token_count integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
    UNIQUE NULLS NOT DISTINCT (artifact_observation_id, source_chunk_id, role)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_namespace_created
    ON artifacts (namespace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_observations_artifact_observed
    ON artifact_observations (artifact_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_chunks_observation_chunk
    ON artifact_chunks (artifact_observation_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_episodic_namespace_occurred
    ON episodic_memory (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_session_occurred
    ON episodic_memory (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_search_vector
    ON episodic_memory USING GIN (search_vector);

-- Target local upgrade:
-- Keep episodic_memory as the authoritative UUID/FK anchor and mirror
-- time-series rows into a Timescale hypertable sidecar.
