-- 050_typed_canonical_payloads.sql

ALTER TABLE canonical_entity_reports
  ADD COLUMN IF NOT EXISTS answer_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE canonical_pair_reports
  ADD COLUMN IF NOT EXISTS answer_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE canonical_temporal_facts
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS time_granularity text,
  ADD COLUMN IF NOT EXISTS answer_year integer,
  ADD COLUMN IF NOT EXISTS answer_month integer,
  ADD COLUMN IF NOT EXISTS answer_day integer,
  ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_event_key
  ON canonical_temporal_facts (namespace_id, subject_entity_id, event_key, t_valid_from DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS canonical_set_entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    canonical_set_id uuid NOT NULL REFERENCES canonical_sets(id) ON DELETE CASCADE,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    entry_index integer NOT NULL DEFAULT 0,
    display_value text NOT NULL,
    normalized_value text NOT NULL,
    value_type text NOT NULL DEFAULT 'unknown',
    country_code text,
    city_name text,
    venue_name text,
    gift_kind text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_set_entries_namespace_set
  ON canonical_set_entries (namespace_id, canonical_set_id, entry_index);

CREATE INDEX IF NOT EXISTS idx_canonical_set_entries_namespace_subject_type
  ON canonical_set_entries (namespace_id, subject_entity_id, value_type, normalized_value);
