-- An agent's device grant at an application environment (ADR-0090). SQLite/D1 dialect;
-- `../migrations-postgres/0042_agent_grants.sql` states the same outcome. Every change is additive.
--
-- `app_agents` lists the application environments whose reconciled schema admits the caller `agent`: only their
-- return origins are OAuth resources of the agent client. The schema reconcile writes the row in its own batch, so an
-- existing installation gains none until an application deploys a contract that admits `agent`.
CREATE TABLE app_agents (
	app TEXT PRIMARY KEY
);

-- The name the agent gave itself at the device start, carried from the attempt to the grant it becomes. NULL, as on
-- every row before this file, is an agent that gave none, and every grant of another client.
ALTER TABLE oauth_device_authorizations ADD COLUMN agent_label TEXT CHECK (agent_label IS NULL OR length(agent_label) BETWEEN 1 AND 64);
ALTER TABLE oauth_grants ADD COLUMN agent_label TEXT CHECK (agent_label IS NULL OR length(agent_label) BETWEEN 1 AND 64);

-- The agent an application's audit event was made through, read from the caller's verified token: `actor_id` is
-- `oauth:<grant id>` and `actor_label` the agent's label. NULL on every event a person or a key made directly.
ALTER TABLE audit_events ADD COLUMN actor_id TEXT;
ALTER TABLE audit_events ADD COLUMN actor_label TEXT;
