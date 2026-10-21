-- The `jti` of every accepted `private_key_jwt` client assertion (RFC 7523 §3), kept until the assertion's
-- own `exp` so a replayed assertion is refused. SQLite/D1 dialect;
-- `../migrations-postgres/0021_oauth_client_assertions.sql` states the same outcome.
CREATE TABLE oauth_client_assertions (
	client_id TEXT NOT NULL,
	jti TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (client_id, jti)
);
CREATE INDEX idx_oauth_client_assertions_expires ON oauth_client_assertions(expires_at);
