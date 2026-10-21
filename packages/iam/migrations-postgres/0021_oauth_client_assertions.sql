-- The `jti` of every accepted `private_key_jwt` client assertion. Postgres twin of
-- ../migrations/0021_oauth_client_assertions.sql — see that file for the model; the outcome is identical.
CREATE TABLE oauth_client_assertions (
	client_id TEXT NOT NULL,
	jti TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (client_id, jti)
);
CREATE INDEX idx_oauth_client_assertions_expires ON oauth_client_assertions(expires_at);
