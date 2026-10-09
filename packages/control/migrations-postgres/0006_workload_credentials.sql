-- The workload credentials of each application environment (ADR-0022 "Principal kinds"): one IAM-issued `px_` key per
-- job and per webhook of the approved contract, sealed in the vault under
-- `platform:workload-key:<app>@<env>:<kind>:<name>`. This row is the only pointer to that vault entry and names the
-- active key: `credential_id` is IAM's id of it, which every later issuance asks IAM to keep, and `expires_at` (unix
-- seconds) is when IAM stops honouring it, so a reconcile rotates it in time.
CREATE TABLE app_env_workload_credentials (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	kind       TEXT NOT NULL CHECK (kind IN ('job', 'webhook')),
	name       TEXT NOT NULL,
	value_ref     TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	expires_at    INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, kind, name),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
