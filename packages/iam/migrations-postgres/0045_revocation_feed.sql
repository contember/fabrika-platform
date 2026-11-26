-- The proxy's revocation feed reads, every few seconds, what was revoked in the last token lifetime
-- (`RevocationRepository.since`, ADR-0022). Postgres dialect; `../migrations/0045_revocation_feed.sql` states the same
-- outcome. Partial indexes: only revoked or disabled rows are read, and most rows are neither.
CREATE INDEX idx_principals_disabled_at ON principals(disabled_at) WHERE disabled_at IS NOT NULL;
CREATE INDEX idx_sessions_revoked_at ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX idx_credentials_revoked_at ON credentials(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX idx_oauth_grants_revoked_at ON oauth_grants(revoked_at) WHERE revoked_at IS NOT NULL;
