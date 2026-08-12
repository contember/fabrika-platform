-- Before provider checkpoints existed, Zerops persisted the app-version id only after triggering
-- build+deploy. Preserve that exact historical meaning without guessing a destructive pre-trigger phase.
UPDATE runs
SET provider_state_json = json_object(
	'appVersionId', external_run_id,
	'phase', 'build_triggered'
)
WHERE external_run_id IS NOT NULL
	AND provider_state_json IS NULL
	AND status IN ('pending', 'running')
	AND EXISTS (
		SELECT 1
		FROM app_envs
		WHERE app_envs.app_id = runs.app_id
			AND app_envs.env = runs.env
			AND app_envs.provider = 'zerops'
	);
