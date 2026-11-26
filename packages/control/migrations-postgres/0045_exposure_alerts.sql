-- The exposure the maintenance pass last alerted an environment's Operations of (ADR-0043): the provider's findings
-- between deploys, as `exposure` JSON, sorted. A row exists only while that exposure lasts; the pass alerts again only
-- when the findings change, and deletes the row once a check finds none.
CREATE TABLE app_env_exposure_alerts (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	exposure   TEXT NOT NULL,
	alerted_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
