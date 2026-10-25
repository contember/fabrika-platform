-- The migration phase (ADR-0069 §3, ADR-0070 §8). A `migrate` data operation deploys one run of its environment, and
-- `run_id` names it, so a successor that resumes the operation at its `deploy` step reads how that run ended; NULL for
-- every other kind. A backup the phase takes before its deploy is marked `pre_migration`; a daily one is not.
ALTER TABLE app_env_data_operations ADD COLUMN run_id TEXT;
ALTER TABLE app_env_backups ADD COLUMN pre_migration INTEGER NOT NULL DEFAULT 0 CHECK (pre_migration IN (0, 1));
