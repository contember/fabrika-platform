-- Durable audit: a logout is an `auth_log` row of its own, and a login of an installation administrator is marked
-- privileged. SQLite/D1 dialect; `../migrations-postgres/0008_durable_audit.sql` states the same outcome.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Nothing references `auth_log`, and every existing row was a
-- login attempt that nobody marked, so it is copied as `privileged = 0`. The rowid ids are copied, so the admin
-- view's `before=` cursor keeps working across the migration.
CREATE TABLE auth_log_next (
	id            INTEGER PRIMARY KEY,
	request_id    TEXT NOT NULL,
	app           TEXT NOT NULL,
	kind          TEXT NOT NULL CHECK (kind IN ('authenticate', 'logout')),
	principal_id  TEXT REFERENCES principals(id) ON DELETE SET NULL,
	credential_id TEXT,
	decision      TEXT NOT NULL CHECK (decision IN ('allow','deny')),
	reason        TEXT,
	created_at    INTEGER NOT NULL,
	privileged    INTEGER NOT NULL DEFAULT 0 CHECK (privileged IN (0, 1))
);

INSERT INTO auth_log_next (id, request_id, app, kind, principal_id, credential_id, decision, reason, created_at, privileged)
	SELECT id, request_id, app, kind, principal_id, credential_id, decision, reason, created_at, 0 FROM auth_log;

DROP TABLE auth_log;

ALTER TABLE auth_log_next RENAME TO auth_log;

CREATE INDEX idx_auth_log_principal ON auth_log(principal_id, created_at);
CREATE INDEX idx_auth_log_request   ON auth_log(request_id);
