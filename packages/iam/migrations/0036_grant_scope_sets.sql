-- A grant holds a set of values of one dimension, one row per value (ADR-0085). SQLite/D1 dialect;
-- `../migrations-postgres/0036_grant_scope_sets.sql` states the same outcome.
--
-- The rows of a grant with more than one value share `scope_set`, the grant's id. NULL is a grant of one value, which
-- is every grant written before this file, so each of them stays the grant it was and resolves as before.
ALTER TABLE grants ADD COLUMN scope_set TEXT;
CREATE INDEX idx_grants_scope_set ON grants(scope_set);

-- The values a dimension lists for the console, a JSON array of { value, label? }; NULL lists none.
ALTER TABLE app_scopes ADD COLUMN value_list TEXT;

-- Every value a waiting grant change asks for (ADR-0083), a JSON array, when it asks for more than one; `scope_value`
-- keeps the first. NULL is a request of one value or none, which is every request written before this file.
ALTER TABLE grant_requests ADD COLUMN scope_values TEXT;
