-- 036_authoritative_episodic_storage.sql

-- Promote episodic_memory to the authoritative time-native storage layer.
-- Derived archival remains limited to semantic/temporal layers.

CREATE INDEX IF NOT EXISTS idx_episodic_memory_occurred_brin
    ON episodic_memory
    USING BRIN (occurred_at);

COMMENT ON TABLE episodic_memory IS
    'Authoritative immutable episodic evidence. Time-native storage; derived archival policies do not apply.';

DO $$
BEGIN
    IF to_regclass('public.episodic_timeline') IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM pg_class
            WHERE oid = 'public.episodic_timeline'::regclass
              AND relkind = 'r'
        )
        AND to_regclass('public.episodic_timeline_legacy') IS NULL THEN
        EXECUTE 'ALTER TABLE episodic_timeline RENAME TO episodic_timeline_legacy';
    END IF;
END $$;

CREATE OR REPLACE VIEW episodic_timeline AS
SELECT
    em.occurred_at,
    em.id AS memory_id,
    em.namespace_id,
    em.session_id,
    em.role,
    em.content,
    em.captured_at,
    em.artifact_id,
    em.artifact_observation_id,
    em.source_chunk_id,
    em.source_offset,
    em.token_count,
    em.metadata,
    em.search_vector
FROM episodic_memory em;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'timescaledb'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE confrelid = 'episodic_memory'::regclass
          AND contype = 'f'
    ) THEN
        BEGIN
            PERFORM create_hypertable(
                'episodic_memory',
                'occurred_at',
                chunk_time_interval => interval '7 days',
                if_not_exists => TRUE,
                migrate_data => TRUE
            );
        EXCEPTION
            WHEN undefined_function THEN
                NULL;
            WHEN feature_not_supported THEN
                NULL;
        END;

        BEGIN
            EXECUTE $compression$
                ALTER TABLE episodic_memory
                SET (
                    timescaledb.compress = true,
                    timescaledb.compress_segmentby = 'namespace_id,role',
                    timescaledb.compress_orderby = 'occurred_at DESC'
                )
            $compression$;
        EXCEPTION
            WHEN undefined_object THEN
                NULL;
            WHEN feature_not_supported THEN
                NULL;
            WHEN invalid_parameter_value THEN
                NULL;
        END;

        BEGIN
            PERFORM add_compression_policy(
                'episodic_memory',
                compress_after => interval '30 days',
                if_not_exists => TRUE
            );
        EXCEPTION
            WHEN undefined_function THEN
                NULL;
            WHEN feature_not_supported THEN
                NULL;
        END;
    END IF;
END $$;
