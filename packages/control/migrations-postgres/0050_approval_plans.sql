-- ADR-0050 §5: an approval plan, the access change of a commit not yet deployed, compared with what the environment
-- published when it was made, and decided by a person in the console. The plan row is the record of authority: the
-- commit, the two snapshot digests, the lines the approver saw, who asked and who decided. A `pending` plan past its
-- deadline reads as expired; nothing rewrites it. No foreign key to the registry: the record outlives its environment.
CREATE TABLE approval_plans (
	id                            TEXT PRIMARY KEY,
	app_id                        TEXT NOT NULL,
	env                           TEXT NOT NULL,
	commit_sha                    TEXT NOT NULL,
	requester_id                  TEXT NOT NULL,
	requester_type                TEXT NOT NULL,
	requester_label               TEXT NOT NULL,
	requester_credential          TEXT NOT NULL CHECK (requester_credential IN ('oauth', 'key', 'console')),
	requester_client_id           TEXT,
	requester_grant_id            TEXT,
	outcome                       TEXT NOT NULL CHECK (outcome IN ('none', 'no-widening', 'widening')),
	changes_json                  TEXT NOT NULL,
	candidate_digest              TEXT NOT NULL,
	baseline_digest               TEXT NOT NULL,
	baseline_run_id               TEXT,
	state                         TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'revoked')),
	partial_approver_id           TEXT,
	partial_approver_label        TEXT,
	partial_approved_at           INTEGER,
	partial_step_up_credential_id TEXT,
	partial_step_up_at            INTEGER,
	decided_by_id                 TEXT,
	decided_by_label              TEXT,
	decided_at                    INTEGER,
	decided_step_up_credential_id TEXT,
	decided_step_up_at            INTEGER,
	revoked_by_id                 TEXT,
	revoked_by_label              TEXT,
	revoked_at                    INTEGER,
	deadline                      INTEGER NOT NULL,
	expires_at                    INTEGER,
	created_at                    INTEGER NOT NULL,
	updated_at                    INTEGER NOT NULL
);
CREATE INDEX idx_approval_plans_state ON approval_plans(state, deadline);
CREATE INDEX idx_approval_plans_env ON approval_plans(app_id, env, id);
-- One entry per subject a plan's change touches: the SHA-256 of the subject's fragment in the baseline and in the
-- candidate, and the digests of the lines the approver saw for it. A publication it covers consumes it in the
-- publication's own compare-and-swap, so an entry covers one publication at most.
CREATE TABLE approval_plan_entries (
	id              TEXT PRIMARY KEY,
	plan_id         TEXT NOT NULL REFERENCES approval_plans(id),
	app_id          TEXT NOT NULL,
	env             TEXT NOT NULL,
	subject         TEXT NOT NULL,
	before_hash     TEXT NOT NULL,
	after_hash      TEXT NOT NULL,
	lines_json      TEXT NOT NULL,
	state           TEXT NOT NULL CHECK (state IN ('pending', 'active', 'consumed', 'revoked')),
	expires_at      INTEGER,
	consumed_by_run TEXT,
	consumed_at     INTEGER
);
CREATE INDEX idx_approval_plan_entries_cover ON approval_plan_entries(app_id, env, state, subject);
CREATE INDEX idx_approval_plan_entries_plan ON approval_plan_entries(plan_id);
