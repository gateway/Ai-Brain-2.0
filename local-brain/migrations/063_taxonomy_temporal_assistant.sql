-- 063_taxonomy_temporal_assistant.sql

CREATE TABLE IF NOT EXISTS extraction_units (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  -- episodic_memory is Timescale-partitioned with a composite primary key
  -- (occurred_at, id), so source_memory_id remains a provenance pointer
  -- rather than an FK to episodic_memory(id).
  source_memory_id uuid,
  source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
  source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
  captured_at timestamptz,
  speaker text,
  unit_index integer NOT NULL,
  char_start integer,
  char_end integer,
  unit_text text NOT NULL,
  context_before text,
  context_after text,
  token_estimate integer NOT NULL DEFAULT 0,
  chunking_status text NOT NULL DEFAULT 'ready'
    CHECK (chunking_status IN ('ready', 'needs_split_review', 'empty', 'oversized')),
  split_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (namespace_id, source_id, source_memory_id, source_chunk_id, source_scene_id, unit_index)
);

CREATE INDEX IF NOT EXISTS idx_extraction_units_namespace_source
  ON extraction_units (namespace_id, source_type, source_id, unit_index);

CREATE INDEX IF NOT EXISTS idx_extraction_units_chunk
  ON extraction_units (source_chunk_id)
  WHERE source_chunk_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS extraction_assistant_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  extraction_unit_id uuid REFERENCES extraction_units(id) ON DELETE CASCADE,
  mode text NOT NULL,
  provider text NOT NULL,
  model_id text,
  taxonomy_version text NOT NULL,
  schema_version text NOT NULL,
  prompt_version text NOT NULL,
  input_chars integer NOT NULL DEFAULT 0,
  output_chars integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  latency_ms integer,
  json_valid boolean NOT NULL DEFAULT false,
  validation_status text NOT NULL DEFAULT 'not_run',
  rejection_reason text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_assistant_runs_unit
  ON extraction_assistant_runs (extraction_unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS taxonomy_review_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  taxonomy_version text NOT NULL,
  suggested_key text NOT NULL,
  suggested_label text,
  proposed_domain text,
  proposed_family text,
  proposed_subtype text,
  mapped_domain text,
  mapped_family text,
  mapped_subtype text,
  evidence_count integer NOT NULL DEFAULT 1,
  distinct_source_count integer NOT NULL DEFAULT 1,
  example_evidence text,
  reason text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'rejected', 'merged', 'ignored')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace_id, taxonomy_version, suggested_key)
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_review_items_status
  ON taxonomy_review_items (namespace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS temporal_resolution_candidates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  extraction_unit_id uuid REFERENCES extraction_units(id) ON DELETE CASCADE,
  source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
  -- Keep this as a provenance pointer for the same reason as
  -- extraction_units.source_memory_id above.
  source_memory_id uuid,
  source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
  raw_text text NOT NULL,
  temporal_type text NOT NULL,
  normalized_start timestamptz,
  normalized_end timestamptz,
  granularity text NOT NULL DEFAULT 'unknown',
  anchor_type text NOT NULL DEFAULT 'none',
  anchor_id text,
  needs_clarification boolean NOT NULL DEFAULT false,
  confidence double precision,
  evidence_quote text,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'compiled', 'rejected', 'ambiguous', 'clarification_needed')),
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temporal_resolution_candidates_lookup
  ON temporal_resolution_candidates (namespace_id, temporal_type, status, normalized_start, normalized_end);
