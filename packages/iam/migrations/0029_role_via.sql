-- A role's relations (`via`): relation → exact actions a GLOBAL grant of the role also carries as `~rel` entries, which an
-- application holds where one of its rows names the principal in that relation. SQLite/D1 dialect;
-- `../migrations-postgres/0029_role_via.sql` states the same outcome. NULL (every row before this file) is none; only an
-- application-wide internal role reconciled from the application declares one.
ALTER TABLE roles ADD COLUMN via TEXT
	CHECK (via IS NULL OR (member_scope IS NULL AND external = 0 AND origin = 'app'));
