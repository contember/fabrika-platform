-- The side restore (ADR-0070 §9). A `restore` data operation lists a clone, freezes and backs up the serving object,
-- imports the backup into the clone, moves ordinary traffic to it and rewinds the frozen original; its steps are added.
-- SQLite cannot change a CHECK, so `app_env_data_operations` is rebuilt. `app_env_backups` and `app_env_backup_parts`
-- reference it: their rows are kept aside and restored, so dropping the old table cascades into nothing. The rebuilt
-- table references itself by its own name, which the rename carries over, so dropping the old one cascades into none
-- of the rebuilt rows either.
CREATE TABLE app_env_backup_parts_kept AS SELECT * FROM app_env_backup_parts;
CREATE TABLE app_env_backups_kept AS SELECT * FROM app_env_backups;
DROP TABLE app_env_backup_parts;
DROP TABLE app_env_backups;

CREATE TABLE app_env_data_operations_rebuilt (
	id          TEXT PRIMARY KEY,
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,
	kind        TEXT NOT NULL CHECK (kind IN ('maintenance', 'backup', 'migrate', 'recovery', 'restore')),
	step        TEXT NOT NULL CHECK (step IN (
		'reconcile', 'restrict', 'backup', 'verify', 'deploy', 'migrate', 'resume', 'open',
		'list', 'import', 'promote', 'point', 'serve', 'rewind', 'check', 'revert'
	)),
	target_mode TEXT NOT NULL CHECK (target_mode IN ('open', 'read-only', 'closed', 'inspect')),
	generation  INTEGER NOT NULL CHECK (generation > 0),
	state       TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
	error_code  TEXT,
	actor       TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	finished_at INTEGER,
	recovers_operation_id TEXT,
	resolution  TEXT CHECK (resolution IN ('resume', 'open')),
	run_id      TEXT,
	UNIQUE (id, app_id, env),
	FOREIGN KEY (recovers_operation_id, app_id, env) REFERENCES app_env_data_operations_rebuilt(id, app_id, env) ON DELETE CASCADE,
	CHECK (
		(kind = 'recovery' AND recovers_operation_id IS NOT NULL AND recovers_operation_id <> id AND resolution IS NOT NULL)
		OR (kind <> 'recovery' AND recovers_operation_id IS NULL AND resolution IS NULL)
	)
);
INSERT INTO app_env_data_operations_rebuilt (
	id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at,
	recovers_operation_id, resolution, run_id
)
SELECT
	id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at,
	recovers_operation_id, resolution, run_id
FROM app_env_data_operations;
DROP TABLE app_env_data_operations;
ALTER TABLE app_env_data_operations_rebuilt RENAME TO app_env_data_operations;
CREATE INDEX idx_app_env_data_operations_env ON app_env_data_operations(app_id, env, id);

CREATE TABLE app_env_backups (
	id               TEXT PRIMARY KEY,
	app_id           TEXT NOT NULL,
	env              TEXT NOT NULL,
	operation_id     TEXT NOT NULL UNIQUE,
	object           TEXT NOT NULL,
	dump_id          TEXT NOT NULL UNIQUE,
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
	pre_migration    INTEGER NOT NULL DEFAULT 0 CHECK (pre_migration IN (0, 1)),
	FOREIGN KEY (operation_id, app_id, env) REFERENCES app_env_data_operations(id, app_id, env) ON DELETE CASCADE,
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
INSERT INTO app_env_backups (
	id, app_id, env, operation_id, object, dump_id, state, error_code, created_at, finished_at, bookmark,
	upload_id, size_bytes, parts, tables, rehearsal, rehearsal_code, rehearsal_step, rehearsal_parts, rehearsal_cursor, pre_migration
)
SELECT
	id, app_id, env, operation_id, object, dump_id, state, error_code, created_at, finished_at, bookmark,
	upload_id, size_bytes, parts, tables, rehearsal, rehearsal_code, rehearsal_step, rehearsal_parts, rehearsal_cursor, pre_migration
FROM app_env_backups_kept;
CREATE INDEX idx_app_env_backups_env ON app_env_backups(app_id, env, id);

CREATE TABLE app_env_backup_parts (
	backup_id TEXT NOT NULL REFERENCES app_env_backups(id) ON DELETE CASCADE,
	part      INTEGER NOT NULL CHECK (part > 0),
	ack       TEXT NOT NULL,
	deferred  INTEGER,
	linked    INTEGER NOT NULL CHECK (linked IN (0, 1)),
	PRIMARY KEY (backup_id, part)
);
INSERT INTO app_env_backup_parts (backup_id, part, ack, deferred, linked)
SELECT backup_id, part, ack, deferred, linked FROM app_env_backup_parts_kept;
DROP TABLE app_env_backup_parts_kept;
DROP TABLE app_env_backups_kept;

-- The pointer: the object that serves an environment's ordinary traffic and the objects its ops channel reaches, which
-- every deploy of a release that serves ops writes as `FABRIKA_APPLICATION_OBJECT` and `FABRIKA_APPLICATION_OBJECTS`.
-- No row means `application`, and `application,rehearsal`. `listed` holds names joined by `,`, the serving one among
-- them, at most 16. Only a restore moves it, under the environment's deploy lease. No foreign key, and nothing deletes a
-- row: the objects outlive the environment's registry row, so a recreated environment keeps serving the same one.
CREATE TABLE app_env_application_objects (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	serving    TEXT NOT NULL,
	listed     TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env)
);

-- One side restore's own record (ADR-0070 §9), beside its `restore` data operation: the target time `at` (ISO 8601),
-- the object it freezes and rewinds (`original`) and the clone it imports into, the run of each of its deploys, the
-- bookmarks `prepare` answered, which are persisted before anything is armed, the undo bookmark an `arm` answered, how
-- many `arm`s it sent, and the code it fails with once the original is open again. Bookmarks are opaque tokens; the
-- record holds no row content.
CREATE TABLE app_env_restores (
	operation_id     TEXT PRIMARY KEY,
	app_id           TEXT NOT NULL,
	env              TEXT NOT NULL,
	at               TEXT NOT NULL,
	original         TEXT NOT NULL,
	clone            TEXT NOT NULL,
	list_run_id      TEXT,
	point_run_id     TEXT,
	revert_run_id    TEXT,
	current_bookmark TEXT,
	target_bookmark  TEXT,
	undo_bookmark    TEXT,
	arms             INTEGER NOT NULL DEFAULT 0,
	failure          TEXT,
	created_at       INTEGER NOT NULL,
	FOREIGN KEY (operation_id, app_id, env) REFERENCES app_env_data_operations(id, app_id, env) ON DELETE CASCADE
);
