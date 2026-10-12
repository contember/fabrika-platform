-- The actions that look up one member of a dimension (`findMember`), from the endpoints on, in or below it that the
-- approved contract records under `directories`. Postgres dialect; `../migrations/0009_member_lookups.sql` states the
-- same outcome.
--
-- A JSON array of exact actions, or NULL for none. IAM answers a lookup only for one of them, held on the directory's
-- value itself, so the application names no containment IAM would have to trust.
ALTER TABLE app_scopes ADD COLUMN members_lookup TEXT;
