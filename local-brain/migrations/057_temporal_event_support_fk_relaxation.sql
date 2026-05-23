-- 057_temporal_event_support_fk_relaxation.sql

ALTER TABLE temporal_event_support
  DROP CONSTRAINT IF EXISTS temporal_event_support_support_memory_id_fkey;

CREATE INDEX IF NOT EXISTS idx_temporal_event_support_memory_lookup
  ON temporal_event_support (support_memory_id)
  WHERE support_memory_id IS NOT NULL;
