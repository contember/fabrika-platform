-- ADR-0083 §8: a key an approved request issued, waiting for the agent that asked for it. IAM answers the key only
-- encrypted to that agent's public key (a compact JWE), and Control keeps it here until the requester fetches it once:
-- the fetch, or the deadline, clears `jwe`. The IAM service principal is kept so the sweep revokes a key nobody fetched.
-- No foreign key, as `approval_requests` has none.
CREATE TABLE approval_request_deliveries (
	request_id   TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL,
	jwe          TEXT,
	state        TEXT NOT NULL CHECK (state IN ('waiting', 'fetched', 'expired', 'revoked')),
	deadline     INTEGER NOT NULL,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_approval_request_deliveries_state ON approval_request_deliveries(state, deadline);
