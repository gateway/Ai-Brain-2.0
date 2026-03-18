-- 017_narrative_quality_and_project_claims.sql

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS prior_score double precision NOT NULL DEFAULT 0.5;

ALTER TABLE claim_candidates
    ADD COLUMN IF NOT EXISTS prior_reason text;

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS prior_score double precision NOT NULL DEFAULT 0.5;

ALTER TABLE relationship_candidates
    ADD COLUMN IF NOT EXISTS prior_reason text;

CREATE INDEX IF NOT EXISTS idx_claim_candidates_namespace_prior
    ON claim_candidates (namespace_id, status, prior_score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_candidates_namespace_prior
    ON relationship_candidates (namespace_id, status, prior_score DESC, created_at DESC);
