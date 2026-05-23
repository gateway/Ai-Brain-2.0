-- 058_scalar_projection_truth_contracts.sql

ALTER TABLE contract_projection_heads
  DROP CONSTRAINT IF EXISTS contract_projection_heads_projection_kind_check;

ALTER TABLE contract_projection_heads
  ADD CONSTRAINT contract_projection_heads_projection_kind_check
  CHECK (projection_kind IN ('list', 'report', 'temporal', 'scalar'));

ALTER TABLE contract_projection_heads
  ADD COLUMN IF NOT EXISTS query_family text,
  ADD COLUMN IF NOT EXISTS authoritative_source text,
  ADD COLUMN IF NOT EXISTS structured_sufficiency_status text,
  ADD COLUMN IF NOT EXISTS abstention_reason text,
  ADD COLUMN IF NOT EXISTS entity_resolution_status text,
  ADD COLUMN IF NOT EXISTS temporal_coverage_status text;

ALTER TABLE contract_projection_entries
  ADD COLUMN IF NOT EXISTS normalized_property_key text,
  ADD COLUMN IF NOT EXISTS owner_binding_status text,
  ADD COLUMN IF NOT EXISTS source_confidence double precision,
  ADD COLUMN IF NOT EXISTS active_truth boolean NOT NULL DEFAULT true;

ALTER TABLE temporal_event_facts
  ADD COLUMN IF NOT EXISTS predicate_family text,
  ADD COLUMN IF NOT EXISTS object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS object_value text,
  ADD COLUMN IF NOT EXISTS event_subject_role text,
  ADD COLUMN IF NOT EXISTS version_group_key text,
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS conflict_status text,
  ADD COLUMN IF NOT EXISTS source_turn_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

ALTER TABLE entity_aliases
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS ambiguity_group text;

CREATE INDEX IF NOT EXISTS idx_contract_projection_heads_namespace_query_family
  ON contract_projection_heads (namespace_id, query_family, contract_name, truth_status, valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_contract_projection_entries_property_key
  ON contract_projection_entries (projection_head_id, normalized_property_key, truth_status, active_truth DESC);

CREATE INDEX IF NOT EXISTS idx_temporal_event_facts_namespace_predicate_family
  ON temporal_event_facts (namespace_id, predicate_family, truth_status, valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_ambiguity_group
  ON entity_aliases (entity_id, ambiguity_group, evidence_count DESC, last_seen_at DESC);
