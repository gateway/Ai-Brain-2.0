-- 070_task_lifecycle_statuses.sql

ALTER TABLE task_items
  DROP CONSTRAINT IF EXISTS task_items_status_check;

ALTER TABLE task_items
  ADD CONSTRAINT task_items_status_check
  CHECK (status IN ('open', 'blocked', 'completed', 'canceled', 'superseded', 'archived'));
