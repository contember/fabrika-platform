-- The side restore (ADR-0070 §9). A `restore` data operation lists a clone, freezes and backs up the serving object,
-- imports the backup into the clone, moves ordinary traffic to it and rewinds the frozen original; its steps are added.
ALTER TABLE app_env_data_operations DROP CONSTRAINT app_env_data_operations_step_check;
ALTER TABLE app_env_data_operations ADD CONSTRAINT app_env_data_operations_step_check CHECK (step IN (
	'reconcile', 'restrict', 'backup', 'verify', 'deploy', 'migrate', 'resume', 'open',
	'list', 'import', 'promote', 'point', 'serve', 'rewind', 'check', 'revert'
));

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
