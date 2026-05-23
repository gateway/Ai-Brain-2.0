-- 060_exact_detail_fact_keys_narrative_scene_support.sql

ALTER TABLE exact_detail_fact_keys
  DROP CONSTRAINT IF EXISTS exact_detail_fact_keys_fact_table_check;

ALTER TABLE exact_detail_fact_keys
  ADD CONSTRAINT exact_detail_fact_keys_fact_table_check
  CHECK (fact_table IN (
    'canonical_states',
    'canonical_facts',
    'temporal_event_facts',
    'contract_projection_entries',
    'narrative_scenes'
  ));
