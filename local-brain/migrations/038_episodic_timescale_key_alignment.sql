-- 038_episodic_timescale_key_alignment.sql

-- Realign authoritative episodic constraints so Timescale can enforce
-- partition-safe uniqueness on the hypertable.

DO $$
DECLARE
    constraint_row record;
BEGIN
    FOR constraint_row IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'episodic_memory'::regclass
          AND c.contype IN ('p', 'u')
          AND NOT EXISTS (
              SELECT 1
              FROM unnest(c.conkey) AS key_attnum(attnum)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid
               AND a.attnum = key_attnum.attnum
              WHERE a.attname = 'occurred_at'
          )
    LOOP
        EXECUTE format('ALTER TABLE episodic_memory DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
    END LOOP;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'episodic_memory'::regclass
          AND contype = 'p'
    ) THEN
        ALTER TABLE episodic_memory
            ADD CONSTRAINT episodic_memory_pkey
            PRIMARY KEY (occurred_at, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'episodic_memory'::regclass
          AND conname = 'episodic_memory_ingest_temporal_key'
    ) THEN
        ALTER TABLE episodic_memory
            ADD CONSTRAINT episodic_memory_ingest_temporal_key
            UNIQUE NULLS NOT DISTINCT (occurred_at, artifact_observation_id, source_chunk_id, role);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_episodic_memory_id_lookup
    ON episodic_memory (id);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_occurred_id_desc
    ON episodic_memory (occurred_at DESC, id DESC);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'timescaledb'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public'
          AND hypertable_name = 'episodic_memory'
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
            WHEN duplicate_object THEN
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
