-- 054_canonical_temporal_fact_provenance.sql

ALTER TABLE canonical_temporal_facts
  ADD COLUMN IF NOT EXISTS support_kind text NOT NULL DEFAULT 'generic_time_fragment',
  ADD COLUMN IF NOT EXISTS binding_confidence double precision NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS temporal_source_quality text NOT NULL DEFAULT 'generic',
  ADD COLUMN IF NOT EXISTS derived_from_reference boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS event_surface_text text,
  ADD COLUMN IF NOT EXISTS location_surface_text text,
  ADD COLUMN IF NOT EXISTS participant_entity_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_fact_support_kind
  ON canonical_temporal_facts (namespace_id, subject_entity_id, support_kind, binding_confidence DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_fact_event_quality
  ON canonical_temporal_facts (namespace_id, event_key, temporal_source_quality, derived_from_reference);
