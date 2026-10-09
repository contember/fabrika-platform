-- ADR-0050: an environment publishes the snapshot of one run. `generation` is the compare-and-swap token of every
-- publication; `protected` makes a widening wait for a human, and is set on `prod` by default.
ALTER TABLE app_envs ADD COLUMN published_run_id TEXT;
-- The published snapshot itself, written by the same compare-and-swap; the approved access is read only from here.
ALTER TABLE app_envs ADD COLUMN published_snapshot_json TEXT;
ALTER TABLE app_envs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_envs ADD COLUMN protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1));
UPDATE app_envs SET protected = 1 WHERE env = 'prod';
-- Bumped by every change of `protected` together with `generation`, so a run that classified before the change
-- loses its publication and classifies again.
ALTER TABLE app_envs ADD COLUMN protection_revision INTEGER NOT NULL DEFAULT 0;

-- What outlives an environment: deleting `<app>/<env>` writes its `protected` flag and its counters here, with
-- `generation` advanced, and creating it again starts from them. The human's choice survives, and a run that
-- classified against the deleted environment cannot publish into the new one. No foreign key, so deleting the
-- environment or the application leaves the row.
CREATE TABLE app_env_protection (
	app_id              TEXT NOT NULL,
	env                 TEXT NOT NULL,
	protected           INTEGER NOT NULL CHECK (protected IN (0, 1)),
	generation          INTEGER NOT NULL,
	protection_revision INTEGER NOT NULL,
	PRIMARY KEY (app_id, env)
);

-- A run holds its snapshot, its classification, its approval and its actor, and parks in `awaiting_approval`.
-- SQLite cannot change a CHECK, so `runs` is rebuilt. `operations_release_sync` references it: its rows are kept
-- aside and restored, so dropping the old table cascades into nothing.
CREATE TABLE operations_release_sync_kept AS SELECT * FROM operations_release_sync;
DROP TABLE operations_release_sync;

CREATE TABLE runs_rebuilt (
	id                  TEXT PRIMARY KEY,
	app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                 TEXT NOT NULL,
	ref                 TEXT NOT NULL,
	commit_sha          TEXT,
	trigger             TEXT NOT NULL CHECK (trigger IN ('webhook','manual','poll')),
	status              TEXT NOT NULL CHECK (status IN ('pending','running','awaiting_approval','succeeded','failed')),
	exit_code           INTEGER,
	log_key             TEXT,
	created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
	started_at          INTEGER,
	finished_at         INTEGER,
	external_run_id     TEXT,
	provider_state_json TEXT,
	cancel_requested_at INTEGER,
	actor               TEXT,                              -- who created the run: `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>`, `poll`
	snapshot_json       TEXT,                              -- the access snapshot read at the pinned commit
	classification_json TEXT,                              -- the diff against the active snapshot it was compared with
	approval_json       TEXT,                              -- the human approval, bound to both digests
	pending_access_json TEXT                               -- the artifact access a deploy found waiting for a human
);
INSERT INTO runs_rebuilt (
	id, app_id, env, ref, commit_sha, trigger, status, exit_code, log_key, created_at, started_at, finished_at,
	external_run_id, provider_state_json, cancel_requested_at
)
SELECT
	id, app_id, env, ref, commit_sha, trigger, status, exit_code, log_key, created_at, started_at, finished_at,
	external_run_id, provider_state_json, cancel_requested_at
FROM runs;
DROP TABLE runs;
ALTER TABLE runs_rebuilt RENAME TO runs;
CREATE INDEX idx_runs_app_env ON runs(app_id, env, id);
CREATE INDEX idx_runs_status  ON runs(status, id);

CREATE TABLE operations_release_sync (
	run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
	desired_revision  INTEGER NOT NULL,
	applied_revision  INTEGER NOT NULL DEFAULT 0,
	payload_json      TEXT NOT NULL,
	last_attempt_at   INTEGER,
	last_success_at   INTEGER,
	last_error        TEXT
);
INSERT INTO operations_release_sync (
	run_id, desired_revision, applied_revision, payload_json, last_attempt_at, last_success_at, last_error
)
SELECT run_id, desired_revision, applied_revision, payload_json, last_attempt_at, last_success_at, last_error
FROM operations_release_sync_kept;
DROP TABLE operations_release_sync_kept;
CREATE INDEX idx_operations_release_sync_pending
	ON operations_release_sync(applied_revision, desired_revision, run_id);
