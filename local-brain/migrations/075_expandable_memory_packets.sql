-- 075_expandable_memory_packets.sql

CREATE TABLE IF NOT EXISTS memory_source_windows (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id text,
    source_window_key text NOT NULL,
    source_kind text NOT NULL,
    source_uri text NOT NULL,
    start_locator text NOT NULL,
    end_locator text NOT NULL,
    text_preview text NOT NULL,
    content_hash text NOT NULL,
    token_estimate integer NOT NULL DEFAULT 0,
    redaction_state text NOT NULL DEFAULT 'none',
    captured_at timestamptz,
    occurred_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, source_window_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_source_windows_namespace_kind
    ON memory_source_windows (namespace_id, source_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_source_windows_artifact
    ON memory_source_windows (namespace_id, artifact_id);

CREATE TABLE IF NOT EXISTS memory_summary_nodes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id text,
    source_kind text NOT NULL,
    node_kind text NOT NULL,
    depth integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active',
    title text,
    summary_text text NOT NULL,
    omitted_details text[] NOT NULL DEFAULT '{}',
    expand_prompts text[] NOT NULL DEFAULT '{}',
    source_window_start text,
    source_window_end text,
    captured_at timestamptz,
    occurred_at timestamptz,
    token_estimate integer NOT NULL DEFAULT 0,
    model text,
    summarizer_version text NOT NULL,
    source_hash text NOT NULL,
    source_context_hash text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, node_kind, source_context_hash, summarizer_version)
);

CREATE INDEX IF NOT EXISTS idx_memory_summary_nodes_namespace_kind
    ON memory_summary_nodes (namespace_id, node_kind, depth, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_summary_nodes_artifact
    ON memory_summary_nodes (namespace_id, artifact_id);

CREATE TABLE IF NOT EXISTS memory_summary_edges (
    parent_node_id uuid NOT NULL REFERENCES memory_summary_nodes(id) ON DELETE CASCADE,
    child_node_id uuid NOT NULL REFERENCES memory_summary_nodes(id) ON DELETE CASCADE,
    edge_kind text NOT NULL,
    ordinal integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (parent_node_id, child_node_id, edge_kind)
);

CREATE INDEX IF NOT EXISTS idx_memory_summary_edges_child
    ON memory_summary_edges (child_node_id, edge_kind);
