-- 014_temporal_tree_links.sql

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES temporal_nodes(id) ON DELETE SET NULL;

ALTER TABLE temporal_nodes
    ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;

UPDATE temporal_nodes
SET depth = CASE layer
    WHEN 'session' THEN 1
    WHEN 'day' THEN 2
    WHEN 'week' THEN 3
    WHEN 'month' THEN 4
    WHEN 'year' THEN 5
    WHEN 'profile' THEN 6
    ELSE 0
END
WHERE depth = 0;

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_parent
    ON temporal_nodes (parent_id);

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_namespace_layer_depth_period
    ON temporal_nodes (namespace_id, layer, depth, period_start DESC);
