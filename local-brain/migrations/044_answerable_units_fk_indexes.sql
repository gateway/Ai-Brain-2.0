CREATE INDEX IF NOT EXISTS idx_answerable_units_artifact_id
    ON answerable_units (artifact_id)
    WHERE artifact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_answerable_units_source_chunk_id
    ON answerable_units (source_chunk_id)
    WHERE source_chunk_id IS NOT NULL;
