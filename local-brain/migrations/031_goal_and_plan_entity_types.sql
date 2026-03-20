-- 031_goal_and_plan_entity_types.sql

ALTER TABLE entities
    DROP CONSTRAINT IF EXISTS entities_entity_type_check;

ALTER TABLE entities
    ADD CONSTRAINT entities_entity_type_check
    CHECK (entity_type IN ('self', 'person', 'place', 'org', 'project', 'activity', 'media', 'skill', 'decision', 'constraint', 'routine', 'style_spec', 'goal', 'plan', 'concept', 'unknown'));
