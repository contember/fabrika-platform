-- External principals and the roles they may hold (ADR-0051).
-- Postgres dialect; `../migrations/0012_external_principals.sql` states the same outcome.
--
-- A user is `internal` (every row written before this file) or `external`, a person from outside the organization;
-- a service is always `internal`. An external principal holds only grants of a role its application declares
-- `external`, which only a membership role reconciled from the application may be.
ALTER TABLE principals ADD COLUMN affiliation TEXT NOT NULL DEFAULT 'internal'
	CHECK (affiliation IN ('internal', 'external') AND (affiliation = 'internal' OR type = 'user'));
ALTER TABLE roles ADD COLUMN external INTEGER NOT NULL DEFAULT 0
	CHECK (external IN (0, 1) AND (external = 0 OR (member_scope IS NOT NULL AND origin = 'app')));
