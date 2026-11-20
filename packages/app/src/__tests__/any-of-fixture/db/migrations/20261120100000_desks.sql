-- The cash desks every branch shares, and the entries recorded on them.
CREATE TABLE desks (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	status TEXT NOT NULL,
	audit_note TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE entries (
	id TEXT PRIMARY KEY,
	desk_id TEXT NOT NULL,
	amount INTEGER NOT NULL,
	created_by TEXT NOT NULL
) STRICT;
