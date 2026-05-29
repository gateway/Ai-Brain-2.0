-- 074_codex_session_ingestion.sql

CREATE TABLE IF NOT EXISTS codex_session_catalog (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    codex_session_id text,
    source_path text NOT NULL,
    normalized_source_path text NOT NULL,
    archive_path text,
    content_hash text NOT NULL,
    byte_size bigint NOT NULL DEFAULT 0,
    mtime_at timestamptz,
    captured_at timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_parsed_at timestamptz,
    last_summarized_at timestamptz,
    parse_status text NOT NULL DEFAULT 'pending',
    summary_status text NOT NULL DEFAULT 'pending',
    event_count integer NOT NULL DEFAULT 0,
    important_event_count integer NOT NULL DEFAULT 0,
    malformed_row_count integer NOT NULL DEFAULT 0,
    redaction_hit_count integer NOT NULL DEFAULT 0,
    title text,
    cwd text,
    repo_path text,
    git_branch text,
    git_sha text,
    git_origin_url text,
    archived boolean NOT NULL DEFAULT false,
    tokens_used integer,
    domain text NOT NULL DEFAULT 'unknown',
    privacy_tier text NOT NULL DEFAULT 'normal',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, normalized_source_path)
);

CREATE INDEX IF NOT EXISTS idx_codex_session_catalog_namespace_seen
    ON codex_session_catalog (namespace_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_codex_session_catalog_hash
    ON codex_session_catalog (namespace_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_codex_session_catalog_repo
    ON codex_session_catalog (namespace_id, repo_path, captured_at DESC);

CREATE TABLE IF NOT EXISTS codex_session_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    session_catalog_id uuid NOT NULL REFERENCES codex_session_catalog(id) ON DELETE CASCADE,
    event_index integer NOT NULL,
    event_type text,
    event_category text NOT NULL DEFAULT 'unknown',
    role text,
    event_timestamp timestamptz,
    content_text text,
    raw_content_hash text,
    tool_name text,
    tool_input_summary text,
    tool_output_summary text,
    command text,
    cwd text,
    file_paths text[] NOT NULL DEFAULT '{}',
    token_estimate integer NOT NULL DEFAULT 0,
    importance_score double precision NOT NULL DEFAULT 0,
    noise_score double precision NOT NULL DEFAULT 0,
    redaction_hit_count integer NOT NULL DEFAULT 0,
    parse_warnings text[] NOT NULL DEFAULT '{}',
    raw_event jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_catalog_id, event_index)
);

CREATE INDEX IF NOT EXISTS idx_codex_session_events_session_index
    ON codex_session_events (session_catalog_id, event_index);

CREATE INDEX IF NOT EXISTS idx_codex_session_events_category
    ON codex_session_events (namespace_id, event_category, importance_score DESC);

CREATE INDEX IF NOT EXISTS idx_codex_session_events_search
    ON codex_session_events USING GIN (to_tsvector('english', coalesce(content_text, '')));

CREATE TABLE IF NOT EXISTS codex_session_summaries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    session_catalog_id uuid NOT NULL REFERENCES codex_session_catalog(id) ON DELETE CASCADE,
    summary_version integer NOT NULL DEFAULT 1,
    source_hash text NOT NULL,
    schema_version text NOT NULL,
    summary_status text NOT NULL DEFAULT 'summarized',
    summary_text text NOT NULL,
    summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_event_start integer,
    source_event_end integer,
    redaction_hit_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_catalog_id, summary_version),
    UNIQUE (session_catalog_id, source_hash, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_codex_session_summaries_namespace_created
    ON codex_session_summaries (namespace_id, created_at DESC);
