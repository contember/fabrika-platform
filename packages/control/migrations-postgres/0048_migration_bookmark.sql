-- The migrating deploy without a read-only window (ADR-0069 §3). A `migrate` operation whose candidate records the
-- migration bookmark restricts nothing and takes no backup (`records_bookmark` = 1); one before it keeps the read-only
-- phase (0). `data_loss` = 1 when the candidate brings a migration with a `dataLoss` statement, which no rollback deploy
-- may run under once it committed. `deadline_at` (unix seconds) bounds the wait at `migrate` and `check` for the new
-- version's answer: `max_delay` plus a margin. `migration_failure` is the reason the new version's 422 named, which
-- decides the recovery. `revert_run_id` names the rollback deploy of the last succeeded commit, written once before it
-- is created, so a successor reads how it ended. `deployed` = 1 once the provider deployed the operation's run, which
-- stays running until the migration ends. `candidate_version` is the Worker version that answered the 422, and
-- `candidate_recovered` = 1 when that version answered `ok` while the rollback deployed. All NULL or 0 otherwise.
ALTER TABLE app_env_data_operations ADD COLUMN records_bookmark INTEGER NOT NULL DEFAULT 0 CHECK (records_bookmark IN (0, 1));
ALTER TABLE app_env_data_operations ADD COLUMN data_loss INTEGER NOT NULL DEFAULT 0 CHECK (data_loss IN (0, 1));
ALTER TABLE app_env_data_operations ADD COLUMN deadline_at INTEGER;
ALTER TABLE app_env_data_operations ADD COLUMN revert_run_id TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN migration_failure TEXT CHECK (migration_failure IN ('rolled_back', 'committed', 'record_unwritable'));
ALTER TABLE app_env_data_operations ADD COLUMN deployed INTEGER NOT NULL DEFAULT 0 CHECK (deployed IN (0, 1));
ALTER TABLE app_env_data_operations ADD COLUMN candidate_version TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN candidate_recovered INTEGER NOT NULL DEFAULT 0 CHECK (candidate_recovered IN (0, 1));
