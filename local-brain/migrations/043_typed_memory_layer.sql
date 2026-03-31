-- 043_typed_memory_layer.sql

CREATE VIEW canonical_entities AS
SELECT
    e.id,
    e.namespace_id,
    e.entity_type,
    e.canonical_name,
    e.normalized_name,
    e.last_seen_at,
    e.metadata,
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'alias', ea.alias,
                    'normalized_alias', ea.normalized_alias,
                    'alias_type', ea.alias_type
                )
                ORDER BY ea.created_at ASC
            )
            FROM entity_aliases ea
            WHERE ea.entity_id = e.id
        ),
        '[]'::jsonb
    ) AS aliases
FROM entities e;

CREATE VIEW entity_mentions AS
SELECT
    mem.id,
    mem.namespace_id,
    mem.entity_id,
    e.canonical_name,
    e.entity_type,
    mem.source_memory_id,
    mem.source_chunk_id,
    mem.mention_text,
    mem.mention_role,
    mem.confidence,
    mem.occurred_at,
    mem.metadata
FROM memory_entity_mentions mem
JOIN entities e ON e.id = mem.entity_id;

CREATE VIEW relationship_facts AS
SELECT
    rm.id,
    rm.namespace_id,
    rm.subject_entity_id,
    subject_entity.canonical_name AS subject_name,
    rm.predicate,
    rm.object_entity_id,
    object_entity.canonical_name AS object_name,
    rm.confidence,
    rm.status,
    rm.valid_from,
    rm.valid_until,
    rm.source_candidate_id,
    rm.metadata
FROM relationship_memory rm
JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
JOIN entities object_entity ON object_entity.id = rm.object_entity_id;

CREATE TABLE IF NOT EXISTS task_items (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text,
    project_name text,
    assignee_guess text,
    due_hint text,
    status text NOT NULL CHECK (status IN ('open', 'completed', 'archived')),
    occurred_at timestamptz,
    completed_at timestamptz,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, source_memory_id, title, status)
);

CREATE INDEX IF NOT EXISTS idx_task_items_namespace_status_time
    ON task_items (namespace_id, status, COALESCE(completed_at, occurred_at) DESC);

CREATE INDEX IF NOT EXISTS idx_task_items_namespace_project
    ON task_items (namespace_id, project_name, COALESCE(completed_at, occurred_at) DESC);

CREATE TABLE IF NOT EXISTS project_items (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    canonical_name text NOT NULL,
    normalized_name text NOT NULL,
    current_summary text,
    status text NOT NULL CHECK (status IN ('active', 'historical')),
    occurred_at timestamptz,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (namespace_id, normalized_name, source_memory_id)
);

CREATE INDEX IF NOT EXISTS idx_project_items_namespace_name
    ON project_items (namespace_id, normalized_name, occurred_at DESC);

CREATE TABLE IF NOT EXISTS date_time_spans (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
    span_text text NOT NULL,
    normalized_year integer,
    normalized_month integer,
    normalized_day integer,
    occurred_at timestamptz,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_date_time_spans_namespace_occurred
    ON date_time_spans (namespace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_date_time_spans_namespace_date
    ON date_time_spans (namespace_id, normalized_year, normalized_month, normalized_day);

CREATE INDEX IF NOT EXISTS idx_task_items_source_memory
    ON task_items (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_items_source_memory
    ON project_items (source_memory_id)
    WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_date_time_spans_source_memory
    ON date_time_spans (source_memory_id)
    WHERE source_memory_id IS NOT NULL;
