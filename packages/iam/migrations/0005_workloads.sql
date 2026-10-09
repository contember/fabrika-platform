-- Workload credentials (ADR-0022 "Principal kinds"): a job, a webhook or a connector of a contract application holds a
-- `px_` key of its own principal kind. SQLite/D1 dialect; `../migrations-postgres/0005_workloads.sql` states the same
-- outcome. Nothing written before this file is a workload.

-- A workload's identity. Its principal is a `service` row whose `external_id` is `workload:<app>:<kind>:<name>`, so the
-- unique index on (type, external_id) makes creating it idempotent; this row names the kind the key mints with.
CREATE TABLE workload_principals (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	app          TEXT NOT NULL,
	kind         TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'app')),
	name         TEXT NOT NULL,
	UNIQUE (app, kind, name)
);

-- What a schema reconcile declares for each workload: its exact actions (JSON array), app-wide. A workload key resolves
-- to these and nothing else; one no longer declared resolves to nothing, and the reconcile revokes its keys.
CREATE TABLE app_workloads (
	app     TEXT NOT NULL,
	kind    TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'app')),
	name    TEXT NOT NULL,
	actions TEXT NOT NULL,
	PRIMARY KEY (app, kind, name)
);
