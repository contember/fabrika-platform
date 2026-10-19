-- A public procedure is a workload of its own (`public`, named by its endpoint id): Control issues its key, and IAM
-- signs its token with the actions the schema declares for it. SQLite/D1 dialect;
-- `../migrations-postgres/0020_public_workloads.sql` states the same outcome.
--
-- SQLite cannot alter a CHECK, so both tables are rebuilt with every row copied as it is. Nothing references either
-- table; `workload_principals` keeps its cascade from `principals`.
CREATE TABLE workload_principals_next (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	app          TEXT NOT NULL,
	kind         TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'public', 'app')),
	name         TEXT NOT NULL,
	UNIQUE (app, kind, name)
);

INSERT INTO workload_principals_next (principal_id, app, kind, name) SELECT principal_id, app, kind, name FROM workload_principals;

DROP TABLE workload_principals;

ALTER TABLE workload_principals_next RENAME TO workload_principals;

CREATE TABLE app_workloads_next (
	app     TEXT NOT NULL,
	kind    TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'public', 'app')),
	name    TEXT NOT NULL,
	actions TEXT NOT NULL,
	issues  TEXT CHECK (issues IS NULL OR kind = 'job'),
	PRIMARY KEY (app, kind, name)
);

INSERT INTO app_workloads_next (app, kind, name, actions, issues) SELECT app, kind, name, actions, issues FROM app_workloads;

DROP TABLE app_workloads;

ALTER TABLE app_workloads_next RENAME TO app_workloads;
