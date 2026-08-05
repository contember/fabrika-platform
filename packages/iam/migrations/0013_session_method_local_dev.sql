-- The local-dev bypass becomes an authentication method of its own. Twin of
-- ../migrations-postgres/0007_session_method_local_dev.sql — the OUTCOME of the two files must match.
--
-- Until now a bypass session was stored as `oidc` and recognised by its fixed subject, so "is this
-- session's method still enabled?" could not be asked without a special case — and the naive form of
-- the question ("refuse an oidc session when OIDC is off") disabled the bypass itself, because a local
-- installation runs OIDC_ENABLED=false. With a method of its own the rule needs no exception.
--
-- BOTH checks widen: the enum, and the row check pairing a method with `idp_sub`. `local_dev` joins
-- the NON-NULL arm — the bypass records the fixed subject `local-dev-admin`, which no IdP emits, and
-- that is also what makes the backfill below name exactly the rows the bypass minted.

-- The rebuild drops `sessions`, which `auth_codes.parent_session_id` cascades from. Spend the codes
-- explicitly so the outcome does not depend on whether foreign keys are enforced while this runs; they
-- are single-use and live five minutes, so the worst case is one login in flight that gets retried.
DELETE FROM auth_codes;

-- SQLite cannot alter a CHECK in place, so the table is rebuilt (as 0009 did).
CREATE TABLE sessions_local_dev (
	id                    TEXT PRIMARY KEY,
	token_hash            TEXT NOT NULL UNIQUE,
	principal_id          TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	idp_sub               TEXT,
	email                 TEXT,
	authentication_method TEXT NOT NULL CHECK (authentication_method IN ('oidc', 'password', 'local_dev')),
	created_at            INTEGER NOT NULL,
	expires_at            INTEGER NOT NULL,
	revoked_at            INTEGER,
	app                   TEXT,
	parent_session_id     TEXT REFERENCES sessions_local_dev(id) ON DELETE CASCADE,
	CHECK (
		(authentication_method IN ('oidc', 'local_dev') AND idp_sub IS NOT NULL)
		OR (authentication_method = 'password' AND idp_sub IS NULL)
	)
);

-- Copied in two passes, parents before children: `parent_session_id` points back into this same table
-- and SQLite checks a foreign key on the row that carries it, not at the end of the statement.
INSERT INTO sessions_local_dev
	(id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at, revoked_at, app, parent_session_id)
	SELECT id, token_hash, principal_id, idp_sub, email,
		CASE WHEN idp_sub = 'local-dev-admin' THEN 'local_dev' ELSE authentication_method END,
		created_at, expires_at, revoked_at, app, parent_session_id
	FROM sessions WHERE parent_session_id IS NULL;

INSERT INTO sessions_local_dev
	(id, token_hash, principal_id, idp_sub, email, authentication_method, created_at, expires_at, revoked_at, app, parent_session_id)
	SELECT id, token_hash, principal_id, idp_sub, email,
		CASE WHEN idp_sub = 'local-dev-admin' THEN 'local_dev' ELSE authentication_method END,
		created_at, expires_at, revoked_at, app, parent_session_id
	FROM sessions WHERE parent_session_id IS NOT NULL;

DROP TABLE sessions;
ALTER TABLE sessions_local_dev RENAME TO sessions;
CREATE INDEX idx_sessions_principal ON sessions(principal_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_principal_method ON sessions(principal_id, authentication_method);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
