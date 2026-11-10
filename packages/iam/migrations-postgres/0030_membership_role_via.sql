-- A membership role may hold actions through a relation (`via`). Postgres twin of
-- ../migrations/0030_membership_role_via.sql — see that file for the model; the outcome is identical. 0029 stated the
-- check on the column without a name, and Postgres named it `roles_check1` (after 0012's `roles_check`); every
-- installation applied the same files in the same order, so the name is the same everywhere. The new one is named.
ALTER TABLE roles DROP CONSTRAINT roles_check1;
ALTER TABLE roles ADD CONSTRAINT roles_via_check
	CHECK (via IS NULL OR (external = 0 AND origin = 'app'));
