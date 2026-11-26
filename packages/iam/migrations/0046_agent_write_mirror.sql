-- IAM serves an agent's `write` grant only where Control's `agent-write` gate lets it (ADR-0090 §5). SQLite/D1 dialect;
-- `../migrations-postgres/0046_agent_write_mirror.sql` states the same outcome.
--
-- `app_grant_approvals.agent_write` is the gate Control mirrors for an application environment (`<app>@<env>`), beside
-- its grant gate and `credentials` mode and under the same protection revision. NULL, as on every row before this file,
-- and no row at all both read as `refuse`: no environment serves a `write` grant until Control has said it may.
-- Control's maintenance pass writes every environment's gate after an upgrade, so an existing installation converges
-- without an operator step.
--
-- `agent_write_revision` is the protection revision the gate was written at. The gate holds only while it equals the
-- row's `revision`: an IAM rolled back below this file moves `revision` without touching `agent_write`, and a stale
-- `open` must not outlive that write once IAM is upgraded again.
ALTER TABLE app_grant_approvals ADD COLUMN agent_write TEXT CHECK (agent_write IN ('open', 'passkey', 'refuse'));
ALTER TABLE app_grant_approvals ADD COLUMN agent_write_revision INTEGER;
