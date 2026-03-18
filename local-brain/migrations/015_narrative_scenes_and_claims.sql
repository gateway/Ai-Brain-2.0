-- 015_narrative_scenes_and_claims.sql

ALTER TABLE entities
    DROP CONSTRAINT IF EXISTS entities_entity_type_check;

ALTER TABLE entities
    ADD CONSTRAINT entities_entity_type_check
    CHECK (entity_type IN ('self', 'person', 'place', 'org', 'project', 'concept', 'unknown'));

CREATE TABLE IF NOT EXISTS narrative_scenes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid NOT NULL REFERENCES artifact_observations(id) ON DELETE CASCADE,
    scene_index integer NOT NULL,
    scene_kind text NOT NULL DEFAULT 'paragraph'
        CHECK (scene_kind IN ('paragraph', 'session', 'topic', 'surprise_break')),
    scene_text text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    captured_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_observation_id, scene_index)
);

CREATE INDEX IF NOT EXISTS idx_narrative_scenes_namespace_occurred
    ON narrative_scenes (namespace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS claim_candidates (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE CASCADE,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
    subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    claim_type text NOT NULL,
    subject_text text,
    subject_entity_type text,
    predicate text NOT NULL,
    object_text text,
    object_entity_type text,
    normalized_text text NOT NULL,
    confidence double precision NOT NULL DEFAULT 0.5,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'abstained', 'promoted')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    extraction_method text NOT NULL DEFAULT 'deterministic_scene_claims',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_namespace_status
    ON claim_candidates (namespace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_scene
    ON claim_candidates (source_scene_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_subject_object
    ON claim_candidates (subject_entity_id, predicate, object_entity_id);

ALTER TABLE memory_entity_mentions
    ADD COLUMN IF NOT EXISTS source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS source_scene_id uuid REFERENCES narrative_scenes(id) ON DELETE SET NULL;
