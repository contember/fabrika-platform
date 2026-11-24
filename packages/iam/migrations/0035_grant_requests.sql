-- A console grant that waits for a second administrator (ADR-0083). SQLite/D1 dialect;
-- `../migrations-postgres/0035_grant_requests.sql` states the same outcome.
--
-- `app_grant_approvals` names each application id (`<app>@<env>`) whose grant changes wait: Control writes it with the
-- provisioning key when an environment chooses the `grants` approval category. No row, as for every application before
-- this file, means a grant change applies at once.
CREATE TABLE app_grant_approvals (
	app        TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

-- One requested grant change. Nothing that resolves permissions reads this table: a request has no effect until an
-- approval writes the change itself, in the transaction that claims the request (`decision_id`). The grant fields are
-- the new grant for `create` and `update`, the revoked one for `revoke`; `grant_id` names the grant an `update` or a
-- `revoke` acts on. An open request is `pending` before `expires_at`.
CREATE TABLE grant_requests (
	id               TEXT PRIMARY KEY,
	app              TEXT NOT NULL,
	kind             TEXT NOT NULL CHECK (kind IN ('create', 'update', 'revoke')),
	principal_id     TEXT NOT NULL,
	grant_id         TEXT,
	role_key         TEXT,
	permissions      TEXT,
	scope_type       TEXT,
	scope_value      TEXT,
	grant_expires_at INTEGER,
	requested_by     TEXT NOT NULL,
	requested_at     INTEGER NOT NULL,
	expires_at       INTEGER NOT NULL,
	status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
	decision_id      TEXT,
	decided_by       TEXT,
	decided_at       INTEGER,
	CHECK ((kind = 'create') = (grant_id IS NULL)),
	CHECK ((role_key IS NULL) <> (permissions IS NULL)),
	CHECK ((scope_type IS NULL) = (scope_value IS NULL))
);
CREATE INDEX idx_grant_requests_open ON grant_requests (app, status);
