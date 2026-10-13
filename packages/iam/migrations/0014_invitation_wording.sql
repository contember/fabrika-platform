-- What an invitation by address carries besides its role: the invited person's company as the inviting application
-- names it, and the inviter's personal message. SQLite/D1 dialect; `../migrations-postgres/0014_invitation_wording.sql`
-- states the same outcome.
--
-- Both are plain text IAM puts into the invitation's e-mail (`{{companyLabel}}`, `{{message}}`), escaped in its HTML
-- part, and keeps for a resend. NULL on every invitation before this file and on one that names neither.
ALTER TABLE membership_invitations ADD COLUMN company_label TEXT;
ALTER TABLE membership_invitations ADD COLUMN message TEXT;
