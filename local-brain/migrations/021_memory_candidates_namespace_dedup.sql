-- 021_memory_candidates_namespace_dedup.sql

ALTER TABLE memory_candidates
    DROP CONSTRAINT IF EXISTS memory_candidates_source_memory_id_source_chunk_id_candidat_key;

ALTER TABLE memory_candidates
    ADD CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
    UNIQUE NULLS NOT DISTINCT (namespace_id, source_memory_id, source_chunk_id, candidate_type, content);
