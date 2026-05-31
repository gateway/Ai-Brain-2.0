-- 076_memory_focus_packets.sql

CREATE TABLE IF NOT EXISTS memory_focus_packets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    packet_type text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    prompt text NOT NULL,
    projects text[] NOT NULL DEFAULT '{}',
    source_kinds text[] NOT NULL DEFAULT '{}',
    summary_node_ids text[] NOT NULL DEFAULT '{}',
    source_window_ids text[] NOT NULL DEFAULT '{}',
    reused_packet_ids text[] NOT NULL DEFAULT '{}',
    coverage_start timestamptz,
    coverage_end timestamptz,
    source_context_hash text NOT NULL,
    token_estimate integer NOT NULL DEFAULT 0,
    raw_source_token_estimate integer NOT NULL DEFAULT 0,
    packet_text text NOT NULL,
    diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, packet_type, source_context_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_focus_packets_namespace_status
    ON memory_focus_packets (namespace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_focus_packets_projects
    ON memory_focus_packets USING GIN (projects);

CREATE INDEX IF NOT EXISTS idx_memory_focus_packets_source_kinds
    ON memory_focus_packets USING GIN (source_kinds);
