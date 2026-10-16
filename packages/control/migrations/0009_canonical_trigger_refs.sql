-- A push names its ref in full (`refs/heads/deploy/prod`) and the webhook compares exactly, so a trigger ref stored as a
-- bare branch name (`deploy/prod`) deployed on no push. Registration now stores the full ref; this rewrites the rows
-- written before it. A row whose canonical form another environment of the app already holds stays as it is, because
-- `idx_app_envs_trigger` allows one; maintenance logs it until an operator puts one of the two environments again.
UPDATE app_envs
SET trigger_ref = 'refs/heads/' || trigger_ref
WHERE trigger_ref IS NOT NULL
	AND substr(trigger_ref, 1, 5) <> 'refs/'
	AND NOT EXISTS (
		SELECT 1 FROM app_envs AS holder
		WHERE holder.app_id = app_envs.app_id AND holder.trigger_ref = 'refs/heads/' || app_envs.trigger_ref
	);
