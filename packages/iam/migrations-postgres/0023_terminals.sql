-- Terminals (ADR-0067): a browser an administrator enrolled, on which an application asserts which person is at it.
-- Postgres dialect; `../migrations/0023_terminals.sql` states the same outcome. Every existing session keeps its method.
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

-- A login on a terminal carries its terminal and the application that asserted the person.
ALTER TABLE sessions ADD COLUMN terminal_id TEXT REFERENCES terminals(principal_id) ON DELETE CASCADE;

ALTER TABLE sessions ADD COLUMN asserted_by TEXT;

ALTER TABLE sessions DROP CONSTRAINT sessions_authentication_method_check;

ALTER TABLE sessions ADD CONSTRAINT sessions_authentication_method_check
	CHECK (authentication_method IN ('oidc', 'password', 'local_dev', 'terminal_assertion'));

ALTER TABLE sessions DROP CONSTRAINT sessions_method_subject_check;

ALTER TABLE sessions ADD CONSTRAINT sessions_method_subject_check CHECK (
	(authentication_method IN ('oidc', 'local_dev') AND idp_sub IS NOT NULL)
	OR (authentication_method IN ('password', 'terminal_assertion') AND idp_sub IS NULL)
);

ALTER TABLE sessions ADD CONSTRAINT sessions_terminal_check CHECK (
	(authentication_method = 'terminal_assertion' AND terminal_id IS NOT NULL AND asserted_by IS NOT NULL)
	OR (authentication_method <> 'terminal_assertion' AND terminal_id IS NULL AND asserted_by IS NULL)
);

CREATE INDEX idx_sessions_terminal ON sessions(terminal_id) WHERE terminal_id IS NOT NULL;

-- Every `auth_log` row of a terminal session names the terminal and the asserting application, read from the session.
ALTER TABLE auth_log ADD COLUMN terminal_id TEXT;

ALTER TABLE auth_log ADD COLUMN asserted_by TEXT;
