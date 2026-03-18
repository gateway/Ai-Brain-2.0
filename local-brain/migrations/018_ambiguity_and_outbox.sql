-- 018_ambiguity_and_outbox.sql

ALTER TABLE entity_aliases
    ADD COLUMN IF NOT EXISTS is_user_verified boolean NOT NULL DEFAULT false;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS ambiguity_state text NOT NULL DEFAULT 'none'
        CHECK (ambiguity_state IN ('none', 'requires_clarification', 'resolved', 'ignored'));

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS ambiguity_type text
        CHECK (ambiguity_type IN ('possible_misspelling', 'undefined_kinship', 'vague_place', 'alias_collision', 'unknown_reference'));

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS ambiguity_reason text;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS resolved_from_candidate_id uuid REFERENCES claim_candidates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_claim_candidates_namespace_ambiguity
    ON claim_candidates (namespace_id, ambiguity_state, ambiguity_type, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_outbox_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_id text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid,
    event_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
    retry_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    processed_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_outbox_events_idempotency
    ON brain_outbox_events (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_outbox_events_status
    ON brain_outbox_events (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_brain_outbox_events_namespace
    ON brain_outbox_events (namespace_id, status, created_at DESC);
