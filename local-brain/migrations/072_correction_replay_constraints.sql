-- Replayable correction artifacts, hard role constraints, reference audits, and
-- correction write-locks for MCP-driven identity/entity cleanup.

CREATE TABLE IF NOT EXISTS correction_source_envelopes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    correction_kind text NOT NULL CHECK (correction_kind IN ('alias_merge', 'role_correction', 'keep_separate')),
    source_name text NOT NULL,
    canonical_name text,
    source_entity_id uuid,
    target_entity_id uuid,
    source_entity_type text,
    canonical_entity_type text,
    action text NOT NULL,
    outbox_event_id uuid REFERENCES brain_outbox_events(id) ON DELETE SET NULL,
    decision_table text,
    decision_id uuid,
    source_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_correction_source_envelopes_namespace_created
    ON correction_source_envelopes (namespace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_correction_source_envelopes_source_lookup
    ON correction_source_envelopes (namespace_id, lower(source_name), lower(coalesce(canonical_name, '')));

CREATE TABLE IF NOT EXISTS correction_class_constraints (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    surface_name text NOT NULL,
    normalized_name text NOT NULL,
    canonical_name text NOT NULL,
    corrected_role text NOT NULL,
    forbidden_roles text[] NOT NULL DEFAULT '{}'::text[],
    allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
    source_envelope_id uuid REFERENCES correction_source_envelopes(id) ON DELETE SET NULL,
    decision_reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, normalized_name, corrected_role)
);

CREATE INDEX IF NOT EXISTS idx_correction_class_constraints_lookup
    ON correction_class_constraints (namespace_id, normalized_name, corrected_role);

CREATE TABLE IF NOT EXISTS correction_reference_audits (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    source_entity_id uuid,
    target_entity_id uuid,
    correction_envelope_id uuid REFERENCES correction_source_envelopes(id) ON DELETE SET NULL,
    audit_kind text NOT NULL CHECK (audit_kind IN ('alias_merge', 'role_correction', 'keep_separate')),
    source_reference_count integer NOT NULL DEFAULT 0,
    intentionally_retained_count integer NOT NULL DEFAULT 0,
    relationship_source_ref_count integer NOT NULL DEFAULT 0,
    self_binding_source_ref_count integer NOT NULL DEFAULT 0,
    relationship_prior_source_ref_count integer NOT NULL DEFAULT 0,
    passed boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_correction_reference_audits_namespace_created
    ON correction_reference_audits (namespace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS correction_write_locks (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    entity_name text NOT NULL,
    normalized_name text NOT NULL,
    entity_type text,
    lock_reason text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    source_envelope_id uuid REFERENCES correction_source_envelopes(id) ON DELETE SET NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_correction_write_locks_active
    ON correction_write_locks (namespace_id, status, normalized_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_write_locks_idempotency
    ON correction_write_locks (namespace_id, normalized_name, coalesce(entity_type, ''), lock_reason);
