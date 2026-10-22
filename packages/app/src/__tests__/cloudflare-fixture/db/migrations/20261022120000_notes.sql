-- A note lies in a workspace, which has no table of its own.
CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, workspace_id)
) STRICT;
