-- 012_derivation_jobs_dedup.sql

DROP INDEX IF EXISTS idx_derivation_jobs_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS idx_derivation_jobs_dedup
    ON derivation_jobs (
        artifact_observation_id,
        job_kind,
        (COALESCE(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        (COALESCE(provider, '')),
        (COALESCE(model, '')),
        (COALESCE(output_dimensionality, -1))
    );
