-- 022_cross_lane_identity_conflicts.sql

ALTER TABLE identity_profiles
    DROP CONSTRAINT IF EXISTS identity_profiles_profile_type_check;

ALTER TABLE identity_profiles
    ADD CONSTRAINT identity_profiles_profile_type_check
    CHECK (profile_type IN ('self', 'person', 'place', 'org', 'project', 'concept', 'unknown'));

CREATE TABLE IF NOT EXISTS identity_conflict_decisions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    entity_a_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    decision text NOT NULL CHECK (decision IN ('merge', 'keep_separate')),
    canonical_name text,
    identity_profile_id uuid REFERENCES identity_profiles(id) ON DELETE SET NULL,
    note text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_a_id, entity_b_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_conflict_decisions_entity_a
    ON identity_conflict_decisions (entity_a_id, decision, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_identity_conflict_decisions_entity_b
    ON identity_conflict_decisions (entity_b_id, decision, updated_at DESC);
