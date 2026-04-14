-- 051_canonical_temporal_fact_support.sql

ALTER TABLE canonical_temporal_facts
  ADD COLUMN IF NOT EXISTS object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anchor_event_key text,
  ADD COLUMN IF NOT EXISTS anchor_relation text,
  ADD COLUMN IF NOT EXISTS anchor_offset_value integer,
  ADD COLUMN IF NOT EXISTS anchor_offset_unit text,
  ADD COLUMN IF NOT EXISTS confidence double precision NOT NULL DEFAULT 0.5;

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_fact_support_event
  ON canonical_temporal_facts (namespace_id, subject_entity_id, event_key, anchor_relation, t_valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_fact_support_provenance
  ON canonical_temporal_facts (namespace_id, source_artifact_id, source_chunk_id);
