-- 007_temporal_decay_and_relationship_memory.sql

CREATE TABLE IF NOT EXISTS temporal_nodes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    layer text NOT NULL CHECK (layer IN ('session', 'day', 'week', 'month', 'year', 'profile')),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    summary_text text NOT NULL DEFAULT '',
    source_count integer NOT NULL DEFAULT 0,
    summary_version integer NOT NULL DEFAULT 1,
    generated_by text NOT NULL DEFAULT 'deterministic_rollup',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, layer, period_start, period_end, summary_version)
);

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_namespace_layer_period
    ON temporal_nodes (namespace_id, layer, period_start DESC);

CREATE TABLE IF NOT EXISTS temporal_node_members (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    temporal_node_id uuid NOT NULL REFERENCES temporal_nodes(id) ON DELETE CASCADE,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    source_candidate_id uuid REFERENCES memory_candidates(id) ON DELETE SET NULL,
    source_semantic_id uuid REFERENCES semantic_memory(id) ON DELETE SET NULL,
    source_relationship_id uuid REFERENCES relationship_candidates(id) ON DELETE SET NULL,
    member_role text NOT NULL DEFAULT 'summary_input'
        CHECK (member_role IN ('summary_input', 'summary_support', 'entity_link', 'relationship_evidence')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        temporal_node_id,
        source_memory_id,
        source_candidate_id,
        source_semantic_id,
        source_relationship_id,
        member_role
    )
);

CREATE INDEX IF NOT EXISTS idx_temporal_node_members_node
    ON temporal_node_members (temporal_node_id, member_role);

CREATE TABLE IF NOT EXISTS relationship_memory (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate text NOT NULL,
    object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    confidence double precision NOT NULL DEFAULT 0.5,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'invalid', 'archived')),
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,
    source_candidate_id uuid REFERENCES relationship_candidates(id) ON DELETE SET NULL,
    superseded_by_id uuid REFERENCES relationship_memory(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, subject_entity_id, predicate, object_entity_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_active
    ON relationship_memory (namespace_id, subject_entity_id, predicate, valid_from DESC)
    WHERE valid_until IS NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS relationship_adjudication_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    candidate_id uuid REFERENCES relationship_candidates(id) ON DELETE SET NULL,
    relationship_memory_id uuid REFERENCES relationship_memory(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (action IN ('accepted', 'rejected', 'superseded', 'reinforced')),
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relationship_adjudication_events_namespace_created
    ON relationship_adjudication_events (namespace_id, created_at DESC);

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS processed_at timestamptz;

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS decision_reason text;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS decay_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS decay_floor double precision NOT NULL DEFAULT 0.1;

CREATE TABLE IF NOT EXISTS semantic_decay_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    semantic_memory_id uuid NOT NULL REFERENCES semantic_memory(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN ('decayed', 'archived')),
    previous_importance_score double precision NOT NULL,
    new_importance_score double precision NOT NULL,
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_decay_events_namespace_created
    ON semantic_decay_events (namespace_id, created_at DESC);
