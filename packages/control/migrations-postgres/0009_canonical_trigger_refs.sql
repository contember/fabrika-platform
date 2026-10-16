-- Postgres twin of ../migrations/0009_canonical_trigger_refs.sql — see that file for the model; the outcome is identical.
UPDATE app_envs
SET trigger_ref = 'refs/heads/' || trigger_ref
WHERE trigger_ref IS NOT NULL
	AND substr(trigger_ref, 1, 5) <> 'refs/'
	AND NOT EXISTS (
		SELECT 1 FROM app_envs AS holder
		WHERE holder.app_id = app_envs.app_id AND holder.trigger_ref = 'refs/heads/' || app_envs.trigger_ref
	);
