-- A staff row names a person of the directory, whose row holds the principal it confers the relation on.
CREATE TABLE people (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL
) STRICT;
CREATE TABLE project_staff (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE
) STRICT;
INSERT INTO people (id, principal_id) VALUES ('pe-staffer', 'user:staffer'), ('pe-lead', 'user:lead');
