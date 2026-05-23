-- 062_compiled_memory_observations.sql

CREATE TABLE IF NOT EXISTS compiled_fact_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  pair_subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  query_family text NOT NULL,
  exact_detail_family text,
  predicate_family text,
  property_key text,
  answer_value text,
  normalized_answer_value text NOT NULL DEFAULT '',
  truth_status text NOT NULL DEFAULT 'active'
    CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
  valid_from timestamptz,
  valid_until timestamptz,
  confidence double precision,
  source_table text NOT NULL,
  source_row_id uuid,
  source_scene_id uuid,
  source_memory_id uuid,
  source_chunk_id uuid,
  support_phrase text,
  source_text text,
  extractor text,
  model_id text,
  schema_version text,
  promotion_status text NOT NULL DEFAULT 'compiled'
    CHECK (promotion_status IN ('compiled', 'rejected', 'ambiguous')),
  admissibility_status text,
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (
    namespace_id,
    source_table,
    source_row_id,
    exact_detail_family,
    property_key,
    normalized_answer_value,
    subject_entity_id
  )
);

CREATE INDEX IF NOT EXISTS idx_compiled_fact_observations_lookup
  ON compiled_fact_observations (
    namespace_id,
    query_family,
    exact_detail_family,
    subject_entity_id,
    truth_status,
    promotion_status,
    valid_from DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS idx_compiled_fact_observations_value
  ON compiled_fact_observations (
    namespace_id,
    normalized_answer_value,
    exact_detail_family,
    truth_status,
    promotion_status
  );

CREATE INDEX IF NOT EXISTS idx_compiled_fact_observations_source
  ON compiled_fact_observations (source_table, source_row_id);

CREATE TABLE IF NOT EXISTS compiled_event_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  pair_subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  query_family text NOT NULL DEFAULT 'temporal_detail',
  predicate_family text,
  event_key text,
  event_type text,
  event_label text,
  object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  object_value text,
  normalized_object_value text NOT NULL DEFAULT '',
  location_value text,
  time_granularity text,
  exactness text,
  truth_status text NOT NULL DEFAULT 'active'
    CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
  valid_from timestamptz,
  valid_until timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  confidence double precision,
  source_table text NOT NULL,
  source_row_id uuid,
  source_scene_id uuid,
  source_memory_id uuid,
  source_chunk_id uuid,
  support_phrase text,
  source_text text,
  extractor text,
  model_id text,
  schema_version text,
  promotion_status text NOT NULL DEFAULT 'compiled'
    CHECK (promotion_status IN ('compiled', 'rejected', 'ambiguous')),
  admissibility_status text,
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (
    namespace_id,
    source_table,
    source_row_id,
    predicate_family,
    event_key,
    normalized_object_value,
    subject_entity_id
  )
);

CREATE INDEX IF NOT EXISTS idx_compiled_event_observations_lookup
  ON compiled_event_observations (
    namespace_id,
    predicate_family,
    subject_entity_id,
    truth_status,
    promotion_status,
    valid_from DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS idx_compiled_event_observations_time
  ON compiled_event_observations (namespace_id, start_at, end_at, time_granularity);

CREATE TABLE IF NOT EXISTS compiled_relationship_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  query_family text NOT NULL DEFAULT 'profile_report',
  predicate_family text,
  relationship_value text,
  normalized_relationship_value text NOT NULL DEFAULT '',
  truth_status text NOT NULL DEFAULT 'active'
    CHECK (truth_status IN ('active', 'superseded', 'uncertain')),
  valid_from timestamptz,
  valid_until timestamptz,
  confidence double precision,
  source_table text NOT NULL,
  source_row_id uuid,
  source_scene_id uuid,
  source_memory_id uuid,
  source_chunk_id uuid,
  support_phrase text,
  source_text text,
  extractor text,
  model_id text,
  schema_version text,
  promotion_status text NOT NULL DEFAULT 'compiled'
    CHECK (promotion_status IN ('compiled', 'rejected', 'ambiguous')),
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compiled_relationship_observations_lookup
  ON compiled_relationship_observations (
    namespace_id,
    predicate_family,
    subject_entity_id,
    object_entity_id,
    truth_status,
    promotion_status,
    valid_from DESC NULLS LAST
  );

CREATE TABLE IF NOT EXISTS compiled_memory_coverage (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace_id text NOT NULL,
  source_table text NOT NULL,
  source_row_id uuid,
  source_scene_id uuid,
  compiler_stage text NOT NULL,
  query_family text,
  exact_detail_family text,
  promotion_status text NOT NULL
    CHECK (promotion_status IN ('compiled', 'rejected', 'ambiguous', 'skipped')),
  rejection_reason text,
  support_phrase text,
  source_text text,
  confidence double precision,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compiled_memory_coverage_namespace_stage
  ON compiled_memory_coverage (
    namespace_id,
    compiler_stage,
    promotion_status,
    exact_detail_family
  );
