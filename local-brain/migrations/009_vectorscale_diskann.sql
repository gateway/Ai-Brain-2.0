-- 009_vectorscale_diskann.sql

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_available_extensions
        WHERE name = 'vectorscale'
    ) THEN
        CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_semantic_embedding_diskann
            ON semantic_memory
            USING diskann (embedding vector_cosine_ops)';

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_artifact_derivations_embedding_diskann
            ON artifact_derivations
            USING diskann (embedding vector_cosine_ops)';
    ELSE
        RAISE NOTICE 'vectorscale extension is not available; skipping diskann indexes and using pgvector/lexical fallback.';
    END IF;
END $$;
