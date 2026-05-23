-- 059_exact_detail_fact_keys.sql

CREATE TABLE IF NOT EXISTS exact_detail_fact_keys (
  id uuid PRIMARY KEY,
  namespace_id text NOT NULL,
  fact_table text NOT NULL,
  fact_row_id uuid NOT NULL,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  exact_detail_family text NOT NULL,
  property_key text,
  key_type text NOT NULL,
  key_text text NOT NULL,
  normalized_key_text text NOT NULL,
  truth_status text NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  confidence double precision,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exact_detail_fact_keys_fact_table_check
    CHECK (fact_table IN ('canonical_states', 'canonical_facts', 'temporal_event_facts', 'contract_projection_entries')),
  CONSTRAINT exact_detail_fact_keys_key_type_check
    CHECK (key_type IN ('value', 'fact', 'alias', 'event_key', 'support_phrase')),
  CONSTRAINT exact_detail_fact_keys_truth_status_check
    CHECK (truth_status IN ('active', 'superseded', 'uncertain'))
);

CREATE INDEX IF NOT EXISTS idx_exact_detail_fact_keys_namespace_family_subject
  ON exact_detail_fact_keys (
    namespace_id,
    exact_detail_family,
    subject_entity_id,
    truth_status,
    valid_from DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS idx_exact_detail_fact_keys_namespace_lookup
  ON exact_detail_fact_keys (
    namespace_id,
    normalized_key_text,
    exact_detail_family,
    truth_status
  );

CREATE INDEX IF NOT EXISTS idx_exact_detail_fact_keys_fact_row
  ON exact_detail_fact_keys (fact_table, fact_row_id);
