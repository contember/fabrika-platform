-- A public procedure is a workload of its own (`public`, named by its endpoint id). Postgres dialect;
-- `../migrations/0020_public_workloads.sql` states the same outcome. Every existing row keeps its kind.
ALTER TABLE workload_principals DROP CONSTRAINT workload_principals_kind_check;

ALTER TABLE workload_principals ADD CONSTRAINT workload_principals_kind_check CHECK (kind IN ('job', 'webhook', 'public', 'app'));

ALTER TABLE app_workloads DROP CONSTRAINT app_workloads_kind_check;

ALTER TABLE app_workloads ADD CONSTRAINT app_workloads_kind_check CHECK (kind IN ('job', 'webhook', 'public', 'app'));
