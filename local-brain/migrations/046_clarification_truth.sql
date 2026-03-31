-- 046_clarification_truth.sql

CREATE TABLE IF NOT EXISTS clarification_resolutions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    ambiguity_type text NOT NULL,
    ambiguity_class text NOT NULL
        CHECK (ambiguity_class IN (
            'kinship_person',
            'nickname_person',
            'vague_place',
            'alias_collision',
            'speaker_subject_conflict'
        )),
    resolution_state text NOT NULL
        CHECK (resolution_state IN ('resolved', 'ignored')),
    target_role text NOT NULL
        CHECK (target_role IN ('subject', 'object')),
    raw_text text NOT NULL,
    normalized_raw_text text NOT NULL,
    canonical_name text,
    entity_type text,
    aliases text[] NOT NULL DEFAULT '{}'::text[],
    source_candidate_id uuid REFERENCES claim_candidates(id) ON DELETE SET NULL,
    source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
    source_memory_id uuid,
    operator_note text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, ambiguity_type, target_role, normalized_raw_text)
);

CREATE INDEX IF NOT EXISTS idx_clarification_resolutions_namespace_updated
    ON clarification_resolutions (namespace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_clarification_resolutions_namespace_state
    ON clarification_resolutions (namespace_id, resolution_state, updated_at DESC);
