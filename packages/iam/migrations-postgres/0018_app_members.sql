-- The application's own people (`members` and `directory` of the contract's vocabulary). Postgres dialect;
-- `../migrations/0018_app_members.sql` states the same outcome.
--
-- The schema reconcile writes the row in its own batch; an application that declares no `members` has none. A holder
-- of `manage`, globally at the application, grants and revokes the application's global roles through IAM's
-- administration API within its own actions; a holder of `list`, globally, reads every principal holding one of the
-- application's roles (`listAppMembers`). `directory` `labels` shows labels to `list` holders too.
CREATE TABLE app_members (
	app       TEXT PRIMARY KEY,
	manage    TEXT NOT NULL,
	list      TEXT NOT NULL,
	directory TEXT CHECK (directory IS NULL OR directory = 'labels')
);
