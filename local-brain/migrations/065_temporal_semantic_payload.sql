-- 065_temporal_semantic_payload.sql

ALTER TABLE temporal_resolution_candidates
  ADD COLUMN IF NOT EXISTS temporal_semantic_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS answerable_shapes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS blocked_shapes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS normalized_duration text,
  ADD COLUMN IF NOT EXISTS semantic_status text NOT NULL DEFAULT 'candidate'
    CHECK (semantic_status IN ('compiled', 'candidate', 'rejected', 'clarification_needed')),
  ADD COLUMN IF NOT EXISTS executor_version text;

CREATE INDEX IF NOT EXISTS idx_temporal_resolution_candidates_semantic
  ON temporal_resolution_candidates (namespace_id, semantic_status, temporal_type, granularity);

CREATE INDEX IF NOT EXISTS idx_temporal_resolution_candidates_answerable_shapes
  ON temporal_resolution_candidates USING gin (answerable_shapes);
