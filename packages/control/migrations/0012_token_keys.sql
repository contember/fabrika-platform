-- The keys each application environment signs its tokens with (`token(Claims, { maxDays })` of a contract), sealed in
-- the vault under `platform:token-key:<app>@<env>:<key id>`. One key signs (`retired_at` NULL); a retired one keeps
-- verifying until `retired_at + max_days` days, `max_days` being the largest token lifetime the contract declared while
-- the key signed. `rotation_requested_at` asks the next deploy to retire the signing key and generate another.
CREATE TABLE app_env_token_keys (
	app_id                TEXT NOT NULL,
	env                   TEXT NOT NULL,
	key_id                TEXT NOT NULL,
	value_ref             TEXT NOT NULL,
	created_at            INTEGER NOT NULL,
	retired_at            INTEGER,
	max_days              INTEGER NOT NULL,
	rotation_requested_at INTEGER,
	PRIMARY KEY (app_id, env, key_id),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
