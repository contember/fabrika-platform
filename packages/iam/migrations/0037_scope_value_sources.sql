-- The procedure IAM asks, as the administrator, for a dimension's values (ADR-0085 §4). SQLite/D1 dialect;
-- `../migrations-postgres/0037_scope_value_sources.sql` states the same outcome.
--
-- A JSON object { endpoint, path, action }; NULL names none, which is every scope reconciled before this file, so the
-- console keeps the listed values or free text for them until the application's next deploy reconciles a source.
ALTER TABLE app_scopes ADD COLUMN value_source TEXT;
