-- Entity role conflict projection and durable role-resolution decisions.

CREATE TABLE IF NOT EXISTS entity_role_resolution_decisions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    surface_name text NOT NULL,
    canonical_name text NOT NULL,
    normalized_name text NOT NULL,
    from_role text NOT NULL,
    to_role text,
    action text NOT NULL CHECK (action IN ('canonicalize_role', 'split_identity', 'allow_multi_role', 'needs_review', 'retire_invalid_role')),
    confidence double precision NOT NULL DEFAULT 0,
    evidence_count integer NOT NULL DEFAULT 0,
    source_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
    decided_by text NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (namespace_id, normalized_name, from_role, action)
);

CREATE INDEX IF NOT EXISTS idx_entity_role_resolution_decisions_lookup
    ON entity_role_resolution_decisions (namespace_id, normalized_name, action, decided_at DESC);

CREATE TABLE IF NOT EXISTS entity_role_conflict_projection (
    namespace_id text NOT NULL,
    surface_name text NOT NULL,
    canonical_name text NOT NULL,
    normalized_name text NOT NULL,
    observed_roles text[] NOT NULL DEFAULT '{}'::text[],
    resolved_roles text[] NOT NULL DEFAULT '{}'::text[],
    invalid_roles text[] NOT NULL DEFAULT '{}'::text[],
    role_evidence_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    role_source_trails jsonb NOT NULL DEFAULT '{}'::jsonb,
    role_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    compatible_role_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
    recommended_action text NOT NULL CHECK (recommended_action IN ('canonicalize_role', 'split_identity', 'allow_multi_role', 'needs_review', 'retire_invalid_role')),
    resolution_status text NOT NULL CHECK (resolution_status IN ('resolved', 'allowed', 'needs_review')),
    target_role text,
    decision_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_role_conflict_projection_status
    ON entity_role_conflict_projection (namespace_id, resolution_status, updated_at DESC);
