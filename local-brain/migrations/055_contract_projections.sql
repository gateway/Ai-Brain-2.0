-- 055_contract_projections.sql

CREATE TABLE IF NOT EXISTS contract_projection_heads (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    contract_name text NOT NULL,
    projection_kind text NOT NULL CHECK (projection_kind IN ('list', 'report', 'temporal')),
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    pair_subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    bundle_key text NOT NULL,
    summary_text text,
    answer_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    fulfilled_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    completeness_score double precision NOT NULL DEFAULT 0,
    answer_granularity text,
    support_count integer NOT NULL DEFAULT 0,
    freshness_state text NOT NULL DEFAULT 'fresh',
    build_version text NOT NULL DEFAULT 'contract_projection_v1',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, contract_name, subject_entity_id, pair_subject_entity_id, bundle_key)
);

CREATE INDEX IF NOT EXISTS idx_contract_projection_heads_namespace_contract
  ON contract_projection_heads (namespace_id, contract_name, completeness_score DESC, support_count DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_contract_projection_heads_namespace_subject
  ON contract_projection_heads (namespace_id, subject_entity_id, contract_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS contract_projection_entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    projection_head_id uuid NOT NULL REFERENCES contract_projection_heads(id) ON DELETE CASCADE,
    entry_index integer NOT NULL DEFAULT 0,
    display_value text NOT NULL,
    normalized_value text NOT NULL,
    entry_type text NOT NULL DEFAULT 'unknown',
    temporal_start timestamptz,
    temporal_end timestamptz,
    temporal_granularity text,
    source_table text,
    source_row_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_projection_entries_head
  ON contract_projection_entries (projection_head_id, entry_index);

CREATE INDEX IF NOT EXISTS idx_contract_projection_entries_namespace_subject
  ON contract_projection_entries (namespace_id, normalized_value, entry_type, created_at DESC);
