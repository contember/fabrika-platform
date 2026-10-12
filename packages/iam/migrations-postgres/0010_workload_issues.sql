-- The link mount a job may issue links of (`issues: '<mount>'` on its `c.cron`, read from the approved artifact).
-- Postgres dialect; `../migrations/0010_workload_issues.sql` states the same outcome.
--
-- `issueLink` and `revokeLink` accept a job's token only while its row here names the mount; every other membership
-- operation still refuses a workload. NULL for a job that issues nothing, and always for a webhook or a connector.
ALTER TABLE app_workloads ADD COLUMN issues TEXT CHECK (issues IS NULL OR kind = 'job');
