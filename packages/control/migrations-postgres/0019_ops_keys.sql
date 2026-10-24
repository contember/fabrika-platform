-- The ops keys Control calls an application environment's object with (ADR-0069), sealed in the vault under
-- `platform:ops-key:<app>@<env>:<key id>`; the object holds only their `digest`s. `handed_by` is the newest run that
-- handed the key to a deploy while no running version accepted it: once that run succeeded, the running version does.
-- At most two rows: the key the running version accepts and, during a rotation, the newer key handed beside it.
CREATE TABLE app_env_ops_keys (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	key_id     TEXT NOT NULL,
	value_ref  TEXT NOT NULL,
	digest     TEXT NOT NULL,
	handed_by  TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, key_id),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
