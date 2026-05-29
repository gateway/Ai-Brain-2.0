-- 001_extensions.sql
-- Safe local baseline for the first Brain 2.0 implementation slice.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_available_extensions
        WHERE name = 'timescaledb'
    ) THEN
        CREATE EXTENSION IF NOT EXISTS timescaledb;
    ELSE
        RAISE NOTICE 'timescaledb extension is not available; continuing with plain temporal tables.';
    END IF;
END $$;

-- Target local upgrades after native bring-up is proven.
-- CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
-- CREATE EXTENSION IF NOT EXISTS ai;
