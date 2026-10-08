-- The vault ref of each application environment's proxy secret (ADR-0022 rule 5). Control generates the secret once,
-- the first time it publishes the environment's namespace proxy, and seals it in the vault under
-- `platform:proxy-secret:<app>@<env>`; this row is the only pointer to that vault entry.
CREATE TABLE app_env_proxy_secrets (
	app_id    TEXT NOT NULL,
	env       TEXT NOT NULL,
	value_ref TEXT NOT NULL,
	PRIMARY KEY (app_id, env),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
