-- IAM serves an agent's `write` grant only where Control's `agent-write` gate lets it (ADR-0090 §5). Postgres dialect;
-- `../migrations/0046_agent_write_mirror.sql` states the same outcome.
--
-- `app_grant_approvals.agent_write` is the gate Control mirrors for an application environment (`<app>@<env>`), beside
-- its grant gate and `credentials` mode and under the same protection revision. NULL, as on every row before this file,
-- and no row at all both read as `refuse`: no environment serves a `write` grant until Control has said it may.
-- Control's maintenance pass writes every environment's gate after an upgrade, so an existing installation converges
-- without an operator step.
ALTER TABLE app_grant_approvals ADD COLUMN agent_write TEXT CHECK (agent_write IN ('open', 'passkey', 'refuse'));
