-- A dimension's member directory (`directory: 'labels'` in the contract's vocabulary). SQLite/D1 dialect;
-- `../migrations-postgres/0007_member_directory.sql` states the same outcome.
--
-- `listMembers` shows a user's label (its spelling of its address) to a holder of `members.manage` only, unless the
-- dimension declares `labels` here: then every holder of `members.list` sees it too. Emails and invitations stay with
-- `members.manage`.
ALTER TABLE app_scopes ADD COLUMN members_directory TEXT CHECK (members_directory IS NULL OR members_directory = 'labels');
