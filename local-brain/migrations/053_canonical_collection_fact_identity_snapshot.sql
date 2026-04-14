-- 053_canonical_collection_fact_identity_snapshot.sql

ALTER TABLE canonical_collection_facts
  ADD COLUMN IF NOT EXISTS subject_name_snapshot text,
  ADD COLUMN IF NOT EXISTS subject_name_normalized text;

UPDATE canonical_collection_facts ccf
SET
  subject_name_snapshot = COALESCE(ccf.subject_name_snapshot, e.canonical_name),
  subject_name_normalized = COALESCE(ccf.subject_name_normalized, e.normalized_name)
FROM entities e
WHERE e.id = ccf.subject_entity_id
  AND (
    ccf.subject_name_snapshot IS NULL OR ccf.subject_name_snapshot = ''
    OR ccf.subject_name_normalized IS NULL OR ccf.subject_name_normalized = ''
  );

CREATE INDEX IF NOT EXISTS idx_canonical_collection_facts_subject_name
  ON canonical_collection_facts (namespace_id, subject_name_normalized, cue_strength DESC, confidence DESC, updated_at DESC);
