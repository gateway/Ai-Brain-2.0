-- 048_canonical_bitemporal_graph.sql

ALTER TABLE canonical_facts
  ADD COLUMN IF NOT EXISTS mentioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_until timestamptz;

ALTER TABLE canonical_states
  ADD COLUMN IF NOT EXISTS mentioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_until timestamptz;

ALTER TABLE canonical_subject_states
  ADD COLUMN IF NOT EXISTS mentioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_until timestamptz;

ALTER TABLE canonical_temporal_facts
  ADD COLUMN IF NOT EXISTS mentioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS t_valid_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_canonical_facts_namespace_subject_predicate_tvalid
  ON canonical_facts (namespace_id, subject_entity_id, predicate_family, t_valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_canonical_states_namespace_subject_predicate_tvalid
  ON canonical_states (namespace_id, subject_entity_id, predicate_family, t_valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_namespace_subject_predicate_tvalid
  ON canonical_temporal_facts (namespace_id, subject_entity_id, predicate_family, t_valid_from DESC NULLS LAST);
