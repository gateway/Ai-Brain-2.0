-- Source privacy, retention, and deletion overlays.
--
-- Raw artifacts/chunks remain immutable source of truth. Privacy operations are
-- cataloged as active overlays with audit rows so they can be inspected and
-- reverted without deleting the original evidence.

CREATE TABLE IF NOT EXISTS source_truth_catalog (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    source_uri text NOT NULL,
    checksum_sha256 text,
    source_kind text,
    raw_retention_policy text NOT NULL DEFAULT 'retain_immutable',
    catalog_status text NOT NULL DEFAULT 'active' CHECK (catalog_status IN ('active', 'cataloged', 'superseded')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, source_uri)
);

CREATE INDEX IF NOT EXISTS idx_source_truth_catalog_namespace_uri
    ON source_truth_catalog (namespace_id, lower(source_uri));

CREATE INDEX IF NOT EXISTS idx_source_truth_catalog_artifact
    ON source_truth_catalog (artifact_id)
    WHERE artifact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_privacy_overlays (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    action_type text NOT NULL CHECK (action_type IN ('logical_delete', 'redact', 'access_label', 'retention_policy')),
    target_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
    target_source_uri text,
    target_chunk_id uuid REFERENCES artifact_chunks(id) ON DELETE SET NULL,
    redaction_text text,
    access_label text,
    retention_policy text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted')),
    reason text,
    actor text,
    source_truth_catalog_id uuid REFERENCES source_truth_catalog(id) ON DELETE SET NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    reverted_at timestamptz,
    reverted_by text,
    revert_reason text,
    CHECK (target_artifact_id IS NOT NULL OR target_source_uri IS NOT NULL OR target_chunk_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_source_privacy_overlays_active_artifact
    ON source_privacy_overlays (namespace_id, status, target_artifact_id)
    WHERE target_artifact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_privacy_overlays_active_uri
    ON source_privacy_overlays (namespace_id, status, lower(target_source_uri))
    WHERE target_source_uri IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_privacy_overlays_active_chunk
    ON source_privacy_overlays (namespace_id, status, target_chunk_id)
    WHERE target_chunk_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_privacy_audit_log (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    overlay_id uuid REFERENCES source_privacy_overlays(id) ON DELETE SET NULL,
    event_type text NOT NULL CHECK (event_type IN ('created', 'enforced', 'reverted', 'status_read')),
    actor text,
    reason text,
    query_text text,
    affected_artifact_ids text[] NOT NULL DEFAULT '{}'::text[],
    affected_source_uris text[] NOT NULL DEFAULT '{}'::text[],
    affected_chunk_ids text[] NOT NULL DEFAULT '{}'::text[],
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_privacy_audit_log_namespace_created
    ON source_privacy_audit_log (namespace_id, created_at DESC);
