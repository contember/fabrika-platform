-- A task lies in a project and names the team that works on it; the team's members act on it through that column.
CREATE TABLE teams (
	id TEXT PRIMARY KEY
) STRICT;
CREATE TABLE team_members (
	id TEXT PRIMARY KEY,
	team_id TEXT NOT NULL REFERENCES teams (id),
	principal_id TEXT NOT NULL
) STRICT;
CREATE INDEX team_members_principal ON team_members (principal_id, team_id);
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;
CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id),
	team_id TEXT REFERENCES teams (id),
	title TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;
INSERT INTO teams (id) VALUES ('t1'), ('t2');
INSERT INTO team_members (id, team_id, principal_id) VALUES ('m1', 't1', 'user:member');
INSERT INTO projects (id, name, version) VALUES ('p1', 'one', 1), ('p2', 'two', 1);
INSERT INTO tasks (id, project_id, team_id, title, version) VALUES ('k1', 'p1', 't1', 'one', 1), ('k2', 'p1', 't2', 'two', 1), ('k3', 'p2', 't2', 'three', 1);
