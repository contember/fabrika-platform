-- A consuming application's connector key (ADR-0022 "Principal kinds") is recorded beside its job and webhook keys: one
-- row of kind `app` per owner application its approved contract imports from, `name` being the owner's id. IAM issued
-- it at `<owner>@<env>`, naming this application. SQLite cannot change a CHECK, so the table is rebuilt; nothing
-- references it.
CREATE TABLE app_env_workload_credentials_next (
	app_id        TEXT NOT NULL,
	env           TEXT NOT NULL,
	kind          TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'app')),
	name          TEXT NOT NULL,
	value_ref     TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	expires_at    INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, kind, name),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
INSERT INTO app_env_workload_credentials_next (app_id, env, kind, name, value_ref, credential_id, expires_at)
	SELECT app_id, env, kind, name, value_ref, credential_id, expires_at FROM app_env_workload_credentials;
DROP TABLE app_env_workload_credentials;
ALTER TABLE app_env_workload_credentials_next RENAME TO app_env_workload_credentials;
