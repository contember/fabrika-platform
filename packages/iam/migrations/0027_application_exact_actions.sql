-- A contract application's authority is exact actions of its approved catalog (the authorization model's Layer 1):
-- from this release IAM resolves no wildcard at a contract application, so a pattern can no longer track the catalog
-- beyond the approved revision. Writes have refused one since 0003; this file is the preflight for rows older than
-- that. SQLite/D1 dialect; `../migrations-postgres/0027_application_exact_actions.sql` states the same outcome.
--
-- No outcome would be correct for such a row: dropping it loses authority, expanding it guesses which revision it
-- meant. So the file REFUSES while one exists — an inline grant or a role of the app that names a pattern, a grant of
-- the built-in `admin`, or a key's frozen pattern — and the deploy stops with the old release serving. Resolve each
-- row with exact actions (or remove it), then deploy again. Expired rows count too.
CREATE TABLE IF NOT EXISTS iam_preflight_exact_actions (
	app TEXT,
	CONSTRAINT "contract app holds a wildcard: give it exact actions first"
		CHECK (app IS NULL)
);

INSERT INTO iam_preflight_exact_actions (app)
	SELECT g.app FROM grants g JOIN contract_apps c ON c.app = g.app
	WHERE g.permissions LIKE '%*%' OR g.role_key = 'admin';

INSERT INTO iam_preflight_exact_actions (app)
	SELECT r.app FROM roles r JOIN contract_apps c ON c.app = r.app
	WHERE r.permissions LIKE '%*%';

INSERT INTO iam_preflight_exact_actions (app)
	SELECT k.app FROM credential_grants cg JOIN credentials k ON k.id = cg.credential_id JOIN contract_apps c ON c.app = k.app
	WHERE cg.action LIKE '%*%';

DROP TABLE iam_preflight_exact_actions;
