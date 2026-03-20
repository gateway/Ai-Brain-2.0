CREATE TABLE IF NOT EXISTS memory_reconsolidation_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    query_text text NOT NULL,
    trigger_confidence text NOT NULL CHECK (trigger_confidence IN ('confident', 'weak', 'missing')),
    action text NOT NULL CHECK (action IN ('add', 'update', 'supersede', 'abstain', 'skip')),
    target_memory_kind text NOT NULL,
    semantic_memory_id uuid REFERENCES semantic_memory(id) ON DELETE SET NULL,
    source_episodic_id uuid REFERENCES episodic_memory(id) ON DELETE SET NULL,
    reason text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_reconsolidation_events_namespace_created
    ON memory_reconsolidation_events (namespace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_reconsolidation_events_query
    ON memory_reconsolidation_events (namespace_id, query_text, created_at DESC);
