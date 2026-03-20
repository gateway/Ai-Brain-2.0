-- 023_ops_sessions.sql

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.ingestion_sessions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    title text NOT NULL,
    notes text,
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'intake_in_progress', 'awaiting_review', 'clarifications_open', 'reprocessing', 'completed', 'failed', 'archived')),
    created_by text,
    default_asr_model text,
    default_llm_model text,
    default_llm_preset text,
    default_embedding_model text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_ingestion_sessions_namespace_updated
    ON ops.ingestion_sessions (namespace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_ingestion_sessions_status_updated
    ON ops.ingestion_sessions (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops.session_inputs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL REFERENCES ops.ingestion_sessions(id) ON DELETE CASCADE,
    input_type text NOT NULL
        CHECK (input_type IN ('text', 'audio_recording', 'audio_upload', 'file_upload', 'pdf', 'image', 'mixed')),
    label text,
    raw_text text,
    file_name text,
    mime_type text,
    byte_size bigint,
    duration_seconds numeric,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'ingested', 'classified', 'failed', 'unsupported', 'awaiting_adapter')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_session_inputs_session_created
    ON ops.session_inputs (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_session_inputs_artifact
    ON ops.session_inputs (artifact_id);

CREATE TABLE IF NOT EXISTS ops.session_artifacts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL REFERENCES ops.ingestion_sessions(id) ON DELETE CASCADE,
    input_id uuid REFERENCES ops.session_inputs(id) ON DELETE SET NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'raw_source'
        CHECK (role IN ('raw_source', 'transcript', 'ocr_text', 'caption', 'summary', 'search_proxy')),
    status text NOT NULL DEFAULT 'uploaded',
    derive_status text,
    classify_status text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, artifact_id, role)
);

CREATE INDEX IF NOT EXISTS idx_ops_session_artifacts_session_created
    ON ops.session_artifacts (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_session_artifacts_artifact
    ON ops.session_artifacts (artifact_id);

CREATE TABLE IF NOT EXISTS ops.session_model_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL REFERENCES ops.ingestion_sessions(id) ON DELETE CASCADE,
    input_id uuid REFERENCES ops.session_inputs(id) ON DELETE SET NULL,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    family text NOT NULL,
    endpoint text NOT NULL,
    provider_base_url text,
    model text,
    preset_id text,
    request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_json jsonb,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_text text
);

CREATE INDEX IF NOT EXISTS idx_ops_session_model_runs_session_started
    ON ops.session_model_runs (session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ops.session_actions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL REFERENCES ops.ingestion_sessions(id) ON DELETE CASCADE,
    actor_id text,
    action_type text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_session_actions_session_created
    ON ops.session_actions (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.saved_queries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_id text,
    session_id uuid REFERENCES ops.ingestion_sessions(id) ON DELETE SET NULL,
    title text NOT NULL,
    query_mode text NOT NULL,
    query_text text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_saved_queries_owner_updated
    ON ops.saved_queries (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_saved_queries_session_updated
    ON ops.saved_queries (session_id, updated_at DESC);
