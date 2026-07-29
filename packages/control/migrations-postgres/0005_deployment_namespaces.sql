-- Provider-owned deployment placement, shared by one or more app environments.
-- Legacy Zerops targets remain v1 until lifecycle consumers move to namespace targets together.

CREATE TABLE namespace_migration_guard (
	ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Invalid JSON is rejected by the jsonb cast. Valid envelopes must carry lossless v1 coordinates.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1 FROM app_envs
	WHERE provider = 'zerops' AND (
		(provider_target_json::jsonb->>'provider') IS DISTINCT FROM 'zerops'
		OR jsonb_typeof(provider_target_json::jsonb->'version') IS DISTINCT FROM 'number'
		OR (provider_target_json::jsonb->>'version')::INTEGER IS DISTINCT FROM 1
		OR jsonb_typeof(provider_target_json::jsonb->'payload'->'projectId') IS DISTINCT FROM 'string'
		OR provider_target_json::jsonb->'payload'->>'projectId' = ''
		OR jsonb_typeof(provider_target_json::jsonb->'payload'->'serviceId') IS DISTINCT FROM 'string'
		OR provider_target_json::jsonb->'payload'->>'serviceId' = ''
	)
) THEN 0 ELSE 1 END;

-- One provider placement cannot span logical environments.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT provider_target_json::jsonb->'payload'->>'projectId'
	FROM app_envs
	WHERE provider = 'zerops'
	GROUP BY provider_target_json::jsonb->'payload'->>'projectId'
	HAVING COUNT(DISTINCT env) > 1
) THEN 0 ELSE 1 END;

-- Two app environments cannot both own the same deploy service.
INSERT INTO namespace_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT
		provider_target_json::jsonb->'payload'->>'projectId',
		provider_target_json::jsonb->'payload'->>'serviceId'
	FROM app_envs
	WHERE provider = 'zerops'
	GROUP BY
		provider_target_json::jsonb->'payload'->>'projectId',
		provider_target_json::jsonb->'payload'->>'serviceId'
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
	created_at           INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	UNIQUE (id, provider, env)
);

INSERT INTO deployment_namespaces (
	id, env, provider, exclusive_app_id, provider_target_json, state
)
SELECT
	'zerops-project-' || (provider_target_json::jsonb->'payload'->>'projectId'),
	MIN(env),
	'zerops',
	NULL,
	jsonb_build_object(
		'provider', 'zerops',
		'version', 1,
		'payload', jsonb_build_object(
			'projectId', provider_target_json::jsonb->'payload'->>'projectId'
		)
	)::TEXT,
	'pending'
FROM app_envs
WHERE provider = 'zerops'
GROUP BY provider_target_json::jsonb->'payload'->>'projectId';

ALTER TABLE app_envs ADD COLUMN namespace_id TEXT;
UPDATE app_envs
SET namespace_id = 'zerops-project-' || (provider_target_json::jsonb->'payload'->>'projectId')
WHERE provider = 'zerops';
ALTER TABLE app_envs ADD CONSTRAINT app_envs_namespace_owner_unique UNIQUE (namespace_id, app_id, env);
ALTER TABLE app_envs ADD CONSTRAINT app_envs_namespace_coordinates_fk
	FOREIGN KEY (namespace_id, provider, env)
	REFERENCES deployment_namespaces(id, provider, env) ON DELETE RESTRICT;

CREATE TABLE namespace_resource_claims (
	namespace_id TEXT NOT NULL REFERENCES deployment_namespaces(id) ON DELETE RESTRICT,
	resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
	owner_app_id TEXT,
	owner_env     TEXT,
	created_at   INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	PRIMARY KEY (namespace_id, resource_key),
	CHECK (
		(owner_app_id IS NULL AND owner_env IS NULL)
		OR (owner_app_id IS NOT NULL AND owner_env IS NOT NULL)
	),
	FOREIGN KEY (namespace_id, owner_app_id, owner_env)
		REFERENCES app_envs(namespace_id, app_id, env) ON DELETE RESTRICT
);
