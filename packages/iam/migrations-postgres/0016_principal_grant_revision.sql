-- The revision of a principal's grants. Postgres dialect; `../migrations/0016_principal_grant_revision.sql`
-- states the same outcome.
--
-- Every write that removes a grant of a principal increments it, as the first statement of its transaction. An
-- invitation's acceptance reads the inviter's before it checks the inviter's live permissions and writes only while it
-- is unchanged, so a removal of ANY grant of the inviter between the check and the write makes the write change
-- nothing. On Postgres the increment takes the principal row first, so it waits for an acceptance holding the row
-- `FOR SHARE`. Every principal before this file starts at 0.
ALTER TABLE principals ADD COLUMN grant_revision INTEGER NOT NULL DEFAULT 0;
