-- 001_extensions.sql
-- Baseline local extension setup for Brain 2.0.
-- Use stable primitives first, then enable richer local upgrades explicitly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Local target upgrades. Enable once install paths are verified.
-- CREATE EXTENSION IF NOT EXISTS timescaledb;
-- CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
-- CREATE EXTENSION IF NOT EXISTS ai;

-- Useful optional helpers.
CREATE EXTENSION IF NOT EXISTS btree_gin;
