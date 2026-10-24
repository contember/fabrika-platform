-- One data operation Control drives on an application environment's object (ADR-0069): a maintenance transition, a
-- backup, a migration phase, a recovery or a restore. It is the authority over the object's maintenance state. Its
-- writes are fenced on the environment's `<app>:<env>` deploy lease, which holds the holder and the expiry, so the row
-- keeps neither. `generation` is the latest one the operation reserved; `error_code` is a code, never a message.
CREATE TABLE app_env_data_operations (
	id          TEXT PRIMARY KEY,
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,
	kind        TEXT NOT NULL CHECK (kind IN ('maintenance', 'backup', 'migrate', 'recovery', 'restore')),
	step        TEXT NOT NULL CHECK (step IN ('reconcile', 'restrict', 'backup', 'verify', 'deploy', 'migrate', 'resume', 'open')),
	target_mode TEXT NOT NULL CHECK (target_mode IN ('open', 'read-only', 'closed', 'inspect')),
	generation  INTEGER NOT NULL CHECK (generation > 0),
	state       TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
	error_code  TEXT,
	actor       TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	finished_at INTEGER
);
CREATE INDEX idx_app_env_data_operations_env ON app_env_data_operations(app_id, env, id);

-- The per-environment counter every maintenance generation is allocated from, never from the object's own database,
-- which a restore can rewind. No foreign key, and nothing deletes a row: a recreated environment must never reuse a
-- generation its object may still hold as published.
CREATE TABLE app_env_data_generations (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	generation INTEGER NOT NULL,
	PRIMARY KEY (app_id, env)
);
