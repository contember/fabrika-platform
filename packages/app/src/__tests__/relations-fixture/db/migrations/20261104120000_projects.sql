-- A project is a top-level dimension; a member row names a principal at it until it expires.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	archived INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL
) STRICT;
CREATE TABLE project_members (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	principal_id TEXT NOT NULL,
	expires_at TEXT
) STRICT;
INSERT INTO projects (id, name, archived, version) VALUES ('p1', 'one', 0, 1), ('p2', 'two', 0, 1), ('p3', 'archived', 1, 1);
