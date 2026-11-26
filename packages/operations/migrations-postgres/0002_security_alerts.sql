-- Security alerts on the installation source. Postgres dialect; `../migrations/0002_security_alerts.sql` states the
-- same outcome. Both tables are new, so an existing installation gains them empty: the maintenance pass creates the
-- installation source itself (`origin = 'installation'`), and the defaults apply until an operator saves thresholds.
-- Alerts stay silent until a `security` rule and channel exist on that source.

-- Refused sign-ins within fifteen minutes that raise an alert, per account and installation-wide.
CREATE TABLE security_alert_config (
	source_id              TEXT PRIMARY KEY REFERENCES sources(id),
	account_threshold      INTEGER NOT NULL,
	installation_threshold INTEGER NOT NULL
);

-- How far IAM's sign-in signals have been read, in milliseconds. NULL until a configured pass reads them, and again
-- whenever none is configured, so enabling the alerts later raises nothing for the time before.
CREATE TABLE security_signal_cursor (
	singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
	evaluated_until  BIGINT
);

INSERT INTO security_signal_cursor (singleton, evaluated_until) VALUES (1, NULL);
