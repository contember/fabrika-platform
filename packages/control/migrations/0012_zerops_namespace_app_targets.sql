-- Project and proxy coordinates belong only to deployment namespaces. App targets retain their
-- deploy service id. This migration intentionally rejects v1/namespace drift instead of guessing.

CREATE TABLE zerops_namespace_target_migration_guard (
	ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Validate JSON before later statements call json_extract().
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs e
	LEFT JOIN deployment_namespaces n ON n.id = e.namespace_id
	WHERE e.provider = 'zerops' AND (
		json_valid(e.provider_target_json) = 0
		OR n.id IS NULL
		OR json_valid(n.provider_target_json) = 0
	)
) THEN 0 ELSE 1 END;

-- Every app target must carry the v1 coordinates needed for a lossless rewrite.
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs
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

-- Namespace ownership and project coordinates must agree before projectId is removed from apps.
INSERT INTO zerops_namespace_target_migration_guard (ok)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM app_envs e
	JOIN deployment_namespaces n ON n.id = e.namespace_id
	WHERE e.provider = 'zerops' AND (
		n.provider IS NOT 'zerops'
		OR n.env IS NOT e.env
		OR json_extract(n.provider_target_json, '$.provider') IS NOT 'zerops'
		OR json_type(n.provider_target_json, '$.version') IS NOT 'integer'
		OR json_extract(n.provider_target_json, '$.version') IS NOT 1
		OR json_type(n.provider_target_json, '$.payload.projectId') IS NOT 'text'
		OR json_extract(n.provider_target_json, '$.payload.projectId') = ''
		OR json_extract(n.provider_target_json, '$.payload.projectId')
			IS NOT json_extract(e.provider_target_json, '$.payload.projectId')
	)
) THEN 0 ELSE 1 END;

DROP TABLE zerops_namespace_target_migration_guard;

UPDATE app_envs
SET provider_target_json = json_object(
	'provider', 'zerops',
	'version', 2,
	'payload', json_object(
		'serviceId', json_extract(provider_target_json, '$.payload.serviceId')
	)
)
WHERE provider = 'zerops';
