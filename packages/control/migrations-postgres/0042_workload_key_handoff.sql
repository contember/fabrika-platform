-- Whether the running version of an environment holds a workload key's recorded value. A key Control issued but no
-- succeeded deploy or secret write has handed yet is `pending = 1`; the maintenance pass writes it to the application
-- without a deploy (or confirms it from `handed_by`, the newest run that handed it while pending) and clears the flag.
-- `held_expires_at` (unix seconds) is when the key the running version still holds expires, while the row is pending
-- after a rotation; null when that key is the recorded one, or when no earlier key existed. Rows before the columns were
-- handed by the deploy that recorded them.
ALTER TABLE app_env_workload_credentials ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_env_workload_credentials ADD COLUMN handed_by TEXT;
ALTER TABLE app_env_workload_credentials ADD COLUMN held_expires_at INTEGER;
