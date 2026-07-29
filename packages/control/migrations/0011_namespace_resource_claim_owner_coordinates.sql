CREATE TABLE namespace_resource_claims_new (
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
	FOREIGN KEY (owner_app_id, owner_env)
		REFERENCES app_envs(app_id, env) ON DELETE RESTRICT
);

INSERT INTO namespace_resource_claims_new
SELECT namespace_id, resource_key, owner_app_id, owner_env, created_at
FROM namespace_resource_claims;

DROP TABLE namespace_resource_claims;
ALTER TABLE namespace_resource_claims_new RENAME TO namespace_resource_claims;

CREATE TRIGGER namespace_resource_claims_owner_immutable
BEFORE UPDATE OF owner_app_id, owner_env ON namespace_resource_claims
FOR EACH ROW
WHEN NOT (
	OLD.owner_app_id IS NEW.owner_app_id
	AND OLD.owner_env IS NEW.owner_env
)
BEGIN
	SELECT RAISE(ABORT, 'namespace resource claim owner is immutable');
END;

CREATE TRIGGER namespace_resource_claims_owner_namespace_match
BEFORE INSERT ON namespace_resource_claims
FOR EACH ROW
WHEN NEW.owner_app_id IS NOT NULL AND NOT EXISTS (
	SELECT 1
	FROM app_envs
	WHERE app_id = NEW.owner_app_id
		AND env = NEW.owner_env
		AND namespace_id = NEW.namespace_id
)
BEGIN
	SELECT RAISE(ABORT, 'namespace resource claim owner belongs to another namespace');
END;
