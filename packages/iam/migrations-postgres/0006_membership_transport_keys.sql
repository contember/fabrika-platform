-- Membership transport keys. Postgres twin of ../migrations/0006_membership_transport_keys.sql — see that file for the
-- model; the outcome is identical.

CREATE TABLE membership_transport_keys (
	id         TEXT PRIMARY KEY,
	app        TEXT NOT NULL,
	key_hash   TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX membership_transport_keys_app ON membership_transport_keys (app);
