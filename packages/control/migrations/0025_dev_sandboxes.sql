-- One Box sandbox per MCP workspace of a `dev` environment on Zerops: the sandbox, what its launcher follows and what it
-- last reported. The runtime columns mirror dev_environments; parked_at and woke_at replace its service stop and start.
CREATE TABLE dev_sandboxes (
	workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id),
	app_id             TEXT NOT NULL,
	env                TEXT NOT NULL,
	sandbox_id         TEXT,
	base_digest        TEXT,
	upstream_host      TEXT,
	state              TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'removing')),
	proxy_secret_ref   TEXT,
	bootstrap_run_id   TEXT,
	published_run_id   TEXT,
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
	parked_at          INTEGER,
	woke_at            INTEGER,
	launcher_seen_at   INTEGER,
	launcher_refused   TEXT,
	created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
CREATE INDEX idx_dev_sandboxes_environment ON dev_sandboxes (app_id, env);
CREATE INDEX idx_dev_sandboxes_idle ON dev_sandboxes (activity_at) WHERE state = 'ready' AND parked_at IS NULL;

-- The `source` key of a dev sandbox authenticates its launcher to one workspace; NULL for every other key.
ALTER TABLE platform_transport_keys ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

-- The workspace id of a dev bootstrap run; a newer succeeded run supersedes only a run of the same lane. NULL otherwise.
ALTER TABLE runs ADD COLUMN lane TEXT;

-- The contract digest IAM last received for the environment, so a dev workspace can tell whether IAM follows it.
ALTER TABLE app_envs ADD COLUMN iam_digest TEXT;
