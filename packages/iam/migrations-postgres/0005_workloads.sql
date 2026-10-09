-- Workload credentials. Postgres twin of ../migrations/0005_workloads.sql — see that file for the model; the outcome is
-- identical.

CREATE TABLE workload_principals (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	app          TEXT NOT NULL,
	kind         TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'app')),
	name         TEXT NOT NULL,
	UNIQUE (app, kind, name)
);

CREATE TABLE app_workloads (
	app     TEXT NOT NULL,
	kind    TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'app')),
	name    TEXT NOT NULL,
	actions TEXT NOT NULL,
	PRIMARY KEY (app, kind, name)
);
