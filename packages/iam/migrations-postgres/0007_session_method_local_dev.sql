-- The local-dev bypass becomes an authentication method of its own. Postgres twin of
-- ../migrations/0013_session_method_local_dev.sql — see that file for why.
--
-- Postgres replaces a CHECK in place, so there is no table rebuild and `auth_codes` is untouched.
-- The two constraint names are the ones 0003 left behind: a column CHECK added with the column, and
-- the table CHECK added on its own. Both are dropped before the backfill, because the backfill writes
-- a value the old enum refuses.

ALTER TABLE sessions DROP CONSTRAINT sessions_authentication_method_check;
ALTER TABLE sessions DROP CONSTRAINT sessions_check;

-- `local-dev-admin` is the bypass's fixed subject and no IdP emits it, so this names exactly the rows
-- the bypass minted and guesses about none of the others.
UPDATE sessions SET authentication_method = 'local_dev' WHERE idp_sub = 'local-dev-admin';

ALTER TABLE sessions ADD CONSTRAINT sessions_authentication_method_check
	CHECK (authentication_method IN ('oidc', 'password', 'local_dev'));
ALTER TABLE sessions ADD CONSTRAINT sessions_method_subject_check CHECK (
	(authentication_method IN ('oidc', 'local_dev') AND idp_sub IS NOT NULL)
	OR (authentication_method = 'password' AND idp_sub IS NULL)
);
