-- OAuth 2.1 authorization server for MCP clients. Postgres twin of ../migrations/0002_oauth.sql —
-- see that file for the model; the outcome is identical.
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
CREATE INDEX idx_oauth_codes_grant ON oauth_codes(grant_id);
CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at);

CREATE TABLE oauth_refresh_tokens (
	token_hash TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
CREATE INDEX idx_oauth_refresh_tokens_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX idx_oauth_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);
