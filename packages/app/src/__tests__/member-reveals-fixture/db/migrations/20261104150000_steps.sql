-- A step lies in a task, which lies in a project; a grant at an open step reveals its project.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;
CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id),
	version INTEGER NOT NULL,
	UNIQUE (id, project_id)
) STRICT;
CREATE TABLE steps (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	open INTEGER NOT NULL DEFAULT 1,
	version INTEGER NOT NULL,
	FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id) ON UPDATE CASCADE
) STRICT;
INSERT INTO projects (id, name, version) VALUES ('p1', 'one', 1), ('p2', 'two', 1);
INSERT INTO tasks (id, project_id, version) VALUES ('t1', 'p1', 1), ('t2', 'p2', 1);
INSERT INTO steps (id, task_id, project_id, open, version) VALUES ('s1', 't1', 'p1', 1, 1), ('s2', 't2', 'p2', 0, 1);
