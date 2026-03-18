-- 004_entities_and_relationships.sql

CREATE TABLE IF NOT EXISTS entities (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN ('self', 'person', 'place', 'project', 'concept', 'unknown')),
    canonical_name text NOT NULL,
    normalized_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, entity_type, normalized_name)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias text NOT NULL,
    normalized_alias text NOT NULL,
    alias_type text NOT NULL DEFAULT 'observed' CHECK (alias_type IN ('observed', 'manual', 'derived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (entity_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS memory_entity_mentions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE CASCADE,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE CASCADE,
    mention_text text NOT NULL,
    mention_role text NOT NULL CHECK (mention_role IN ('subject', 'participant', 'location', 'project', 'mentioned')),
    confidence double precision NOT NULL DEFAULT 0.5,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE NULLS NOT DISTINCT (entity_id, source_memory_id, source_chunk_id, mention_text)
);

CREATE TABLE IF NOT EXISTS relationship_candidates (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate text NOT NULL,
    object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_memory_id uuid REFERENCES episodic_memory(id) ON DELETE CASCADE,
    source_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE CASCADE,
    confidence double precision NOT NULL DEFAULT 0.5,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
    valid_from timestamptz,
    valid_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE NULLS NOT DISTINCT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_entities_namespace_name
    ON entities (namespace_id, normalized_name);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized
    ON entity_aliases (normalized_alias);

CREATE INDEX IF NOT EXISTS idx_mentions_memory
    ON memory_entity_mentions (source_memory_id, entity_id);

CREATE INDEX IF NOT EXISTS idx_mentions_entity_occurred
    ON memory_entity_mentions (entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_namespace_status
    ON relationship_candidates (namespace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_subject
    ON relationship_candidates (subject_entity_id, predicate, object_entity_id);
