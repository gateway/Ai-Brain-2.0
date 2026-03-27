-- 041_memory_graph_edges.sql

CREATE TABLE IF NOT EXISTS memory_graph_edges (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_memory_id uuid NOT NULL,
    source_memory_type text NOT NULL CHECK (
        source_memory_type IN (
            'episodic_memory',
            'semantic_memory',
            'procedural_memory',
            'relationship_memory',
            'narrative_event',
            'artifact_derivation',
            'temporal_nodes'
        )
    ),
    target_memory_id uuid NOT NULL,
    target_memory_type text NOT NULL CHECK (
        target_memory_type IN (
            'episodic_memory',
            'semantic_memory',
            'procedural_memory',
            'relationship_memory',
            'narrative_event',
            'artifact_derivation',
            'temporal_nodes'
        )
    ),
    edge_type text NOT NULL CHECK (
        edge_type IN ('support', 'entity_link', 'relationship_link', 'supersedes', 'co_retrieval')
    ),
    weight double precision NOT NULL DEFAULT 1.0,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_reinforced_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (
        namespace_id,
        source_memory_id,
        source_memory_type,
        target_memory_id,
        target_memory_type,
        edge_type
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_source
    ON memory_graph_edges (namespace_id, source_memory_id, source_memory_type, edge_type, weight DESC);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_target
    ON memory_graph_edges (namespace_id, target_memory_id, target_memory_type, edge_type, weight DESC);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_recent
    ON memory_graph_edges (namespace_id, edge_type, last_reinforced_at DESC);
