-- Provider-owned deployment placement, shared by one or more app environments.
-- Legacy Zerops targets remain v1 until lifecycle consumers move to namespace targets together.

CREATE TABLE namespace_migration_guard (
	ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Validate JSON before later statements call json_extract().
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1 FROM app_envs
	WHERE provider = 'zerops' AND json_valid(provider_target_json) = 0
) THEN 0 ELSE 1 END;

-- Existing Zerops rows must have the exact coordinates needed for a lossless grouping.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1 FROM app_envs
	WHERE provider = 'zerops' AND (
		json_extract(provider_target_json, '$.provider') IS NOT 'zerops'
		OR json_type(provider_target_json, '$.version') IS NOT 'integer'
		OR json_extract(provider_target_json, '$.version') IS NOT 1
		OR json_type(provider_target_json, '$.payload.projectId') IS NOT 'text'
		OR json_extract(provider_target_json, '$.payload.projectId') = ''
		OR json_type(provider_target_json, '$.payload.serviceId') IS NOT 'text'
		OR json_extract(provider_target_json, '$.payload.serviceId') = ''
	)
) THEN 0 ELSE 1 END;

-- One provider placement cannot span logical environments.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT json_extract(provider_target_json, '$.payload.projectId')
	FROM app_envs
	WHERE provider = 'zerops'
	GROUP BY json_extract(provider_target_json, '$.payload.projectId')
	HAVING COUNT(DISTINCT env) > 1
) THEN 0 ELSE 1 END;

-- Two app environments cannot both own the same deploy service.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT
		json_extract(provider_target_json, '$.payload.projectId'),
		json_extract(provider_target_json, '$.payload.serviceId')
	FROM app_envs
	WHERE provider = 'zerops'
	GROUP BY
		json_extract(provider_target_json, '$.payload.projectId'),
		json_extract(provider_target_json, '$.payload.serviceId')
	HAVING COUNT(*) > 1
) THEN 0 ELSE 1 END;

DROP TABLE namespace_migration_guard;

CREATE TABLE deployment_namespaces (
	id                   TEXT PRIMARY KEY,
	env                  TEXT NOT NULL,
	provider             TEXT NOT NULL,
	exclusive_app_id     TEXT REFERENCES apps(id) ON DELETE RESTRICT,
	provider_target_json TEXT NOT NULL,
	state                TEXT NOT NULL CHECK (state IN ('pending','provisioning','ready','failed')),
	last_error           TEXT,
	created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
	UNIQUE (id, provider, env)
);

INSERT INTO deployment_namespaces (
	id, env, provider, exclusive_app_id, provider_target_json, state
)
SELECT
	'zerops-project-' || json_extract(provider_target_json, '$.payload.projectId'),
	MIN(env),
	'zerops',
	NULL,
	json_object(
		'provider', 'zerops',
		'version', 1,
		'payload', json_object(
			'projectId', json_extract(provider_target_json, '$.payload.projectId')
		)
	),
	'pending'
FROM app_envs
WHERE provider = 'zerops'
GROUP BY json_extract(provider_target_json, '$.payload.projectId');

CREATE TABLE app_envs_new (
	app_id                 TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                    TEXT NOT NULL,
	domain                 TEXT,
	trigger_ref            TEXT,
	namespace_id           TEXT,
	provider               TEXT NOT NULL,
	provider_target_json   TEXT NOT NULL,
	provider_artifact_json TEXT NOT NULL,
	created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (app_id, env),
	UNIQUE (namespace_id, app_id, env),
	FOREIGN KEY (namespace_id, provider, env)
		REFERENCES deployment_namespaces(id, provider, env) ON DELETE RESTRICT
);

INSERT INTO app_envs_new (
	app_id, env, domain, trigger_ref, namespace_id, provider,
	provider_target_json, provider_artifact_json, created_at
)
SELECT
	app_id,
	env,
	domain,
	trigger_ref,
	CASE provider
		WHEN 'zerops' THEN 'zerops-project-' || json_extract(provider_target_json, '$.payload.projectId')
		ELSE NULL
	END,
	provider,
	provider_target_json,
	provider_artifact_json,
	created_at
FROM app_envs;

DROP TABLE app_envs;
ALTER TABLE app_envs_new RENAME TO app_envs;

CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

CREATE TABLE namespace_resource_claims (
	namespace_id TEXT NOT NULL REFERENCES deployment_namespaces(id) ON DELETE RESTRICT,
	resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
	owner_app_id TEXT,
	owner_env     TEXT,
	created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (namespace_id, resource_key),
	CHECK (
		(owner_app_id IS NULL AND owner_env IS NULL)
		OR (owner_app_id IS NOT NULL AND owner_env IS NOT NULL)
	),
	FOREIGN KEY (namespace_id, owner_app_id, owner_env)
		REFERENCES app_envs(namespace_id, app_id, env) ON DELETE RESTRICT
);
