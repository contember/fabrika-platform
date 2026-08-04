-- Password authentication support. This is the Postgres twin of
-- ../migrations/0009_password_auth.sql.

ALTER TABLE principals ADD COLUMN activated_at INTEGER;

UPDATE principals
	SET activated_at = created_at
	WHERE type = 'service' OR external_id IS NOT NULL;

CREATE TABLE principal_email_claims (
	normalized_email TEXT PRIMARY KEY,
	principal_id     TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE
);

ALTER TABLE sessions ALTER COLUMN idp_sub DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'oidc'
	CHECK (authentication_method IN ('oidc', 'password'));
ALTER TABLE sessions ALTER COLUMN authentication_method DROP DEFAULT;
ALTER TABLE sessions ADD CHECK (
	(authentication_method = 'oidc' AND idp_sub IS NOT NULL)
	OR (authentication_method = 'password' AND idp_sub IS NULL)
);
CREATE INDEX idx_sessions_principal_method ON sessions(principal_id, authentication_method);

CREATE TABLE password_accounts (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	state        TEXT NOT NULL CHECK (state IN ('disabled', 'pending', 'enabled')),
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE password_credentials (
	principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	algorithm     TEXT NOT NULL,
	parameters    TEXT NOT NULL,
	salt          TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);

CREATE TABLE password_action_tokens (
	id           TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	purpose      TEXT NOT NULL CHECK (purpose IN ('enrollment', 'reset')),
	token_hash   TEXT NOT NULL UNIQUE,
	issued_by    TEXT REFERENCES principals(id) ON DELETE SET NULL,
	expires_at   INTEGER NOT NULL,
	consumed_at  INTEGER,
	consumption_id TEXT UNIQUE,
	created_at   INTEGER NOT NULL
);

CREATE INDEX idx_password_action_tokens_principal ON password_action_tokens(principal_id, purpose);
CREATE INDEX idx_password_action_tokens_expires ON password_action_tokens(expires_at);
CREATE UNIQUE INDEX uq_password_action_tokens_active
	ON password_action_tokens(principal_id, purpose) WHERE consumed_at IS NULL;

CREATE TABLE password_login_throttles (
	login_key_hash    TEXT PRIMARY KEY,
	window_started_at INTEGER NOT NULL,
	attempt_count     INTEGER NOT NULL CHECK (attempt_count > 0),
	blocked_until     INTEGER,
	updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_password_login_throttles_updated ON password_login_throttles(updated_at);
