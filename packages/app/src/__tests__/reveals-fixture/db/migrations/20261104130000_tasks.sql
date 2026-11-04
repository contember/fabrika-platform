-- A task lies in a project; an assignee row names a principal at a task, and an open task reveals its project.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;
CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id),
	open INTEGER NOT NULL DEFAULT 1,
	version INTEGER NOT NULL,
	UNIQUE (id, project_id)
) STRICT;
CREATE TABLE task_assignees (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE INDEX task_assignees_principal ON task_assignees (principal_id, task_id);
INSERT INTO projects (id, name, version) VALUES ('p1', 'one', 1), ('p2', 'two', 1);
INSERT INTO tasks (id, project_id, open, version) VALUES ('t1', 'p1', 1, 1), ('t2', 'p2', 0, 1);
