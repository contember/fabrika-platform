-- The in-place rewind of a bookmark migration that committed and never booted (ADR-0069 §3, ADR-0070 §9). `rewind_record`
-- is the migration record the new version's 422 named, which every restore step names again. `prepare`'s bookmarks
-- (`rewind_current`, `rewind_target`) are recorded before anything is armed; `rewind_arms` counts each `arm` before it
-- is sent, and `rewind_undo` is the undo bookmark an answered `arm` returned. `rewind_verified` is how many of those arms
-- a `verify` answered `present` after a transition proved their reset, so an arm counted beyond it is outstanding and
-- nothing opens the object until it is resolved. `rewind_outcome` is `rewound` once `verify` found the sentinel gone,
-- or `refused` with the object's reason in `rewind_refusal`. All NULL or 0 otherwise.
ALTER TABLE app_env_data_operations ADD COLUMN rewind_record TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_current TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_target TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_arms INTEGER NOT NULL DEFAULT 0 CHECK (rewind_arms >= 0);
ALTER TABLE app_env_data_operations ADD COLUMN rewind_undo TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_verified INTEGER NOT NULL DEFAULT 0 CHECK (rewind_verified >= 0);
ALTER TABLE app_env_data_operations ADD COLUMN rewind_outcome TEXT CHECK (rewind_outcome IN ('rewound', 'refused'));
ALTER TABLE app_env_data_operations ADD COLUMN rewind_refusal TEXT;
-- A recovery that rolls back and opens: a fresh rollback deploy of a failed bookmark migration, the wait after it in
-- `inspect`, then the open. Its `resolution` is `open` with `recovery_rollback` = 1, since SQLite cannot widen the
-- resolution's CHECK without rebuilding the table; it records its rollback run in `revert_run_id` and the wait's end in
-- `deadline_at`. 0 for every other operation.
ALTER TABLE app_env_data_operations ADD COLUMN recovery_rollback INTEGER NOT NULL DEFAULT 0 CHECK (recovery_rollback IN (0, 1));
