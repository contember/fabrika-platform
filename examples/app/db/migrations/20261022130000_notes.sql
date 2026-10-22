-- A note lies in a project, which has no table of its own. The `review` job stamps `reviewed_at`; `attachment` is an
-- optional file of the `attachments` kind.
CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	title TEXT NOT NULL,
	attachment TEXT REFERENCES fabrika_files (id),
	reviewed_at TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	version INTEGER NOT NULL,
	UNIQUE (id, project_id)
) STRICT;
CREATE INDEX notes_project ON notes (project_id, created_at);
CREATE INDEX notes_attachment ON notes (attachment);
