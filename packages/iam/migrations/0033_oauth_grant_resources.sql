-- An OAuth grant given for several resources of one app. SQLite/D1 dialect;
-- `../migrations-postgres/0033_oauth_grant_resources.sql` states the same outcome.
--
-- `resources` is a JSON array of every resource the grant covers; each token it mints names one of them. NULL keeps
-- the meaning every earlier grant has: `resource` is the only one.
ALTER TABLE oauth_grants ADD COLUMN resources TEXT;
