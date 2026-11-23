-- RFC 8628 device authorization attempts of the OAuth server. Postgres dialect;
-- `../migrations/0034_oauth_device_authorizations.sql` states the same outcome.
--
-- Only hashes of the device code and the user code are stored. An attempt lives five minutes. A person approving it
-- binds it to their IAM session and picks the grant's end; the grant itself is written when the device redeems the
-- approval, and `grant_id` names it then, so a device code presented again revokes that grant.
CREATE TABLE oauth_device_authorizations (
	device_code_hash TEXT PRIMARY KEY,
	user_code_hash TEXT NOT NULL UNIQUE,
	client_id TEXT NOT NULL,
	app TEXT NOT NULL,
	resources TEXT NOT NULL,
	scopes TEXT NOT NULL,
	interval_seconds INTEGER NOT NULL,
	next_poll_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'redeemed')),
	principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE,
	session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	grant_expires_at INTEGER,
	grant_id TEXT
);
CREATE INDEX idx_oauth_device_authorizations_expires ON oauth_device_authorizations(expires_at);
