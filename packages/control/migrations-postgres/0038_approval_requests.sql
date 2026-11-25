-- ADR-0083 §8: an approval request, the pending registry write a non-person asks a person to approve. The row is the
-- record of authority: what was asked (the kind, its canonical input and the before-state it binds, each with its
-- SHA-256), at which coordinates, by whom, who decided and when, and what the execution did. A transition changes only
-- the state and the columns it fills, each in one conditional write; the request fields are never edited. No foreign
-- key: the record outlives its application and environment, as `app_env_protection` does.
CREATE TABLE approval_requests (
	id                     TEXT PRIMARY KEY,
	kind                   TEXT NOT NULL,
	input_json             TEXT NOT NULL,
	input_digest           TEXT NOT NULL,
	app_id                 TEXT NOT NULL,
	env                    TEXT NOT NULL,
	category               TEXT NOT NULL,
	requester_id           TEXT NOT NULL,
	requester_type         TEXT NOT NULL,
	requester_label        TEXT NOT NULL,
	requester_credential   TEXT NOT NULL CHECK (requester_credential IN ('oauth', 'key')),
	requester_client_id    TEXT,
	requester_grant_id     TEXT,
	requester_issuer_id    TEXT,
	before_json            TEXT NOT NULL,
	before_digest          TEXT NOT NULL,
	state                  TEXT NOT NULL CHECK (
		state IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'executed', 'failed', 'unknown', 'stale')
	),
	partial_approver_id    TEXT,
	partial_approver_label TEXT,
	partial_approved_at    INTEGER,
	decision_id            TEXT,
	decided_by_id          TEXT,
	decided_by_label       TEXT,
	decided_at             INTEGER,
	operation_id           TEXT UNIQUE,
	result_json            TEXT,
	error                  TEXT,
	deadline               INTEGER NOT NULL,
	created_at             INTEGER NOT NULL,
	updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_approval_requests_state ON approval_requests(state, deadline);
CREATE INDEX idx_approval_requests_env ON approval_requests(app_id, env, id);
