-- Contract applications. Postgres twin of ../migrations/0003_contract_apps.sql — see that file for
-- the model; the outcome is identical.
CREATE TABLE contract_apps (
	app        TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

ALTER TABLE roles ADD COLUMN member_scope TEXT;
