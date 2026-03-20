-- 025_entity_hierarchy.sql

ALTER TABLE entities
    ADD COLUMN IF NOT EXISTS parent_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;

ALTER TABLE entities
    DROP CONSTRAINT IF EXISTS entities_parent_self_check;

ALTER TABLE entities
    ADD CONSTRAINT entities_parent_self_check
    CHECK (parent_entity_id IS NULL OR parent_entity_id <> id);

CREATE INDEX IF NOT EXISTS idx_entities_parent
    ON entities (parent_entity_id);
