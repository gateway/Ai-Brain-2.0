-- 052_canonical_collection_fact_support.sql

CREATE TABLE IF NOT EXISTS canonical_collection_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id text NOT NULL,
  subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  item_value text NOT NULL,
  normalized_value text NOT NULL,
  cue_type text NOT NULL,
  cue_strength integer NOT NULL DEFAULT 1,
  confidence double precision NOT NULL DEFAULT 0.5,
  source_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
  source_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_collection_facts_subject
  ON canonical_collection_facts (namespace_id, subject_entity_id, cue_strength DESC, confidence DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_collection_facts_value
  ON canonical_collection_facts (namespace_id, normalized_value);
