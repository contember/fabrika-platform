-- A membership role may hold actions through a relation (`via`): a grant of it at a value carries them as `~relin`
-- entries, held only inside that value. SQLite/D1 dialect; `../migrations-postgres/0030_membership_role_via.sql` states
-- the same outcome. The column's CHECK no longer requires `member_scope IS NULL`; an external role still declares no
-- `via` (ADR-0051). SQLite changes a column's CHECK only by dropping the column, so the values are carried over through
-- a scratch column. No row changes: every row satisfied the stricter CHECK.
ALTER TABLE roles ADD COLUMN via_0030 TEXT;
UPDATE roles SET via_0030 = via;
ALTER TABLE roles DROP COLUMN via;
ALTER TABLE roles ADD COLUMN via TEXT
	CHECK (via IS NULL OR (external = 0 AND origin = 'app'));
UPDATE roles SET via = via_0030;
ALTER TABLE roles DROP COLUMN via_0030;
