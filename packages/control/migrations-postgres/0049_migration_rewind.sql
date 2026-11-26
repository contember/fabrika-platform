-- The in-place rewind of a bookmark migration that committed and never booted (ADR-0069 §3, ADR-0070 §9). `rewind_record`
-- is the migration record the new version's 422 named, which every restore step names again. `prepare`'s bookmarks
-- (`rewind_current`, `rewind_target`) are recorded before anything is armed; `rewind_arms` counts each `arm` before it
-- is sent, and `rewind_undo` is the undo bookmark an answered `arm` returned. `rewind_outcome` is `rewound` once
-- `verify` found the sentinel gone, or `refused` with the object's reason in `rewind_refusal`. All NULL or 0 otherwise.
ALTER TABLE app_env_data_operations ADD COLUMN rewind_record TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_current TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_target TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_arms INTEGER NOT NULL DEFAULT 0 CHECK (rewind_arms >= 0);
ALTER TABLE app_env_data_operations ADD COLUMN rewind_undo TEXT;
ALTER TABLE app_env_data_operations ADD COLUMN rewind_outcome TEXT CHECK (rewind_outcome IN ('rewound', 'refused'));
ALTER TABLE app_env_data_operations ADD COLUMN rewind_refusal TEXT;
