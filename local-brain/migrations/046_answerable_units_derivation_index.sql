CREATE INDEX IF NOT EXISTS idx_answerable_units_source_derivation_id
    ON answerable_units (source_derivation_id)
    WHERE source_derivation_id IS NOT NULL;
