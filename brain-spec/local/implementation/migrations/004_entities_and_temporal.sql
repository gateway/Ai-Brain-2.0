-- 004_entities_and_temporal.sql

CREATE TABLE IF NOT EXISTS entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    entity_type text NOT NULL,
    canonical_name text NOT NULL,
    description text,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, entity_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias text NOT NULL,
    UNIQUE (entity_id, alias)
);

CREATE TABLE IF NOT EXISTS memory_entity_mentions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    memory_table text NOT NULL CHECK (memory_table IN ('episodic_memory', 'semantic_memory', 'procedural_memory', 'temporal_nodes')),
    memory_id uuid NOT NULL,
    mention_role text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity
    ON memory_entity_mentions (entity_id, memory_table);

CREATE TABLE IF NOT EXISTS entity_relationships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate text NOT NULL,
    object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    strength double precision NOT NULL DEFAULT 1.0,
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,
    support_count integer NOT NULL DEFAULT 1,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, subject_entity_id, predicate, object_entity_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_subject
    ON entity_relationships (namespace_id, subject_entity_id, predicate);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_object
    ON entity_relationships (namespace_id, object_entity_id, predicate);

CREATE TABLE IF NOT EXISTS temporal_nodes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    node_level text NOT NULL CHECK (node_level IN ('segment', 'session', 'day', 'week', 'month', 'profile', 'year')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    summary_text text NOT NULL,
    embedding vector(1536),
    embedding_model text,
    parent_node_id uuid REFERENCES temporal_nodes(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(summary_text, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_level_range
    ON temporal_nodes (namespace_id, node_level, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_parent
    ON temporal_nodes (parent_node_id);

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_search_vector
    ON temporal_nodes USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS temporal_node_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_node_id uuid NOT NULL REFERENCES temporal_nodes(id) ON DELETE CASCADE,
    child_type text NOT NULL CHECK (child_type IN ('episodic_memory', 'semantic_memory', 'temporal_nodes')),
    child_id uuid NOT NULL,
    UNIQUE (parent_node_id, child_type, child_id)
);

CREATE TABLE IF NOT EXISTS semantic_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace_id text NOT NULL,
    query_hash text NOT NULL,
    query_text text NOT NULL,
    response_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    UNIQUE (namespace_id, query_hash)
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
