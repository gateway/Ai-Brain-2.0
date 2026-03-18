-- 009_vectorscale_diskann.sql

CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;

CREATE INDEX IF NOT EXISTS idx_semantic_embedding_diskann
    ON semantic_memory
    USING diskann (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_artifact_derivations_embedding_diskann
    ON artifact_derivations
    USING diskann (embedding vector_cosine_ops);
