-- An application's wording of IAM's e-mails (`mail` in the contract's vocabulary): per message and language, the subject
-- and the plain-text body IAM fills and wraps in its own HTML. Postgres dialect; `../migrations/0013_app_mail_templates.sql`
-- states the same outcome.
--
-- The schema reconcile rewrites an app's rows in its own batch; an app that declares none has no row, and IAM sends its
-- catalog's wording. IAM checks a row again when it renders it and falls back to the catalog for one it refuses.
CREATE TABLE app_mail_templates (
	app     TEXT NOT NULL,
	kind    TEXT NOT NULL,
	locale  TEXT NOT NULL,
	subject TEXT NOT NULL,
	body    TEXT NOT NULL,
	PRIMARY KEY (app, kind, locale)
);
