-- The membership transport key of each application environment that has no IAM service binding (ADR-0022 rule 6): one
-- IAM-issued `px_` key, sealed in the vault under `platform:membership-key:<app>@<env>`, issued only while the approved
-- contract has a membership or share-link operation. This row is the only pointer to that vault entry and names the
-- active key: `key_id` is IAM's id of it, which every later issuance asks IAM to keep, and `expires_at` (unix seconds) is
-- when IAM stops honouring it, so a reconcile rotates it in time.
CREATE TABLE app_env_membership_keys (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	value_ref  TEXT NOT NULL,
	key_id     TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
