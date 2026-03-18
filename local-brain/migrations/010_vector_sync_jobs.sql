-- 010_vector_sync_jobs.sql

CREATE TABLE IF NOT EXISTS vector_sync_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    target_table text NOT NULL CHECK (target_table IN ('semantic_memory', 'artifact_derivations')),
    target_id uuid NOT NULL,
    content_column text NOT NULL CHECK (content_column IN ('content_abstract', 'content_text')),
    embedding_column text NOT NULL DEFAULT 'embedding',
    provider text NOT NULL,
    model text NOT NULL,
    output_dimensionality integer,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'cancelled')),
    retry_count integer NOT NULL DEFAULT 0,
    max_retries integer NOT NULL DEFAULT 5,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    last_error text,
    last_error_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE NULLS NOT DISTINCT (target_table, target_id, provider, model, output_dimensionality)
);

CREATE INDEX IF NOT EXISTS idx_vector_sync_jobs_status_attempt
    ON vector_sync_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_vector_sync_jobs_namespace_status
    ON vector_sync_jobs (namespace_id, status, created_at DESC);
