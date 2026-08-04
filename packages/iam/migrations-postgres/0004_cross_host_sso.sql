-- Cross-host session handoff (ADR-0021). Postgres twin of ../migrations/0010_cross_host_sso.sql.

-- `app` NULL marks an IAM session (held on IAM's own host); non-NULL marks a child session the proxy
-- holds on ONE app's host, and it may mint only for that app.
ALTER TABLE sessions ADD COLUMN app TEXT;
-- Revoking the parent revokes every child derived from it.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE app_return_origins (
	app        TEXT NOT NULL,
	origin     TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (app, origin)
);

CREATE TABLE auth_codes (
	id                TEXT PRIMARY KEY,
	code_hash         TEXT NOT NULL UNIQUE,
	app               TEXT NOT NULL,
	parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	return_url        TEXT NOT NULL,
	expires_at        INTEGER NOT NULL,
	consumed_at       INTEGER,
	created_at        INTEGER NOT NULL
);

CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);
