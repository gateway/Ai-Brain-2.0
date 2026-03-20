-- 035_derived_layer_archival.sql

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived'));

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS archival_tier text NOT NULL DEFAULT 'hot'
        CHECK (archival_tier IN ('hot', 'warm', 'cold'));

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS is_anchor boolean NOT NULL DEFAULT false;

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS decay_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_namespace_status_tier_period
    ON temporal_nodes (namespace_id, status, archival_tier, period_end DESC);

CREATE TABLE IF NOT EXISTS temporal_decay_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    temporal_node_id uuid NOT NULL REFERENCES temporal_nodes(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action IN ('warmed', 'archived')),
    previous_tier text NOT NULL CHECK (previous_tier IN ('hot', 'warm', 'cold')),
    new_tier text NOT NULL CHECK (new_tier IN ('hot', 'warm', 'cold')),
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temporal_decay_events_namespace_created
    ON temporal_decay_events (namespace_id, created_at DESC);
