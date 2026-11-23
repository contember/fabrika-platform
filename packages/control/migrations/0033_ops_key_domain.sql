-- The domain a provider accepted a deploy to that handed an ops key: Control presents the key only there, never to the
-- domain the registry names now, and a key whose deploy no provider accepted yet goes nowhere. A key recorded before
-- this column takes the environment's domain at the upgrade, if a provider accepted the run that handed it.
ALTER TABLE app_env_ops_keys ADD COLUMN domain TEXT;
UPDATE app_env_ops_keys SET domain = (
	SELECT NULLIF(e.domain, '') FROM app_envs e WHERE e.app_id = app_env_ops_keys.app_id AND e.env = app_env_ops_keys.env
)
WHERE EXISTS (
	SELECT 1 FROM runs r
	WHERE r.id = app_env_ops_keys.handed_by AND (r.status = 'succeeded' OR r.external_run_id IS NOT NULL)
);
