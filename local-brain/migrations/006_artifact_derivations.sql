-- 006_artifact_derivations.sql

CREATE TABLE IF NOT EXISTS artifact_derivations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE CASCADE,
    derivation_type text NOT NULL,
    provider text,
    model text,
    content_text text,
    embedding vector(1536),
    output_dimensionality integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_derivations_observation
    ON artifact_derivations (artifact_observation_id, derivation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifact_derivations_chunk
    ON artifact_derivations (source_chunk_id, derivation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifact_derivations_text_search
    ON artifact_derivations USING GIN (to_tsvector('english', coalesce(content_text, '')));
