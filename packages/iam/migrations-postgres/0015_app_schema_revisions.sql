-- The revision of an application's reconciled schema and policies. Postgres dialect;
-- `../migrations/0015_app_schema_revisions.sql` states the same outcome.
--
-- Every schema reconcile and every custom-policy write of the app increments it in its own transaction, as its first
-- statement. An invitation's acceptance reads it before it checks the inviter's authority and writes only while it is
-- unchanged, so a reconcile between the check and the write makes the write change nothing. On Postgres the
-- acceptance holds the row `FOR SHARE` to its commit, and a reconcile's increment waits for it.
CREATE TABLE app_schema_revisions (
	app      TEXT PRIMARY KEY,
	revision INTEGER NOT NULL
);

-- Every application IAM already holds a schema or a policy of starts at revision 1.
INSERT INTO app_schema_revisions (app, revision)
	SELECT app, 1 FROM (SELECT app FROM roles UNION SELECT app FROM app_scopes UNION SELECT app FROM app_actions) known;
