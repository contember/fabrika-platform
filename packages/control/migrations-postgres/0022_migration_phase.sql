-- The migration phase (ADR-0069 §3, ADR-0070 §8). A `migrate` data operation deploys one run of its environment, and
-- `run_id` names it, so a successor that resumes the operation at its `deploy` step reads how that run ended; NULL for
-- every other kind. A backup the phase takes before its deploy is marked `pre_migration`; a daily one is not.
ALTER TABLE app_env_data_operations ADD COLUMN run_id TEXT;
ALTER TABLE app_env_backups ADD COLUMN pre_migration INTEGER NOT NULL DEFAULT 0 CHECK (pre_migration IN (0, 1));
-- Whether the version a run deploys installs the ops channel: a domain, at a release the provider serves the channel at.
-- Only a succeeded run's value is evidence of what runs; NULL for a dry run and for every run before the column.
ALTER TABLE runs ADD COLUMN ops_channel INTEGER CHECK (ops_channel IN (0, 1));
