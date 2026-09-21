CREATE TABLE device_authorizations (
 id TEXT PRIMARY KEY,
 app TEXT NOT NULL,
 label TEXT NOT NULL,
 permissions TEXT NOT NULL,
 key_lifetime_seconds INTEGER NOT NULL CHECK (key_lifetime_seconds > 0 AND key_lifetime_seconds <= 2592000),
 redemption_challenge TEXT NOT NULL,
 approval_challenge TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 next_poll_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'issued', 'denied', 'cancelled', 'authority_lost')),
 approver_id TEXT,
 consent_id TEXT UNIQUE,
 scope_type TEXT,
 scope_value TEXT,
 key_expires_at INTEGER,
 claim_id TEXT UNIQUE,
 credential_id TEXT,
 principal_id TEXT,
 issued_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_device_authorizations_issuer ON device_authorizations (approver_id, app, id);
CREATE INDEX idx_device_authorizations_expiry ON device_authorizations (expires_at);
