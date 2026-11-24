-- A run of a check also keeps the check-in it posted and what the provider charged for it.
ALTER TABLE task_runs ADD COLUMN entry_id INTEGER;
ALTER TABLE task_runs ADD COLUMN cost_usd REAL;
