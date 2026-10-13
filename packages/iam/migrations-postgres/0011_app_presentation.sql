-- How IAM names an application to a person (`locale` and `displayName` in the contract's vocabulary), and the
-- application a password action returns to. Postgres dialect; `../migrations/0011_app_presentation.sql`
-- states the same outcome.
--
-- The schema reconcile writes `app_presentation` in its own batch; an app that declares neither field has no row.
-- `locale` is not checked here: IAM parses it at read and falls back to its default for a value it does not speak.
CREATE TABLE app_presentation (
	app          TEXT PRIMARY KEY,
	locale       TEXT,
	display_name TEXT
);

-- The application a forgot-password request came from: its pages and mail speak the application's language, and the
-- completed action lands in it. NULL for an action on the installation itself, which is every row before this file.
ALTER TABLE password_action_tokens ADD COLUMN app TEXT;
