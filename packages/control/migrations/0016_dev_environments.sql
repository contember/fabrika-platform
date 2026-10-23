-- An environment of kind `dev` follows the workspace bound to it through its launcher, without a run; at most one per
-- application, never protected (ADR-0049, ADR-0050).
ALTER TABLE app_envs ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'dev'));
CREATE UNIQUE INDEX idx_app_envs_dev ON app_envs (app_id) WHERE kind = 'dev';

-- What a dev environment follows and what its launcher last reported: metadata only, never a file's content.
-- target_sha is the head it should serve, head_sha what it holds, refused_sha a head that needs a bootstrap run.
-- The generations advance on reset_dev and run_checks; the launcher compares them with what it applied, and reports the
-- reset generation it applied as reset_applied.
CREATE TABLE dev_environments (
	app_id             TEXT NOT NULL,
	env                TEXT NOT NULL,
	workspace_id       TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
	bootstrap_run_id   TEXT,
	target_sha         TEXT,
	head_sha           TEXT,
	refused_sha        TEXT,
	status             TEXT NOT NULL DEFAULT 'unbound',
	message            TEXT,
	log_json           TEXT NOT NULL DEFAULT '[]',
	checks_json        TEXT,
	reset_generation   INTEGER NOT NULL DEFAULT 0,
	checks_generation  INTEGER NOT NULL DEFAULT 0,
	reset_applied      INTEGER,
	activity_at        INTEGER NOT NULL,
	reported_at        INTEGER,
	stopped_at         INTEGER,
	created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (app_id, env),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
