-- Replace the closed Cloudflare/Zerops target columns with provider-owned JSON envelopes.

ALTER TABLE app_envs DROP CONSTRAINT app_envs_platform_check;
ALTER TABLE app_envs RENAME COLUMN platform TO provider;
ALTER TABLE app_envs ADD COLUMN provider_target_json TEXT;
ALTER TABLE app_envs ADD COLUMN provider_artifact_json TEXT;

UPDATE app_envs
SET
	provider_target_json = CASE provider
		WHEN 'zerops' THEN jsonb_build_object(
			'provider', 'zerops',
			'version', 1,
			'payload', jsonb_build_object(
				'projectId', zerops_project_id,
				'serviceId', zerops_service_id
			)
		)::TEXT
		ELSE jsonb_build_object(
			'provider', 'cloudflare',
			'version', 1,
			'payload', jsonb_build_object()
		)::TEXT
	END,
	provider_artifact_json = CASE provider
		WHEN 'zerops' THEN jsonb_build_object(
			'provider', 'zerops',
			'version', 1,
			'payload', COALESCE(manifest_json::jsonb, 'null'::jsonb)
		)::TEXT
		ELSE jsonb_build_object(
			'provider', 'cloudflare',
			'version', 1,
			'payload', jsonb_build_object(
				'configPath',
				COALESCE(
					(SELECT config_path FROM apps WHERE apps.id = app_envs.app_id),
					'fabrika.config.ts'
				)
			)
		)::TEXT
	END;

ALTER TABLE app_envs ALTER COLUMN provider_target_json SET NOT NULL;
ALTER TABLE app_envs ALTER COLUMN provider_artifact_json SET NOT NULL;
ALTER TABLE app_envs DROP COLUMN zerops_project_id;
ALTER TABLE app_envs DROP COLUMN zerops_service_id;
ALTER TABLE app_envs DROP COLUMN manifest_json;

ALTER TABLE runs RENAME COLUMN platform_run_id TO external_run_id;
