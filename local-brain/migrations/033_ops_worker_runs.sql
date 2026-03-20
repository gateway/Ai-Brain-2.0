CREATE TABLE IF NOT EXISTS ops.worker_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    worker_key text NOT NULL
        CHECK (worker_key IN ('source_monitor', 'outbox', 'temporal_summary')),
    trigger_type text NOT NULL DEFAULT 'manual'
        CHECK (trigger_type IN ('manual', 'scheduled', 'loop', 'onboarding', 'repair')),
    namespace_id text,
    source_id uuid REFERENCES ops.monitored_sources(id) ON DELETE SET NULL,
    worker_id text,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    duration_ms integer,
    next_due_at timestamptz,
    attempted_count integer NOT NULL DEFAULT 0,
    processed_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    skipped_count integer NOT NULL DEFAULT 0,
    error_class text,
    error_message text,
    summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_worker_runs_worker_started
    ON ops.worker_runs (worker_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_worker_runs_status_started
    ON ops.worker_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_worker_runs_namespace_started
    ON ops.worker_runs (namespace_id, started_at DESC);
