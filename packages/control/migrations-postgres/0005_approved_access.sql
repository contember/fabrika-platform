-- ADR-0050: an environment publishes the snapshot of one run. `generation` is the compare-and-swap token of every
-- publication; `protected` makes a widening wait for a human, and is set on `prod` by default.
ALTER TABLE app_envs ADD COLUMN published_run_id TEXT;
ALTER TABLE app_envs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_envs ADD COLUMN protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1));
UPDATE app_envs SET protected = 1 WHERE env = 'prod';

-- A run holds its snapshot, its classification, its approval and its actor, and parks in `awaiting_approval`.
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
	CHECK (status IN ('pending','running','awaiting_approval','succeeded','failed'));
ALTER TABLE runs ADD COLUMN actor TEXT;                  -- who created the run: `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>`, `poll`
ALTER TABLE runs ADD COLUMN snapshot_json TEXT;          -- the access snapshot read at the pinned commit
ALTER TABLE runs ADD COLUMN classification_json TEXT;    -- the diff against the active snapshot it was compared with
ALTER TABLE runs ADD COLUMN approval_json TEXT;          -- the human approval, bound to both digests
