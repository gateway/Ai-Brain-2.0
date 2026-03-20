ALTER TABLE ops.worker_runs
    DROP CONSTRAINT IF EXISTS worker_runs_worker_key_check;

ALTER TABLE ops.worker_runs
    ADD CONSTRAINT worker_runs_worker_key_check
    CHECK (worker_key IN ('source_monitor', 'derivation', 'outbox', 'temporal_summary'));
