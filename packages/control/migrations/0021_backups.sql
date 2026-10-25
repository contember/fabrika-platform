-- One consistent backup of an application environment's object (ADR-0070), taken by the `backup` data operation that
-- names it, at most one per operation. `id` is the dump id, a UUIDv7 Control generates, which keys the dump in the
-- environment's bucket. The row keeps the progress a successor resumes from: the upload id and the bookmark from the
-- export's `begin`, every part in `app_env_backup_parts`, and the rehearsal's step, part count and last verify answer.
-- `size_bytes`, `parts` and `tables` are set once the upload completed. `state` turns `succeeded` only once the rehearsal
-- passed. Codes only, never a message, a value or a row's content.
CREATE TABLE app_env_backups (
	id               TEXT PRIMARY KEY,
	app_id           TEXT NOT NULL,
	env              TEXT NOT NULL,
	operation_id     TEXT NOT NULL UNIQUE,
	object           TEXT NOT NULL,
	state            TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
	error_code       TEXT,
	created_at       INTEGER NOT NULL,
	finished_at      INTEGER,
	bookmark         TEXT,
	upload_id        TEXT,
	size_bytes       INTEGER,
	parts            INTEGER,
	tables           INTEGER,
	rehearsal        TEXT NOT NULL CHECK (rehearsal IN ('pending', 'passed', 'failed')),
	rehearsal_code   TEXT,
	rehearsal_step   TEXT CHECK (rehearsal_step IN ('part', 'link', 'verify', 'discard')),
	rehearsal_parts  INTEGER,
	rehearsal_cursor TEXT,
	FOREIGN KEY (operation_id, app_id, env) REFERENCES app_env_data_operations(id, app_id, env) ON DELETE CASCADE
);
CREATE INDEX idx_app_env_backups_env ON app_env_backups(app_id, env, id);

-- One uploaded part of a backup's data: `ack` is the export's part answer as the object gave it (the part's size,
-- SHA-256 and ETag, the tables it finished with their counts and hashes, and the next cursor), read again with the
-- wire's parser. The rehearsal records `deferred` once it loaded the part, and `linked` once it set its deferred keys.
CREATE TABLE app_env_backup_parts (
	backup_id TEXT NOT NULL REFERENCES app_env_backups(id) ON DELETE CASCADE,
	part      INTEGER NOT NULL CHECK (part > 0),
	ack       TEXT NOT NULL,
	deferred  INTEGER,
	linked    INTEGER NOT NULL CHECK (linked IN (0, 1)),
	PRIMARY KEY (backup_id, part)
);

-- An environment's daily backup choice (ADR-0070 §8): no row means the default, daily backups on. Opting out stops the
-- daily backup only. `actor` is an opaque principal id.
CREATE TABLE app_env_backup_schedules (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	daily      INTEGER NOT NULL CHECK (daily IN (0, 1)),
	actor      TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
