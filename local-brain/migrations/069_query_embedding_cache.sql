CREATE TABLE IF NOT EXISTS query_embedding_cache (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    query_hash text NOT NULL,
    normalization_version text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    output_dimensionality integer,
    embedding_dimensions integer NOT NULL,
    embedding_json jsonb NOT NULL,
    token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
    provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    hit_count integer NOT NULL DEFAULT 0,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (query_hash, normalization_version, provider, model, output_dimensionality)
);

CREATE INDEX IF NOT EXISTS idx_query_embedding_cache_lookup
    ON query_embedding_cache (provider, model, normalization_version, last_used_at DESC);
