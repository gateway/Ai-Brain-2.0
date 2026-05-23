-- Metadata-first retrieval indexes for route-locked latency gates.

CREATE INDEX IF NOT EXISTS idx_artifact_chunks_artifact_chunk
    ON artifact_chunks (artifact_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_namespace_subject_status
    ON relationship_candidates (namespace_id, subject_entity_id, status, valid_until, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_namespace_object_status
    ON relationship_candidates (namespace_id, object_entity_id, status, valid_until, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_namespace_subject_status
    ON relationship_memory (namespace_id, subject_entity_id, status, valid_until, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_namespace_object_status
    ON relationship_memory (namespace_id, object_entity_id, status, valid_until, confidence DESC);
