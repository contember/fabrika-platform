-- The Sentry DSN/public key is client-visible write configuration, not a server secret.
-- Keep it out of app_vars so operators cannot edit or delete platform-managed coordinates.
CREATE TABLE operations_ingest_configs (
	app_id              TEXT NOT NULL,
	env                 TEXT NOT NULL,
	service_key         TEXT NOT NULL,
	credential_id       TEXT NOT NULL UNIQUE,
	public_key          TEXT NOT NULL,
	ingest_project_id   TEXT,
	dsn                 TEXT,
	activated_revision  INTEGER,
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, service_key),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
