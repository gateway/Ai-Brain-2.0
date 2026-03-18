-- 001_extensions.sql
-- Safe local baseline for the first Brain 2.0 implementation slice.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Target local upgrades after native bring-up is proven.
-- CREATE EXTENSION IF NOT EXISTS timescaledb;
-- CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
-- CREATE EXTENSION IF NOT EXISTS ai;
