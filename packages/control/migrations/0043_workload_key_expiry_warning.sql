-- When Control last warned the application's Operations that the key the running version holds is about to expire
-- (unix seconds); null when it has not, and again for every newly recorded key. It spaces the warnings a day apart.
ALTER TABLE app_env_workload_credentials ADD COLUMN expiry_warned_at INTEGER;
