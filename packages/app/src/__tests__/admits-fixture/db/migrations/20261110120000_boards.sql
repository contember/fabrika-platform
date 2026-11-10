-- An organization holds projects, a project holds tasks; a member row names a principal at a project.
CREATE TABLE orgs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs (id),
	name TEXT NOT NULL,
	UNIQUE (id, org_id)
) STRICT;
CREATE TABLE project_members (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	visibility TEXT NOT NULL,
	title TEXT NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) STRICT;
INSERT INTO orgs (id, name) VALUES ('o1', 'one'), ('o2', 'two');
INSERT INTO projects (id, org_id, name) VALUES ('p1', 'o1', 'one'), ('p2', 'o1', 'two'), ('p3', 'o2', 'three');
INSERT INTO tasks (id, project_id, org_id, visibility, title) VALUES
	('k1', 'p1', 'o1', 'private', 'one'),
	('k2', 'p2', 'o1', 'public', 'two'),
	('k3', 'p2', 'o1', 'private', 'three'),
	('k4', 'p3', 'o2', 'public', 'four');
