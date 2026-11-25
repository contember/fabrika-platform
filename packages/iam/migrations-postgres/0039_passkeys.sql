-- A person's passkeys (WebAuthn credentials) and the challenges of their ceremonies. Postgres dialect;
-- `../migrations/0039_passkeys.sql` states the same outcome.
--
-- `credential_id` is the authenticator's credential id and `public_key` its COSE key, both base64url. `sign_count` is
-- the last signature counter seen (a uint32, so BIGINT on Postgres); an assertion whose counter does not move past it is
-- refused, unless both are 0, which a synced passkey always reports. `transports` is a JSON array of strings.
CREATE TABLE passkeys (
	id            TEXT PRIMARY KEY,
	principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	credential_id TEXT NOT NULL UNIQUE,
	public_key    TEXT NOT NULL,
	sign_count    BIGINT NOT NULL,
	transports    TEXT NOT NULL,
	label         TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER
);

CREATE INDEX idx_passkeys_principal ON passkeys(principal_id);

-- A ceremony's challenge: single-use (consumed by a DELETE before anything is compared) and short-lived. `binding` is
-- the caller's opaque statement of what an assertion is for, set at issue and compared at verification.
CREATE TABLE passkey_challenges (
	id           TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	kind         TEXT NOT NULL CHECK (kind IN ('registration', 'assertion')),
	challenge    TEXT NOT NULL,
	binding      TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_passkey_challenges_principal ON passkey_challenges(principal_id);
