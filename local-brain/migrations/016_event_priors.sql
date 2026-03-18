-- 016_event_priors.sql

ALTER TABLE memory_entity_mentions
    DROP CONSTRAINT IF EXISTS memory_entity_mentions_mention_role_check;

ALTER TABLE memory_entity_mentions
    ADD CONSTRAINT memory_entity_mentions_mention_role_check
    CHECK (mention_role IN ('subject', 'participant', 'location', 'project', 'organization', 'mentioned'));

CREATE TABLE IF NOT EXISTS narrative_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    event_index integer NOT NULL,
    source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
    event_kind text NOT NULL DEFAULT 'story_scene',
    event_label text NOT NULL,
    time_expression_text text,
    time_start timestamptz,
    time_end timestamptz,
    time_granularity text NOT NULL DEFAULT 'unknown'
        CHECK (time_granularity IN ('instant', 'day', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown')),
    time_confidence double precision NOT NULL DEFAULT 0.5,
    is_relative_time boolean NOT NULL DEFAULT false,
    primary_subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    primary_location_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_observation_id, event_index)
);

CREATE INDEX IF NOT EXISTS idx_narrative_events_namespace_time
    ON narrative_events (namespace_id, COALESCE(time_start, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_narrative_events_kind
    ON narrative_events (namespace_id, event_kind, COALESCE(time_start, created_at) DESC);

CREATE TABLE IF NOT EXISTS narrative_event_members (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    event_id uuid NOT NULL REFERENCES narrative_events(id) ON DELETE CASCADE,
    entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    member_role text NOT NULL DEFAULT 'participant'
        CHECK (member_role IN ('subject', 'participant', 'location', 'organization', 'project', 'mentioned')),
    confidence double precision NOT NULL DEFAULT 0.5,
    source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (event_id, entity_id, member_role, source_scene_id, source_memory_id)
);

CREATE INDEX IF NOT EXISTS idx_narrative_event_members_event
    ON narrative_event_members (event_id, member_role, entity_id);

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS time_expression_text text;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS time_start timestamptz;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS time_end timestamptz;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS time_granularity text NOT NULL DEFAULT 'unknown'
        CHECK (time_granularity IN ('instant', 'day', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown'));

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS time_confidence double precision NOT NULL DEFAULT 0.5;

ALTER TABLE narrative_scenes
    ADD COLUMN IF NOT EXISTS is_relative_time boolean NOT NULL DEFAULT false;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS time_expression_text text;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS time_start timestamptz;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS time_end timestamptz;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS time_granularity text NOT NULL DEFAULT 'unknown'
        CHECK (time_granularity IN ('instant', 'day', 'month', 'year', 'relative_duration', 'relative_recent', 'unknown'));

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS time_confidence double precision NOT NULL DEFAULT 0.5;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS is_relative_time boolean NOT NULL DEFAULT false;

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL;

ALTER TABLE temporal_node_members
    ADD COLUMN IF NOT EXISTS source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE temporal_node_members
    ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES narrative_events(id) ON DELETE SET NULL;
