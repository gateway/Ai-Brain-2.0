-- 020_alias_merge_and_identity_profiles.sql

ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS merged_into_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;

ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS identity_profile_id uuid;

CREATE INDEX IF NOT EXISTS idx_entities_namespace_merged
    ON entities (namespace_id, merged_into_entity_id);

CREATE TABLE IF NOT EXISTS identity_profiles (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    profile_type text NOT NULL DEFAULT 'self'
        CHECK (profile_type IN ('self')),
    canonical_name text NOT NULL,
    normalized_name text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_type, normalized_name)
);

CREATE TABLE IF NOT EXISTS namespace_self_bindings (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL UNIQUE,
    identity_profile_id uuid NOT NULL REFERENCES identity_profiles(id) ON DELETE CASCADE,
    entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    display_name text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_namespace_self_bindings_profile
    ON namespace_self_bindings (identity_profile_id, namespace_id);
