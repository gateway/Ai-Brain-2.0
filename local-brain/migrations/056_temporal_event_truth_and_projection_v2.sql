-- 056_temporal_event_truth_and_projection_v2.sql

CREATE TABLE IF NOT EXISTS temporal_event_facts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    contract_name text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    pair_subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    event_key text NOT NULL,
    event_label text,
    event_type text,
    start_at timestamptz,
    end_at timestamptz,
    answer_year integer,
    answer_month integer,
    answer_day integer,
    time_granularity text,
    exactness text NOT NULL DEFAULT 'inferred'
        CHECK (exactness IN ('exact', 'bounded', 'inferred')),
    valid_from timestamptz,
    valid_until timestamptz,
    truth_status text NOT NULL DEFAULT 'active'
        CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
    support_count integer NOT NULL DEFAULT 0,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, contract_name, subject_entity_id, pair_subject_entity_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_temporal_event_facts_namespace_subject_event
  ON temporal_event_facts (namespace_id, subject_entity_id, event_key, truth_status, valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_temporal_event_facts_namespace_window
  ON temporal_event_facts (namespace_id, start_at, end_at);

CREATE TABLE IF NOT EXISTS temporal_event_support (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    temporal_event_fact_id uuid NOT NULL REFERENCES temporal_event_facts(id) ON DELETE CASCADE,
    support_table text NOT NULL,
    source_row_id uuid,
    support_memory_id uuid,
    support_role text NOT NULL DEFAULT 'support'
        CHECK (support_role IN ('primary', 'support', 'conflict')),
    snippet text,
    occurred_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temporal_event_support_fact
  ON temporal_event_support (temporal_event_fact_id, support_role, occurred_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_temporal_event_support_memory_lookup
  ON temporal_event_support (support_memory_id)
  WHERE support_memory_id IS NOT NULL;

ALTER TABLE contract_projection_heads
  ADD COLUMN IF NOT EXISTS truth_status text NOT NULL DEFAULT 'active'
    CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
  ADD COLUMN IF NOT EXISTS render_contract text,
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS exactness text
    CHECK (exactness IN ('exact', 'bounded', 'inferred')),
  ADD COLUMN IF NOT EXISTS support_memory_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS support_temporal_fact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS support_relationship_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS render_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_key timestamptz,
  ADD COLUMN IF NOT EXISTS projection_version text NOT NULL DEFAULT 'contract_projection_v2';

CREATE INDEX IF NOT EXISTS idx_contract_projection_heads_namespace_truth
  ON contract_projection_heads (namespace_id, contract_name, truth_status, valid_from DESC NULLS LAST, updated_at DESC);

ALTER TABLE contract_projection_entries
  ADD COLUMN IF NOT EXISTS entry_role text NOT NULL DEFAULT 'value',
  ADD COLUMN IF NOT EXISTS support_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS truth_status text NOT NULL DEFAULT 'active'
    CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS sort_key timestamptz,
  ADD COLUMN IF NOT EXISTS support_memory_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS support_relationship_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS support_temporal_fact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS idx_contract_projection_entries_head_truth
  ON contract_projection_entries (projection_head_id, truth_status, entry_index, sort_key DESC NULLS LAST);
