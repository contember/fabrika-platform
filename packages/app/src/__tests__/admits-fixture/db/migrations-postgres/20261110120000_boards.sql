-- The SQLite fixture on Postgres, with organizations keyed by uuid: the database compares their keys by value.
CREATE TABLE orgs (
	id uuid PRIMARY KEY,
	name text NOT NULL
);
CREATE TABLE projects (
	id text PRIMARY KEY,
	org_id uuid NOT NULL REFERENCES orgs (id),
	name text NOT NULL,
	UNIQUE (id, org_id)
);
CREATE TABLE project_members (
	id text PRIMARY KEY,
	project_id text NOT NULL,
	org_id uuid NOT NULL,
	principal_id text NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE TABLE tasks (
	id text PRIMARY KEY,
	project_id text NOT NULL,
	org_id uuid NOT NULL,
	visibility text NOT NULL,
	title text NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
);
INSERT INTO orgs (id, name) VALUES ('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'one'), ('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02', 'two');
INSERT INTO projects (id, org_id, name) VALUES
	('p1', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'one'),
	('p2', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'two'),
	('p3', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02', 'three');
INSERT INTO tasks (id, project_id, org_id, visibility, title) VALUES
	('k1', 'p1', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'private', 'one'),
	('k2', 'p2', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'public', 'two'),
	('k3', 'p2', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'private', 'three'),
	('k4', 'p3', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02', 'public', 'four');
