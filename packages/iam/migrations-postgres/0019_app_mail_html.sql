-- An application's HTML body of an IAM e-mail, beside its subject and text. Postgres dialect;
-- `../migrations/0019_app_mail_html.sql` states the same outcome.
--
-- The closed HTML subset of `mailHtmlTokens` (`@fabrika/auth-core`): IAM checks it at the reconcile and again at render,
-- renders it from its tokens with every value escaped and the action link put in, and falls back to its catalog for a
-- row it refuses. NULL on every row before this file and on one that declares no HTML: IAM builds the HTML part itself.
ALTER TABLE app_mail_templates ADD COLUMN html TEXT;
