-- 005_retrieval_and_promotion_support.sql

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS memory_kind text NOT NULL DEFAULT 'note';

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS canonical_key text;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS normalized_value jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES semantic_memory(id) ON DELETE SET NULL;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS source_artifact_observation_id uuid REFERENCES artifact_observations(id) ON DELETE SET NULL;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS canonical_key text;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS normalized_value jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS source_artifact_observation_id uuid REFERENCES artifact_observations(id) ON DELETE SET NULL;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS processed_at timestamptz;

ALTER TABLE memory_candidates
    ADD COLUMN IF NOT EXISTS decision_reason text;

CREATE INDEX IF NOT EXISTS idx_semantic_canonical_active
    ON semantic_memory (namespace_id, canonical_key, valid_from DESC)
    WHERE valid_until IS NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_candidates_content_search
    ON memory_candidates USING GIN (to_tsvector('english', coalesce(content, '')));

CREATE INDEX IF NOT EXISTS idx_memory_candidates_canonical
    ON memory_candidates (namespace_id, candidate_type, canonical_key, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_procedural_active_lookup
    ON procedural_memory (namespace_id, state_type, state_key, valid_from DESC)
    WHERE valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_procedural_search_vector
    ON procedural_memory USING GIN (
        to_tsvector(
            'english',
            coalesce(state_type, '') || ' ' || coalesce(state_key, '') || ' ' || coalesce(state_value::text, '')
        )
    );
