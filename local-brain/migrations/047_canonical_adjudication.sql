-- 047_canonical_adjudication.sql

CREATE TABLE IF NOT EXISTS canonical_subjects (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    canonical_name text NOT NULL,
    normalized_canonical_name text NOT NULL,
    confidence double precision NOT NULL DEFAULT 0.5,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, entity_id),
    UNIQUE (namespace_id, normalized_canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_canonical_subjects_namespace_name
    ON canonical_subjects (namespace_id, normalized_canonical_name, confidence DESC);

CREATE TABLE IF NOT EXISTS canonical_subject_aliases (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    alias_text text NOT NULL,
    normalized_alias_text text NOT NULL,
    confidence double precision NOT NULL DEFAULT 0.5,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, subject_entity_id, normalized_alias_text)
);

CREATE INDEX IF NOT EXISTS idx_canonical_subject_aliases_namespace_alias
    ON canonical_subject_aliases (namespace_id, normalized_alias_text, confidence DESC);

CREATE TABLE IF NOT EXISTS canonical_facts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    object_value text,
    object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    time_scope_kind text NOT NULL DEFAULT 'unknown',
    support_strength text NOT NULL DEFAULT 'moderate',
    valid_from timestamptz,
    valid_until timestamptz,
    supersedes_fact_id uuid REFERENCES canonical_facts(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_facts_namespace_subject_predicate
    ON canonical_facts (namespace_id, subject_entity_id, predicate_family, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_facts_namespace_predicate_time
    ON canonical_facts (namespace_id, predicate_family, valid_from DESC NULLS LAST, valid_until DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS canonical_fact_provenance (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    canonical_fact_id uuid NOT NULL REFERENCES canonical_facts(id) ON DELETE CASCADE,
    namespace_id text NOT NULL,
    source_memory_id uuid,
    source_artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    source_artifact_observation_id uuid,
    source_chunk_id uuid,
    source_derivation_id uuid,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_fact_provenance_fact
    ON canonical_fact_provenance (canonical_fact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_fact_provenance_namespace_source
    ON canonical_fact_provenance (namespace_id, source_memory_id, source_artifact_id);

CREATE TABLE IF NOT EXISTS canonical_states (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    state_value text NOT NULL,
    support_strength text NOT NULL DEFAULT 'moderate',
    confidence double precision NOT NULL DEFAULT 0.5,
    time_scope_kind text NOT NULL DEFAULT 'active',
    valid_from timestamptz,
    valid_until timestamptz,
    supersedes_state_id uuid REFERENCES canonical_states(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_states_namespace_subject_predicate
    ON canonical_states (namespace_id, subject_entity_id, predicate_family, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_subject_states (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    state_value text NOT NULL,
    support_strength text NOT NULL DEFAULT 'moderate',
    time_scope_kind text NOT NULL DEFAULT 'active',
    valid_from timestamptz,
    valid_until timestamptz,
    supersedes_state_id uuid REFERENCES canonical_subject_states(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_subject_states_namespace_subject_predicate
    ON canonical_subject_states (namespace_id, subject_entity_id, predicate_family, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_temporal_facts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    fact_value text,
    time_scope_kind text NOT NULL DEFAULT 'unknown',
    anchor_text text,
    anchor_start timestamptz,
    anchor_end timestamptz,
    support_strength text NOT NULL DEFAULT 'moderate',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_temporal_facts_namespace_subject_predicate
    ON canonical_temporal_facts (namespace_id, subject_entity_id, predicate_family, anchor_start DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS canonical_sets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    item_values jsonb NOT NULL DEFAULT '[]'::jsonb,
    support_strength text NOT NULL DEFAULT 'moderate',
    confidence double precision NOT NULL DEFAULT 0.5,
    valid_from timestamptz,
    valid_until timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_sets_namespace_subject_predicate
    ON canonical_sets (namespace_id, subject_entity_id, predicate_family, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_ambiguities (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    ambiguity_type text NOT NULL,
    query_text text,
    subject_alias_text text,
    candidate_entity_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_ambiguities_namespace_type
    ON canonical_ambiguities (namespace_id, ambiguity_type, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_rebuild_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    status text NOT NULL DEFAULT 'started',
    scope text NOT NULL DEFAULT 'full',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_canonical_rebuild_runs_namespace_started
    ON canonical_rebuild_runs (namespace_id, started_at DESC);
