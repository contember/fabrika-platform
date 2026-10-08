-- An operator marks an app environment as an MCP authoring target (ADR-0049).
ALTER TABLE app_envs ADD COLUMN authoring INTEGER NOT NULL DEFAULT 0 CHECK (authoring IN (0, 1));

-- Workspace metadata only: the branch on GitHub is the content, and its live head comes from GitHub.
CREATE TABLE workspaces (
	id          TEXT PRIMARY KEY,
	app_id      TEXT NOT NULL,
	env         TEXT NOT NULL,
	owner_id    TEXT NOT NULL,
	branch      TEXT NOT NULL UNIQUE,
	base_sha    TEXT NOT NULL,
	title       TEXT NOT NULL,
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
CREATE INDEX workspaces_owner ON workspaces(owner_id, app_id, env);
