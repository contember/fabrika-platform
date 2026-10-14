-- When each person last signed in to each application. SQLite/D1 dialect; `../migrations-postgres/0017_app_sign_ins.sql`
-- states the same outcome.
--
-- A sign-in to an application is the redemption of its handoff code: the child session it opens writes this row in
-- its own batch. IAM answers it, as `lastSignInAt`, only to a holder of `members.manage` (it is personal data, like an
-- address). It is not pruned with `auth_log`, and it goes with its principal. Empty for every sign-in before this file.
CREATE TABLE app_sign_ins (
	app          TEXT NOT NULL,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	signed_in_at INTEGER NOT NULL,
	PRIMARY KEY (app, principal_id)
);
