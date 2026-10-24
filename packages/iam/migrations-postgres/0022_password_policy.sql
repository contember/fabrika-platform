-- The installation's minimum password length (ADR-0020). Postgres dialect;
-- `../migrations/0022_password_policy.sql` states the same outcome.
--
-- One minimum for every principal of the installation, so this is one row or none: `id` is always 1. An installation
-- administrator sets it through IAM's administration API, which also holds it to the runtime's floor (15 where the
-- verifiers are cheaper than OWASP's PBKDF2 cost); the CHECK is only the widest range any runtime accepts. No row is the
-- default of 15, which every installation applied before this file.
CREATE TABLE password_policy (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	min_length INTEGER NOT NULL CHECK (min_length BETWEEN 4 AND 256),
	updated_at INTEGER NOT NULL
);
