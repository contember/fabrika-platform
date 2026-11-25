-- ADR-0050 §5: the passkey a decision of an approval request was confirmed with, when deciding it took a step-up: its
-- WebAuthn credential id and when IAM verified the assertion (unix seconds). For the first of two approvals and for the
-- decision; NULL when it took none, and for every row decided before the columns.
ALTER TABLE approval_requests ADD COLUMN partial_step_up_credential_id TEXT;
ALTER TABLE approval_requests ADD COLUMN partial_step_up_at INTEGER;
ALTER TABLE approval_requests ADD COLUMN decided_step_up_credential_id TEXT;
ALTER TABLE approval_requests ADD COLUMN decided_step_up_at INTEGER;
