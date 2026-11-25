-- A key a person approved in Control for the agent that asked (ADR-0083 §8). SQLite/D1 dialect;
-- `../migrations-postgres/0040_requested_api_keys.sql` states the same outcome.
--
-- One row per Control approval request that issued a key, written in the transaction that issues it: the request's id
-- is the idempotency key, so a repeat answers the same key and never issues a second. `jwe` is the key encrypted to the
-- agent's public key (ECDH-ES, A256GCM), which only that agent's private key opens; the plaintext is never stored.
-- `input_digest` is the SHA-256 of what was asked, so a repeat that asks for something else is refused.
CREATE TABLE requested_api_keys (
	approval_request_id TEXT PRIMARY KEY,
	principal_id        TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	input_digest        TEXT NOT NULL,
	jwe                 TEXT NOT NULL,
	expires_at          INTEGER NOT NULL,
	created_at          INTEGER NOT NULL
);
