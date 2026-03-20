CREATE TABLE IF NOT EXISTS ops.monitored_sources (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    source_type text NOT NULL
        CHECK (source_type IN ('openclaw', 'folder')),
    namespace_id text NOT NULL,
    label text NOT NULL,
    root_path text NOT NULL,
    include_subfolders boolean NOT NULL DEFAULT true,
    file_extensions_json jsonb NOT NULL DEFAULT '[".md", ".txt"]'::jsonb,
    monitor_enabled boolean NOT NULL DEFAULT false,
    scan_schedule text NOT NULL DEFAULT 'disabled',
    status text NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'disabled', 'error')),
    created_by text,
    notes text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_scan_at timestamptz,
    last_import_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_monitored_sources_status_updated
    ON ops.monitored_sources (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_monitored_sources_namespace_updated
    ON ops.monitored_sources (namespace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops.source_scan_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    source_id uuid NOT NULL REFERENCES ops.monitored_sources(id) ON DELETE CASCADE,
    scan_started_at timestamptz NOT NULL DEFAULT now(),
    scan_finished_at timestamptz,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    files_seen integer NOT NULL DEFAULT 0,
    new_files integer NOT NULL DEFAULT 0,
    changed_files integer NOT NULL DEFAULT 0,
    deleted_files integer NOT NULL DEFAULT 0,
    errored_files integer NOT NULL DEFAULT 0,
    notes text,
    result_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ops_source_scan_runs_source_started
    ON ops.source_scan_runs (source_id, scan_started_at DESC);

CREATE TABLE IF NOT EXISTS ops.source_import_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    source_id uuid NOT NULL REFERENCES ops.monitored_sources(id) ON DELETE CASCADE,
    trigger_type text NOT NULL
        CHECK (trigger_type IN ('manual', 'scheduled', 'onboarding')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    files_attempted integer NOT NULL DEFAULT 0,
    files_imported integer NOT NULL DEFAULT 0,
    files_skipped integer NOT NULL DEFAULT 0,
    files_failed integer NOT NULL DEFAULT 0,
    brain_job_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes text,
    result_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ops_source_import_runs_source_started
    ON ops.source_import_runs (source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ops.monitored_source_files (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    source_id uuid NOT NULL REFERENCES ops.monitored_sources(id) ON DELETE CASCADE,
    absolute_path text NOT NULL,
    relative_path text NOT NULL,
    file_name text NOT NULL,
    extension text NOT NULL,
    size_bytes bigint,
    modified_at timestamptz,
    content_hash text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    exists_now boolean NOT NULL DEFAULT true,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    last_import_run_id uuid REFERENCES ops.source_import_runs(id) ON DELETE SET NULL,
    last_imported_hash text,
    last_imported_at timestamptz,
    last_status text NOT NULL DEFAULT 'new'
        CHECK (last_status IN ('new', 'changed', 'unchanged', 'deleted', 'imported', 'error')),
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, absolute_path)
);

CREATE INDEX IF NOT EXISTS idx_ops_monitored_source_files_source_status
    ON ops.monitored_source_files (source_id, last_status, exists_now);

CREATE INDEX IF NOT EXISTS idx_ops_monitored_source_files_source_relative
    ON ops.monitored_source_files (source_id, relative_path);

CREATE TABLE IF NOT EXISTS ops.bootstrap_state (
    id boolean PRIMARY KEY DEFAULT true,
    owner_profile_completed boolean NOT NULL DEFAULT false,
    source_import_completed boolean NOT NULL DEFAULT false,
    verification_completed boolean NOT NULL DEFAULT false,
    onboarding_completed_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.bootstrap_state (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;
