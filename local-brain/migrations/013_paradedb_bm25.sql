-- 013_paradedb_bm25.sql
-- Feature-gated lexical upgrade path. Native PostgreSQL FTS remains in place as the safe fallback.

CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE INDEX IF NOT EXISTS idx_procedural_memory_search_bm25
    ON procedural_memory
    USING bm25 (id, namespace_id, state_type, state_key, state_value, updated_at)
    WITH (key_field = 'id');

CREATE INDEX IF NOT EXISTS idx_semantic_memory_search_bm25
    ON semantic_memory
    USING bm25 (id, namespace_id, content_abstract, canonical_key, memory_kind, valid_from)
    WITH (key_field = 'id')
    WHERE valid_until IS NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_candidates_search_bm25
    ON memory_candidates
    USING bm25 (id, namespace_id, candidate_type, content, canonical_key, created_at)
    WITH (key_field = 'id')
    WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS idx_episodic_memory_search_bm25
    ON episodic_memory
    USING bm25 (id, namespace_id, role, content, occurred_at)
    WITH (key_field = 'id');

CREATE INDEX IF NOT EXISTS idx_artifact_derivations_search_bm25
    ON artifact_derivations
    USING bm25 (id, derivation_type, provider, model, content_text, created_at)
    WITH (key_field = 'id')
    WHERE content_text IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_temporal_nodes_search_bm25
    ON temporal_nodes
    USING bm25 (id, namespace_id, layer, summary_text, period_start, period_end)
    WITH (key_field = 'id')
    WHERE summary_text <> '';
