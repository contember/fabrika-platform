-- The language a person reads IAM in, beside the application's (`app_presentation.locale`). SQLite/D1 dialect;
-- `../migrations-postgres/0031_person_locale.sql` states the same outcome.
--
-- An application may name the invited person's language on an invitation (`InvitationOptions.locale`): IAM mails the
-- invitation in it, and its acceptance keeps it as the principal's. A password action keeps the language its mail was
-- written in, so the page its link opens speaks the same one. None of the three is checked here: IAM parses each at
-- read and treats a value it does not speak as not stated. NULL on every row before this file and on one that names
-- none, which keeps the application's language as before.
ALTER TABLE membership_invitations ADD COLUMN locale TEXT;
ALTER TABLE principals ADD COLUMN locale TEXT;
ALTER TABLE password_action_tokens ADD COLUMN locale TEXT;
