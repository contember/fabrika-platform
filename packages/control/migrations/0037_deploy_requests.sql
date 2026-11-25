-- ADR-0083 §2: the approval settings beside the modes (`deployRequestCommits`, `requestTtlHours`, `approvers` per
-- category) that differ from the defaults, as a JSON object; NULL is the defaults. Kept with the flag beyond the
-- environment's deletion.
ALTER TABLE app_envs ADD COLUMN approval_settings TEXT;
ALTER TABLE app_env_protection ADD COLUMN approval_settings TEXT;
-- ADR-0050 §4: whether a manual run was started by a person in the console (1) or by a bearer (0); NULL for every other
-- run and for a manual run created before the column, which reads as its actor did.
ALTER TABLE runs ADD COLUMN by_person INTEGER;
-- A non-person's manual run of a protected environment: who asked and the commit's message, as JSON; NULL otherwise.
ALTER TABLE runs ADD COLUMN request_json TEXT;
-- Why the run waits: `requested` when it waits because a non-person asked for it; NULL when its lines decided.
ALTER TABLE runs ADD COLUMN park_reason TEXT;
-- When a parked run expires unless a person decided it (unix seconds); NULL until it parks, and for a run parked before
-- the column until maintenance first sees it.
ALTER TABLE runs ADD COLUMN approval_deadline INTEGER;
-- The first of two approvals (`approvers: 2`), bound to the digests it was given for; NULL otherwise.
ALTER TABLE runs ADD COLUMN partial_approval_json TEXT;
-- Why a run failed without deploying: `rejected` by a person or `expired` past its deadline; NULL otherwise.
ALTER TABLE runs ADD COLUMN failure_cause TEXT;
