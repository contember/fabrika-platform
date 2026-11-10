-- An organization holds projects; a member row names a principal at a project.
CREATE TABLE orgs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL
) STRICT;
CREATE TABLE org_members (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs (id),
	principal_id TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs (id),
	name TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, org_id)
) STRICT;
CREATE TABLE project_members (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
) STRICT;
INSERT INTO orgs (id, name) VALUES ('o1', 'one'), ('o2', 'two');
INSERT INTO org_members (id, org_id, principal_id) VALUES ('c1', 'o1', 'user:visitor');
INSERT INTO projects (id, org_id, name, version) VALUES ('p1', 'o1', 'one', 1), ('p2', 'o1', 'two', 1), ('p3', 'o2', 'three', 1);
