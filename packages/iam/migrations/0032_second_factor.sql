-- A person's second factor: one TOTP authenticator and its one-time recovery codes. SQLite/D1 dialect;
-- `../migrations-postgres/0032_second_factor.sql` states the same outcome.
--
-- The TOTP secret is sealed under `FABRIKA_IAM_DATA_KEY` (`src/data-key.ts`): a fresh data key per value encrypts it
-- (AES-256-GCM), the installation's key wraps that data key, and the principal id is the associated data of both, so a
-- sealed value moved into another principal's row does not open. `confirmed_at` is NULL while the enrolment waits for
-- its first valid code; only a confirmed row asks a sign-in for a code. `last_step` is the TOTP time step of the last
-- accepted code, so a code is accepted once. A recovery code is stored as its SHA-256 hash only.
CREATE TABLE second_factors (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	ciphertext   TEXT NOT NULL,
	value_iv     TEXT NOT NULL,
	wrapped_dek  TEXT NOT NULL,
	dek_iv       TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	confirmed_at INTEGER,
	last_step    INTEGER
);

CREATE TABLE second_factor_recovery_codes (
	code_hash    TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	created_at   INTEGER NOT NULL,
	used_at      INTEGER
);

CREATE INDEX idx_second_factor_recovery_codes_principal ON second_factor_recovery_codes(principal_id);
