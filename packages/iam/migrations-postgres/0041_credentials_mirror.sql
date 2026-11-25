-- IAM's own key issuance meets an environment's `credentials` mode (ADR-0083 §8). Postgres dialect;
-- `../migrations/0041_credentials_mirror.sql` states the same outcome.
--
-- `app_grant_approvals.credentials` is the mode Control mirrors for an application environment (`<app>@<env>`), beside
-- its grant gate and under the same protection revision. NULL, as on every row before this file, and no row at all both
-- read as `person`: a machine caller issues no key at an environment whose mode IAM has not been told. Control's cron
-- writes every environment's mode after an upgrade, so an existing installation converges without an operator step.
ALTER TABLE app_grant_approvals ADD COLUMN credentials TEXT CHECK (credentials IN ('off', 'person', 'refuse'));
