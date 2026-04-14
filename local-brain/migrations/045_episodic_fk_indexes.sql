CREATE INDEX IF NOT EXISTS idx_episodic_artifact_id
    ON episodic_memory (artifact_id)
    WHERE artifact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_episodic_source_chunk_id
    ON episodic_memory (source_chunk_id)
    WHERE source_chunk_id IS NOT NULL;
