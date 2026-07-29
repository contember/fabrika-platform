-- Replace the closed Cloudflare/Zerops target columns with provider-owned JSON envelopes.
-- SQLite rebuilds app_envs so the old platform CHECK cannot reject future provider ids.

CREATE TABLE app_envs_new (
	app_id                 TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                    TEXT NOT NULL,
	domain                 TEXT,
	trigger_ref            TEXT,
	provider               TEXT NOT NULL,
	provider_target_json   TEXT NOT NULL,
	provider_artifact_json TEXT NOT NULL,
	created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (app_id, env)
);

INSERT INTO app_envs_new (
	app_id, env, domain, trigger_ref, provider,
	provider_target_json, provider_artifact_json, created_at
)
SELECT
	app_id,
	env,
	domain,
	trigger_ref,
	platform,
	CASE platform
		WHEN 'zerops' THEN json_object(
			'provider', 'zerops',
			'version', 1,
			'payload', json_object(
				'projectId', zerops_project_id,
				'serviceId', zerops_service_id
			)
		)
		ELSE json_object(
			'provider', 'cloudflare',
			'version', 1,
			'payload', json_object()
		)
	END,
	CASE platform
		WHEN 'zerops' THEN json_object(
			'provider', 'zerops',
			'version', 1,
			'payload', json(COALESCE(manifest_json, 'null'))
		)
		ELSE json_object(
			'provider', 'cloudflare',
			'version', 1,
			'payload', json_object(
				'configPath',
				COALESCE(
					(SELECT config_path FROM apps WHERE apps.id = app_envs.app_id),
					'fabrika.config.ts'
				)
			)
		)
	END,
	created_at
FROM app_envs;

DROP TABLE app_envs;
ALTER TABLE app_envs_new RENAME TO app_envs;

CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

ALTER TABLE runs RENAME COLUMN platform_run_id TO external_run_id;
