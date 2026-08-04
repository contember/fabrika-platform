-- Password authentication support. Passwords, one-time action tokens, and login throttles are
-- deliberately separate concerns. Only derived password material and token/login-key hashes live
-- in the database.

ALTER TABLE principals ADD COLUMN activated_at INTEGER;

-- Preserve the lifecycle of existing claimed users and all native/service identities. Existing
-- unclaimed users remain pending until OIDC claim or password enrollment completes.
UPDATE principals
	SET activated_at = created_at
	WHERE type = 'service' OR external_id IS NOT NULL;

-- Serializes new admin/bootstrap invites by normalized mailbox without rewriting legacy OIDC
-- identity rows. Existing case variants remain visible to fail-closed password lookup.
CREATE TABLE principal_email_claims (
	normalized_email TEXT PRIMARY KEY,
	principal_id     TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE
);

-- SQLite cannot drop idp_sub's NOT NULL constraint in place. Rebuild the table so password-origin
-- sessions can have no upstream IdP subject and every session records its authentication method.
CREATE TABLE sessions_password_auth (
	id                    TEXT PRIMARY KEY,
	token_hash            TEXT NOT NULL UNIQUE,
	principal_id          TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	idp_sub               TEXT,
	email                 TEXT,
	authentication_method TEXT NOT NULL CHECK (authentication_method IN ('oidc', 'password')),
	created_at            INTEGER NOT NULL,
	expires_at            INTEGER NOT NULL,
	revoked_at            INTEGER,
	CHECK (
		(authentication_method = 'oidc' AND idp_sub IS NOT NULL)
		OR (authentication_method = 'password' AND idp_sub IS NULL)
	)
);

INSERT INTO sessions_password_auth
	(id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at, revoked_at)
	SELECT id, token_hash, principal_id, idp_sub, email, 'oidc', created_at, expires_at, revoked_at FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_password_auth RENAME TO sessions;
CREATE INDEX idx_sessions_principal ON sessions(principal_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
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
	id          TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	purpose     TEXT NOT NULL CHECK (purpose IN ('enrollment', 'reset')),
	token_hash  TEXT NOT NULL UNIQUE,
	issued_by   TEXT REFERENCES principals(id) ON DELETE SET NULL,
	expires_at  INTEGER NOT NULL,
	consumed_at INTEGER,
	consumption_id TEXT UNIQUE,
	created_at  INTEGER NOT NULL
);

CREATE INDEX idx_password_action_tokens_principal ON password_action_tokens(principal_id, purpose);
CREATE INDEX idx_password_action_tokens_expires ON password_action_tokens(expires_at);
CREATE UNIQUE INDEX uq_password_action_tokens_active
	ON password_action_tokens(principal_id, purpose) WHERE consumed_at IS NULL;

CREATE TABLE password_login_throttles (
	login_key_hash   TEXT PRIMARY KEY,
	window_started_at INTEGER NOT NULL,
	attempt_count     INTEGER NOT NULL CHECK (attempt_count > 0),
	blocked_until     INTEGER,
	updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_password_login_throttles_updated ON password_login_throttles(updated_at);
