-- ADR-0090 §5: IAM's mirror now carries each environment's `agent-write` gate beside its grant gate and `credentials`
-- mode. Postgres dialect; `../migrations/0047_iam_gate_mirrors_agent_write.sql` states the same outcome.
--
-- An environment IAM took at its current revision before this release holds no `agent-write` gate there, which IAM reads
-- as `refuse`. Forgetting every acknowledgement makes the maintenance pass write every environment's gates once more,
-- so an existing installation converges without an operator step; the rows are a cache, and IAM keeps a later revision.
DELETE FROM iam_gate_mirrors;
