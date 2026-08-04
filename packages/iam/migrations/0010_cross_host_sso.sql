-- Cross-host session handoff (ADR-0021): a one-time code redeemed by the proxy, and the app-bound
-- child session it produces. Twin of ../migrations-postgres/0004_cross_host_sso.sql.

-- `app` NULL marks an IAM session (the one the browser holds on IAM's own host); non-NULL marks a
-- child session the proxy holds on ONE app's host, and it may mint only for that app.
ALTER TABLE sessions ADD COLUMN app TEXT;
-- The IAM session a child was derived from. Revoking the parent revokes every child with it, which
-- the shared-cookie handoff could not do at all.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

-- Return origins IAM is willing to send a browser back to, per app. An origin that is not here is a
-- 400 at issue time; there is deliberately no fallback, because a silent one turns a misconfigured
-- app into a redirect loop nobody can read.
CREATE TABLE app_return_origins (
	app        TEXT NOT NULL,
	origin     TEXT NOT NULL, -- canonical scheme://host[:port], lower-cased, no trailing slash
	created_at INTEGER NOT NULL,
	PRIMARY KEY (app, origin)
);

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

CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);
