-- 068_profile_trait_compiled_lookup.sql

CREATE INDEX IF NOT EXISTS idx_compiled_fact_observations_profile_trait_lookup
  ON compiled_fact_observations (
    namespace_id,
    query_family,
    predicate_family,
    property_key,
    subject_entity_id,
    truth_status,
    promotion_status,
    valid_from DESC NULLS LAST
  );
