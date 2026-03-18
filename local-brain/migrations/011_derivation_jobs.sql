-- 011_derivation_jobs.sql

CREATE TABLE IF NOT EXISTS derivation_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE CASCADE,
    job_kind text NOT NULL CHECK (job_kind IN ('ocr', 'transcription', 'caption', 'summary', 'derive_text', 'embed')),
    modality text NOT NULL CHECK (modality IN ('text', 'image', 'pdf', 'audio', 'video')),
    provider text,
    model text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    retry_count integer NOT NULL DEFAULT 0,
    max_retries integer NOT NULL DEFAULT 5,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    last_error text,
    last_error_at timestamptz,
    target_derivation_id uuid REFERENCES artifact_derivations(id) ON DELETE SET NULL,
    output_dimensionality integer,
    max_output_tokens integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_derivation_jobs_dedup
    ON derivation_jobs (
        artifact_observation_id,
        source_chunk_id,
        job_kind,
        provider,
        model,
        output_dimensionality
    );

CREATE INDEX IF NOT EXISTS idx_derivation_jobs_status_next_attempt
    ON derivation_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_derivation_jobs_namespace_status
    ON derivation_jobs (namespace_id, status, created_at DESC);
