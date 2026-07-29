-- Project and proxy coordinates belong only to deployment namespaces. App targets retain their
-- deploy service id. This migration intentionally rejects v1/namespace drift instead of guessing.

CREATE TABLE zerops_namespace_target_migration_guard (
	ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Invalid JSON is rejected by the jsonb cast. Every app must have a matching namespace row.
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs e
	LEFT JOIN deployment_namespaces n ON n.id = e.namespace_id
	WHERE e.provider = 'zerops' AND n.id IS NULL
) THEN 0 ELSE 1 END;

-- Every app target must carry the v1 coordinates needed for a lossless rewrite.
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs
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

-- Namespace ownership and project coordinates must agree before projectId is removed from apps.
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs e
	JOIN deployment_namespaces n ON n.id = e.namespace_id
	WHERE e.provider = 'zerops' AND (
		n.provider IS DISTINCT FROM 'zerops'
		OR n.env IS DISTINCT FROM e.env
		OR (n.provider_target_json::jsonb->>'provider') IS DISTINCT FROM 'zerops'
		OR jsonb_typeof(n.provider_target_json::jsonb->'version') IS DISTINCT FROM 'number'
		OR (n.provider_target_json::jsonb->>'version')::INTEGER IS DISTINCT FROM 1
		OR jsonb_typeof(n.provider_target_json::jsonb->'payload'->'projectId') IS DISTINCT FROM 'string'
		OR n.provider_target_json::jsonb->'payload'->>'projectId' = ''
		OR (n.provider_target_json::jsonb->'payload'->>'projectId')
			IS DISTINCT FROM (e.provider_target_json::jsonb->'payload'->>'projectId')
	)
) THEN 0 ELSE 1 END;

DROP TABLE zerops_namespace_target_migration_guard;

UPDATE app_envs
SET provider_target_json = jsonb_build_object(
	'provider', 'zerops',
	'version', 2,
	'payload', jsonb_build_object(
		'serviceId', provider_target_json::jsonb->'payload'->>'serviceId'
	)
)::TEXT
WHERE provider = 'zerops';
