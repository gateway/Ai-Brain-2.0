ALTER TABLE ops.ingestion_sessions
  ADD COLUMN IF NOT EXISTS default_llm_provider text
    CHECK (default_llm_provider IN ('external', 'openrouter', 'gemini'));

ALTER TABLE ops.ingestion_sessions
  ADD COLUMN IF NOT EXISTS default_embedding_provider text
    CHECK (default_embedding_provider IN ('external', 'openrouter', 'gemini'));

ALTER TABLE ops.session_model_runs
  ADD COLUMN IF NOT EXISTS provider_id text
    CHECK (provider_id IN ('external', 'openrouter', 'gemini'));
