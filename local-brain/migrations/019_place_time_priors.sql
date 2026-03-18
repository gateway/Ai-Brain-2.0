-- 019_place_time_priors.sql

ALTER TABLE entity_aliases
    ADD COLUMN IF NOT EXISTS neighbor_signatures jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS relationship_priors (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    entity_a_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    co_occurrence_count integer NOT NULL DEFAULT 0,
    accepted_relationship_count integer NOT NULL DEFAULT 0,
    event_support_count integer NOT NULL DEFAULT 0,
    scene_support_count integer NOT NULL DEFAULT 0,
    last_co_occurred_at timestamptz,
    global_correlation_score double precision NOT NULL DEFAULT 0,
    neighbor_signature jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, entity_a_id, entity_b_id),
    CHECK (entity_a_id <> entity_b_id)
);

CREATE INDEX IF NOT EXISTS idx_relationship_priors_namespace_score
    ON relationship_priors (namespace_id, global_correlation_score DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_priors_entity_a
    ON relationship_priors (namespace_id, entity_a_id, global_correlation_score DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_priors_entity_b
    ON relationship_priors (namespace_id, entity_b_id, global_correlation_score DESC);

ALTER TABLE narrative_scenes
    DROP CONSTRAINT IF EXISTS narrative_scenes_time_granularity_check;

ALTER TABLE narrative_scenes
    ADD CONSTRAINT narrative_scenes_time_granularity_check
    CHECK (time_granularity IN ('instant', 'day', 'week', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown'));

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS anchor_basis text NOT NULL DEFAULT 'fallback'
        CHECK (anchor_basis IN ('explicit', 'captured_at', 'prior_scene', 'prior_event', 'fallback'));

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS anchor_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS anchor_confidence double precision NOT NULL DEFAULT 0.2;

ALTER TABLE narrative_events
    DROP CONSTRAINT IF EXISTS narrative_events_time_granularity_check;

ALTER TABLE narrative_events
    ADD CONSTRAINT narrative_events_time_granularity_check
    CHECK (time_granularity IN ('instant', 'day', 'week', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown'));

ALTER TABLE narrative_events
    ADD COLUMN IF NOT EXISTS anchor_basis text NOT NULL DEFAULT 'fallback'
        CHECK (anchor_basis IN ('explicit', 'captured_at', 'prior_scene', 'prior_event', 'fallback'));

ALTER TABLE narrative_events
    ADD COLUMN IF NOT EXISTS anchor_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE narrative_events
    ADD COLUMN IF NOT EXISTS anchor_confidence double precision NOT NULL DEFAULT 0.2;

ALTER TABLE claim_candidates
    DROP CONSTRAINT IF EXISTS claim_candidates_time_granularity_check;

ALTER TABLE claim_candidates
    ADD CONSTRAINT claim_candidates_time_granularity_check
    CHECK (time_granularity IN ('instant', 'day', 'week', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown'));

ALTER TABLE claim_candidates
    DROP CONSTRAINT IF EXISTS claim_candidates_ambiguity_type_check;

ALTER TABLE claim_candidates
    ADD CONSTRAINT claim_candidates_ambiguity_type_check
    CHECK (
        ambiguity_type IS NULL OR ambiguity_type IN (
            'possible_misspelling',
            'undefined_kinship',
            'vague_place',
            'alias_collision',
            'unknown_reference',
            'asr_correction',
            'kinship_resolution',
            'place_grounding'
        )
    );

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS anchor_basis text NOT NULL DEFAULT 'fallback'
        CHECK (anchor_basis IN ('explicit', 'captured_at', 'prior_scene', 'prior_event', 'fallback'));

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS anchor_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS anchor_confidence double precision NOT NULL DEFAULT 0.2;

CREATE INDEX IF NOT EXISTS idx_narrative_scenes_anchor
    ON narrative_scenes (namespace_id, anchor_basis, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_ambiguity_anchor
    ON claim_candidates (namespace_id, ambiguity_state, ambiguity_type, anchor_basis, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_object_active
    ON relationship_memory (namespace_id, object_entity_id, predicate, valid_from DESC)
    WHERE valid_until IS NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity_role
    ON memory_entity_mentions (namespace_id, entity_id, mention_role, occurred_at DESC);
