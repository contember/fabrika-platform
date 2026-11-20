-- Notices every app site reads, and the notes of a workspace a scoped endpoint lists.
CREATE TABLE notices (
	id TEXT PRIMARY KEY,
	body TEXT NOT NULL,
	internal TEXT NOT NULL,
	created_by TEXT NOT NULL
) STRICT;

CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, workspace_id)
) STRICT;
