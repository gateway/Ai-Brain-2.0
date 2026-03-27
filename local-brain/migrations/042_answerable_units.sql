-- 042_answerable_units.sql

CREATE TABLE IF NOT EXISTS answerable_units (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('episodic_memory', 'artifact_derivation')),
    source_memory_id uuid,
    source_derivation_id uuid REFERENCES artifact_derivations(id) ON DELETE CASCADE,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    artifact_observation_id uuid REFERENCES artifact_observations(id) ON DELETE CASCADE,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
    unit_type text NOT NULL CHECK (unit_type IN ('participant_turn', 'source_sentence', 'event_span', 'date_span', 'fact_span')),
    content_text text NOT NULL,
    owner_entity_hint text,
    speaker_entity_hint text,
    participant_names jsonb NOT NULL DEFAULT '[]'::jsonb,
    char_start integer,
    char_end integer,
    turn_index integer,
    turn_start_index integer,
    turn_end_index integer,
    occurred_at timestamptz,
    valid_from timestamptz,
    valid_until timestamptz,
    is_current boolean,
    ownership_confidence double precision NOT NULL DEFAULT 0,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector(
            'english',
            coalesce(owner_entity_hint, '')
            || ' '
            || coalesce(speaker_entity_hint, '')
            || ' '
            || coalesce(content_text, '')
        )
    ) STORED,
    CHECK (num_nonnulls(source_memory_id, source_derivation_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_answerable_units_dedup
    ON answerable_units (
        namespace_id,
        source_kind,
        coalesce(source_memory_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(source_derivation_id, '00000000-0000-0000-0000-000000000000'::uuid),
        unit_type,
        coalesce(char_start, -1),
        coalesce(char_end, -1),
        coalesce(turn_index, -1)
    );

CREATE INDEX IF NOT EXISTS idx_answerable_units_namespace_occurred
    ON answerable_units (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_answerable_units_namespace_owner_occurred
    ON answerable_units (namespace_id, owner_entity_hint, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_answerable_units_observation_type
    ON answerable_units (artifact_observation_id, unit_type);

CREATE INDEX IF NOT EXISTS idx_answerable_units_owner_partial
    ON answerable_units (namespace_id, owner_entity_hint)
    WHERE owner_entity_hint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_answerable_units_search_vector
    ON answerable_units USING GIN (search_vector);

COMMENT ON TABLE answerable_units IS
    'Derived answer-bearing retrieval/indexing support rows. Authoritative truth remains in episodic_memory and related tables.';
