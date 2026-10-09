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
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
	CHECK (status IN ('pending','running','awaiting_approval','succeeded','failed'));
ALTER TABLE runs ADD COLUMN actor TEXT;                  -- who created the run: `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>`, `poll`
ALTER TABLE runs ADD COLUMN snapshot_json TEXT;          -- the access snapshot read at the pinned commit
ALTER TABLE runs ADD COLUMN classification_json TEXT;    -- the diff against the active snapshot it was compared with
ALTER TABLE runs ADD COLUMN approval_json TEXT;          -- the human approval, bound to both digests
ALTER TABLE runs ADD COLUMN pending_access_json TEXT;    -- the artifact access a deploy found waiting for a human
