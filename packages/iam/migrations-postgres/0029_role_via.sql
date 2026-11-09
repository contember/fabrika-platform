-- A role's relations (`via`). Postgres twin of ../migrations/0029_role_via.sql — see that file for the model; the
-- outcome is identical.
ALTER TABLE roles ADD COLUMN via TEXT
	CHECK (via IS NULL OR (member_scope IS NULL AND external = 0 AND origin = 'app'));
