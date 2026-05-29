-- 001_extensions.sql
-- Safe local baseline for the first Brain 2.0 implementation slice.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- CI and fresh local pgvector images do not always ship a native uuidv7()
-- provider. Keep the schema default stable while falling back to pgcrypto UUIDs
-- when no uuidv7 implementation is already installed.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'uuidv7'
          AND n.nspname = 'public'
          AND pg_get_function_identity_arguments(p.oid) = ''
    ) THEN
        CREATE FUNCTION public.uuidv7()
        RETURNS uuid
        LANGUAGE sql
        VOLATILE
        AS 'SELECT gen_random_uuid()';
    END IF;
END $$;

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
