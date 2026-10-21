-- The identification page of an application that identifies people at enrolled terminals (`terminal` of the
-- contract's vocabulary, ADR-0067). Postgres dialect; `../migrations/0024_app_terminals.sql` states the same outcome.
--
-- The schema reconcile writes the row in its own batch; an application that declares no terminal has none, and IAM
-- never sends a terminal's browser to it. `identify` is an absolute path on the application's own origin, which IAM
-- resolves against the sign-in's return origin.
CREATE TABLE app_terminals (
	app      TEXT PRIMARY KEY,
	identify TEXT NOT NULL CHECK (identify LIKE '/%')
);
