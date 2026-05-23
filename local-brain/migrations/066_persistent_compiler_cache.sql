-- 066_persistent_compiler_cache.sql

CREATE TABLE IF NOT EXISTS compiler_extraction_cache (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  cache_key text NOT NULL UNIQUE,
  cache_scope text NOT NULL
    CHECK (cache_scope IN ('relation_ie_scene', 'taxonomy_temporal_unit')),
  namespace_id text,
  source_hash text NOT NULL,
  source_type text,
  relation_ie_mode text,
  extractor_signature text NOT NULL,
  taxonomy_version text,
  temporal_version text,
  assistant_model_id text,
  gliner2_model_id text,
  schema_version text NOT NULL,
  prompt_version text,
  status text NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'rejected', 'ambiguous', 'failed')),
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compiler_extraction_cache_scope_hash
  ON compiler_extraction_cache (cache_scope, source_hash, extractor_signature, status);

CREATE INDEX IF NOT EXISTS idx_compiler_extraction_cache_namespace
  ON compiler_extraction_cache (namespace_id, cache_scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS longmem_namespace_snapshots (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  snapshot_key text NOT NULL UNIQUE,
  namespace_id text NOT NULL,
  dataset text NOT NULL DEFAULT 'longmemeval_s_cleaned',
  source_hash text NOT NULL,
  relation_ie_mode text,
  compiler_version text NOT NULL,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'invalidated', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_longmem_namespace_snapshots_lookup
  ON longmem_namespace_snapshots (dataset, source_hash, relation_ie_mode, compiler_version, status);
