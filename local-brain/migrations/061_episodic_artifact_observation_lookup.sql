CREATE INDEX IF NOT EXISTS idx_episodic_memory_namespace_artifact_observation_time
  ON episodic_memory (namespace_id, artifact_observation_id, occurred_at ASC, id ASC)
  WHERE artifact_observation_id IS NOT NULL;
