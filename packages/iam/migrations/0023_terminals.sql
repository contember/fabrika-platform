-- Terminals (ADR-0067): a browser an administrator enrolled, on which an application asserts which person is at it.
-- SQLite/D1 dialect; `../migrations-postgres/0023_terminals.sql` states the same outcome.
--
-- A terminal is a `service` principal with this side table, as a workload is. Only the hash of its cookie is stored.
-- `session_ttl` is how long a person's session on it lasts, in seconds, at most one hour.
CREATE TABLE terminals (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	label        TEXT NOT NULL,
	enrolled_by  TEXT REFERENCES principals(id) ON DELETE SET NULL,
	token_hash   TEXT NOT NULL UNIQUE,
	session_ttl  INTEGER NOT NULL CHECK (session_ttl > 0 AND session_ttl <= 3600),
	created_at   INTEGER NOT NULL,
	last_seen_at INTEGER,
	revoked_at   INTEGER
);

-- The applications that may assert a person on a terminal, each with its ceiling: a JSON array of the action patterns
-- of the person's own permissions that survive there. An application without a row asserts nothing on the terminal.
CREATE TABLE terminal_asserters (
	terminal_id TEXT NOT NULL REFERENCES terminals(principal_id) ON DELETE CASCADE,
	app         TEXT NOT NULL,
	ceiling     TEXT NOT NULL,
	PRIMARY KEY (terminal_id, app)
);

-- One identification: IAM sent the terminal's browser to `app` to identify the person, carrying the proxy-started
-- handoff. Single use (`consumed_at`), and only its id's hash is stored.
CREATE TABLE terminal_identifications (
	id_hash           TEXT PRIMARY KEY,
	terminal_id       TEXT NOT NULL REFERENCES terminals(principal_id) ON DELETE CASCADE,
	app               TEXT NOT NULL,
	return_url        TEXT NOT NULL,
	handoff_state     TEXT NOT NULL,
	handoff_challenge TEXT NOT NULL,
	created_at        INTEGER NOT NULL,
	expires_at        INTEGER NOT NULL,
	consumed_at       INTEGER
);

CREATE INDEX idx_terminal_identifications_terminal ON terminal_identifications(terminal_id);
CREATE INDEX idx_terminal_identifications_expires ON terminal_identifications(expires_at);

-- A login on a terminal carries its terminal and the application that asserted the person. SQLite cannot change a
-- CHECK, so `sessions` is rebuilt with every row copied as it is. `auth_codes` and `oauth_grants` reference it, and
-- `oauth_codes` and `oauth_refresh_tokens` reference `oauth_grants`: their rows are kept aside and restored, so
-- dropping the old tables cascades into nothing. The rebuilt table names itself as the parent of a child session, and
-- the rename carries that reference over; roots are copied before the children that reference them.
CREATE TABLE oauth_codes_kept AS SELECT * FROM oauth_codes;
CREATE TABLE oauth_refresh_tokens_kept AS SELECT * FROM oauth_refresh_tokens;
CREATE TABLE oauth_grants_kept AS SELECT * FROM oauth_grants;
CREATE TABLE auth_codes_kept AS SELECT * FROM auth_codes;
DROP TABLE oauth_codes;
DROP TABLE oauth_refresh_tokens;
DROP TABLE oauth_grants;
DROP TABLE auth_codes;

CREATE TABLE sessions_rebuilt (
	id                    TEXT PRIMARY KEY,
	token_hash            TEXT NOT NULL UNIQUE,
	principal_id          TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	idp_sub               TEXT,
	email                 TEXT,
	authentication_method TEXT NOT NULL CHECK (authentication_method IN ('oidc', 'password', 'local_dev', 'terminal_assertion')),
	created_at            INTEGER NOT NULL,
	expires_at            INTEGER NOT NULL,
	revoked_at            INTEGER,
	app                   TEXT,
	parent_session_id     TEXT REFERENCES sessions_rebuilt(id) ON DELETE CASCADE,
	terminal_id           TEXT REFERENCES terminals(principal_id) ON DELETE CASCADE,
	asserted_by           TEXT,
	CHECK (
		(authentication_method IN ('oidc', 'local_dev') AND idp_sub IS NOT NULL)
		OR (authentication_method IN ('password', 'terminal_assertion') AND idp_sub IS NULL)
	),
	CHECK (
		(authentication_method = 'terminal_assertion' AND terminal_id IS NOT NULL AND asserted_by IS NOT NULL)
		OR (authentication_method <> 'terminal_assertion' AND terminal_id IS NULL AND asserted_by IS NULL)
	)
);
INSERT INTO sessions_rebuilt (
	id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at, revoked_at, app, parent_session_id
)
SELECT id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at, revoked_at, app, parent_session_id
FROM sessions
ORDER BY parent_session_id IS NOT NULL;
DROP TABLE sessions;
ALTER TABLE sessions_rebuilt RENAME TO sessions;
CREATE INDEX idx_sessions_principal ON sessions(principal_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_principal_method ON sessions(principal_id, authentication_method);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_terminal ON sessions(terminal_id) WHERE terminal_id IS NOT NULL;

CREATE TABLE auth_codes (
	id                TEXT PRIMARY KEY, -- UUIDv7, minted caller-side
	code_hash         TEXT NOT NULL UNIQUE, -- SHA-256; the plaintext lives in one redirect
	app               TEXT NOT NULL,
	parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	return_url        TEXT NOT NULL, -- carried server-side so redemption cannot be pointed elsewhere
	expires_at        INTEGER NOT NULL,
	consumed_at       INTEGER,
	created_at        INTEGER NOT NULL
);
INSERT INTO auth_codes (id, code_hash, app, parent_session_id, return_url, expires_at, consumed_at, created_at)
SELECT id, code_hash, app, parent_session_id, return_url, expires_at, consumed_at, created_at FROM auth_codes_kept;
DROP TABLE auth_codes_kept;
CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);

CREATE TABLE oauth_grants (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	client_id TEXT NOT NULL,
	app TEXT NOT NULL,
	resource TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER
);
INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at, revoked_at)
SELECT id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at, revoked_at FROM oauth_grants_kept;
DROP TABLE oauth_grants_kept;
CREATE INDEX idx_oauth_grants_session ON oauth_grants(session_id);
CREATE INDEX idx_oauth_grants_principal ON oauth_grants(principal_id);

CREATE TABLE oauth_codes (
	token_hash TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
	redirect_uri TEXT NOT NULL,
	challenge TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, challenge, expires_at, used_at)
SELECT token_hash, grant_id, redirect_uri, challenge, expires_at, used_at FROM oauth_codes_kept;
DROP TABLE oauth_codes_kept;
CREATE INDEX idx_oauth_codes_grant ON oauth_codes(grant_id);
CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at);

CREATE TABLE oauth_refresh_tokens (
	token_hash TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
INSERT INTO oauth_refresh_tokens (token_hash, grant_id, expires_at, used_at)
SELECT token_hash, grant_id, expires_at, used_at FROM oauth_refresh_tokens_kept;
DROP TABLE oauth_refresh_tokens_kept;
CREATE INDEX idx_oauth_refresh_tokens_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX idx_oauth_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);

-- Every `auth_log` row of a terminal session names the terminal and the asserting application, read from the session.
ALTER TABLE auth_log ADD COLUMN terminal_id TEXT;
ALTER TABLE auth_log ADD COLUMN asserted_by TEXT;
