-- Passkeys move to IAM's own host (ADR-0050 §5): the relying party is IAM's issuer, no longer the console. SQLite/D1
-- dialect; `../migrations-postgres/0047_passkeys_on_iam.sql` states the same outcome.
--
-- A WebAuthn credential answers only under the RP ID it was created for, so no passkey registered on the console can
-- answer on IAM's host: every one is removed, and its owner registers a new one. Audit ids are UUIDv7 made in code, so
-- the removed passkeys wait in `passkeys_rp_moved` until IAM's maintenance pass records one `iam.passkey.reset`
-- (reason `rp_moved`) for each and deletes its row. Open challenges were issued for the console, so they go too.
CREATE TABLE passkeys_rp_moved (
	id           TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	label        TEXT NOT NULL,
	created_at   INTEGER NOT NULL
);

INSERT INTO passkeys_rp_moved (id, principal_id, label, created_at) SELECT id, principal_id, label, created_at FROM passkeys;

DELETE FROM passkey_challenges;

DELETE FROM passkeys;

-- A step-up the console asks for is answered on IAM's page and consumed later by Control, so a challenge records the
-- answer: the credential that signed it and when. Both stay NULL until then, and on every other challenge.
ALTER TABLE passkey_challenges ADD COLUMN answered_credential_id TEXT;

ALTER TABLE passkey_challenges ADD COLUMN answered_at INTEGER;
