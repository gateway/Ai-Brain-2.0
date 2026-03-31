-- 044_canonical_entity_rebuilds.sql

CREATE TABLE IF NOT EXISTS entity_rebuild_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    trigger_kind text NOT NULL,
    trigger_event_id uuid REFERENCES brain_outbox_events(id) ON DELETE SET NULL,
    rebuild_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_entity_rebuild_runs_namespace_started
    ON entity_rebuild_runs (namespace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_rebuild_runs_status_started
    ON entity_rebuild_runs (status, started_at DESC);

CREATE OR REPLACE VIEW canonical_entity_registry AS
SELECT
    root.id,
    root.namespace_id,
    root.entity_type,
    root.canonical_name,
    root.normalized_name,
    root.identity_profile_id,
    root.metadata,
    root.last_seen_at,
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'entity_id', child.id,
                    'canonical_name', child.canonical_name,
                    'normalized_name', child.normalized_name
                )
                ORDER BY child.created_at ASC
            )
            FROM entities child
            WHERE child.merged_into_entity_id = root.id
        ),
        '[]'::jsonb
    ) AS merged_entities,
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'alias', ea.alias,
                    'normalized_alias', ea.normalized_alias,
                    'alias_type', ea.alias_type,
                    'is_user_verified', ea.is_user_verified,
                    'metadata', ea.metadata
                )
                ORDER BY ea.is_user_verified DESC, ea.created_at ASC
            )
            FROM entity_aliases ea
            WHERE ea.entity_id = root.id
        ),
        '[]'::jsonb
    ) AS aliases
FROM entities root
WHERE root.merged_into_entity_id IS NULL;

CREATE OR REPLACE VIEW canonical_redirect_integrity_audit AS
SELECT
    e.id,
    e.namespace_id,
    e.canonical_name,
    e.merged_into_entity_id,
    CASE
        WHEN e.merged_into_entity_id IS NULL THEN 'not_redirected'
        WHEN e.merged_into_entity_id = e.id THEN 'self_redirect'
        WHEN target.id IS NULL THEN 'missing_target'
        WHEN target.namespace_id <> e.namespace_id THEN 'cross_namespace_redirect'
        ELSE 'ok'
    END AS redirect_status
FROM entities e
LEFT JOIN entities target ON target.id = e.merged_into_entity_id
WHERE e.merged_into_entity_id IS NOT NULL;

CREATE OR REPLACE VIEW relationship_canonical_integrity_audit AS
SELECT
    'relationship_memory'::text AS source_table,
    rm.id AS row_id,
    rm.namespace_id,
    rm.subject_entity_id,
    rm.object_entity_id,
    subject.merged_into_entity_id AS subject_redirect_target,
    object_entity.merged_into_entity_id AS object_redirect_target
FROM relationship_memory rm
JOIN entities subject ON subject.id = rm.subject_entity_id
JOIN entities object_entity ON object_entity.id = rm.object_entity_id
WHERE subject.merged_into_entity_id IS NOT NULL
   OR object_entity.merged_into_entity_id IS NOT NULL

UNION ALL

SELECT
    'relationship_candidate'::text AS source_table,
    rc.id AS row_id,
    rc.namespace_id,
    rc.subject_entity_id,
    rc.object_entity_id,
    subject.merged_into_entity_id AS subject_redirect_target,
    object_entity.merged_into_entity_id AS object_redirect_target
FROM relationship_candidates rc
JOIN entities subject ON subject.id = rc.subject_entity_id
JOIN entities object_entity ON object_entity.id = rc.object_entity_id
WHERE subject.merged_into_entity_id IS NOT NULL
   OR object_entity.merged_into_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity_verified_alias
    ON entity_aliases (entity_id, is_user_verified DESC, normalized_alias);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_namespace_subject_tenure
    ON relationship_memory (namespace_id, subject_entity_id, predicate, valid_until, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_namespace_object_tenure
    ON relationship_memory (namespace_id, object_entity_id, predicate, valid_until, valid_from DESC);
