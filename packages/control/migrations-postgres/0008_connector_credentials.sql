-- Postgres twin of ../migrations/0008_connector_credentials.sql — see that file for the model; the outcome is identical.
ALTER TABLE app_env_workload_credentials DROP CONSTRAINT app_env_workload_credentials_kind_check;
ALTER TABLE app_env_workload_credentials ADD CONSTRAINT app_env_workload_credentials_kind_check
	CHECK (kind IN ('job', 'webhook', 'app'));
