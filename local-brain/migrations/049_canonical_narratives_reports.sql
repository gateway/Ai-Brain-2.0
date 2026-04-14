-- 049_canonical_narratives_reports.sql

CREATE TABLE IF NOT EXISTS canonical_narratives (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    pair_subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    predicate_family text NOT NULL,
    narrative_kind text NOT NULL,
    summary_text text NOT NULL,
    support_strength text NOT NULL DEFAULT 'moderate',
    confidence double precision NOT NULL DEFAULT 0.5,
    mentioned_at timestamptz,
    t_valid_from timestamptz,
    t_valid_until timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_narratives_namespace_subject_predicate_kind
    ON canonical_narratives (namespace_id, subject_entity_id, predicate_family, narrative_kind, t_valid_from DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_canonical_narratives_namespace_pair_kind
    ON canonical_narratives (namespace_id, subject_entity_id, pair_subject_entity_id, narrative_kind, t_valid_from DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS canonical_narrative_provenance (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    canonical_narrative_id uuid NOT NULL REFERENCES canonical_narratives(id) ON DELETE CASCADE,
    namespace_id text NOT NULL,
    source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL,
    source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
    source_memory_id uuid,
    source_canonical_fact_id uuid REFERENCES canonical_facts(id) ON DELETE SET NULL,
    source_canonical_state_id uuid REFERENCES canonical_states(id) ON DELETE SET NULL,
    source_canonical_set_id uuid REFERENCES canonical_sets(id) ON DELETE SET NULL,
    source_canonical_temporal_fact_id uuid REFERENCES canonical_temporal_facts(id) ON DELETE SET NULL,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_narrative_provenance_narrative
    ON canonical_narrative_provenance (canonical_narrative_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_narrative_provenance_namespace_source_memory
    ON canonical_narrative_provenance (namespace_id, source_memory_id);

CREATE TABLE IF NOT EXISTS canonical_entity_reports (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    report_kind text NOT NULL,
    summary_text text NOT NULL,
    support_strength text NOT NULL DEFAULT 'moderate',
    confidence double precision NOT NULL DEFAULT 0.5,
    mentioned_at timestamptz,
    t_valid_from timestamptz,
    t_valid_until timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_entity_reports_namespace_subject_kind
    ON canonical_entity_reports (namespace_id, subject_entity_id, report_kind, t_valid_from DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS canonical_pair_reports (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
    pair_subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    report_kind text NOT NULL,
    summary_text text NOT NULL,
    support_strength text NOT NULL DEFAULT 'moderate',
    confidence double precision NOT NULL DEFAULT 0.5,
    mentioned_at timestamptz,
    t_valid_from timestamptz,
    t_valid_until timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_pair_reports_namespace_pair_kind
    ON canonical_pair_reports (namespace_id, subject_entity_id, pair_subject_entity_id, report_kind, t_valid_from DESC NULLS LAST);
