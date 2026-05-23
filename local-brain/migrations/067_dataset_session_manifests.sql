-- 067_dataset_session_manifests.sql

CREATE TABLE IF NOT EXISTS dataset_session_manifests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  dataset_key text NOT NULL,
  sample_id text NOT NULL,
  manifest_key text NOT NULL,
  manifest_status text NOT NULL DEFAULT 'cold_build'
    CHECK (manifest_status IN ('cold_build', 'warm_manifest_hit', 'manifest_invalidated')),
  manifest_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_signature jsonb NOT NULL DEFAULT '{}'::jsonb,
  compiler_signature jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  extraction_unit_count integer NOT NULL DEFAULT 0,
  read_model_count integer NOT NULL DEFAULT 0,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  UNIQUE (dataset_key, sample_id, manifest_key)
);

CREATE INDEX IF NOT EXISTS idx_dataset_session_manifests_lookup
  ON dataset_session_manifests (dataset_key, sample_id, manifest_key, manifest_status);

CREATE INDEX IF NOT EXISTS idx_dataset_session_manifests_namespace
  ON dataset_session_manifests (namespace_id, dataset_key, last_used_at DESC);
