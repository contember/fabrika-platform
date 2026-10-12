-- Durable audit: a logout is an `auth_log` row of its own, and a login of an installation administrator is marked
-- privileged. Postgres dialect; `../migrations/0008_durable_audit.sql` states the same outcome. Every existing row
-- was a login attempt that nobody marked, so the column defaults to 0.
ALTER TABLE auth_log DROP CONSTRAINT auth_log_kind_check;

ALTER TABLE auth_log ADD CONSTRAINT auth_log_kind_check CHECK (kind IN ('authenticate', 'logout'));

ALTER TABLE auth_log ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0 CHECK (privileged IN (0, 1));
