-- The membership transport keys of applications on a runtime without an IAM service binding (Zerops). SQLite/D1
-- dialect; `../migrations-postgres/0006_membership_transport_keys.sql` states the same outcome.
--
-- A key authenticates `POST /membership/<method>` and pins the IAM application id `<app>@<env>` every call acts for.
-- It is no principal and no `credentials` row, so no path that resolves a `px_` credential can find it: it mints no
-- token and carries no authority. Only the SHA-256 hash is stored; a row exists only while the key is live, and an
-- issuance or a reconcile that leaves the app without a membership operation deletes the rows it supersedes.
CREATE TABLE membership_transport_keys (
	id         TEXT PRIMARY KEY,
	app        TEXT NOT NULL,
	key_hash   TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX membership_transport_keys_app ON membership_transport_keys (app);
