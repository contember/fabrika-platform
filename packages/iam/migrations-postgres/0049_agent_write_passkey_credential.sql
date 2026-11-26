-- Which passkey confirmed an agent's `write` grant (ADR-0090 §5), for the person's account page, the grant's record and
-- an administrator's passkey reset, which revokes the grants a removed passkey confirmed. Postgres dialect;
-- `../migrations/0049_agent_write_passkey_credential.sql` states the same outcome.
--
-- `passkey_credential_id` is the WebAuthn credential id (`passkeys.credential_id`) of the passkey that answered: set on
-- the device attempt with `passkey_confirmed_at` by its approval and copied to the grant at its redemption. It is no
-- foreign key: the grant keeps naming a passkey the person later removed. NULL with `passkey_confirmed_at` set marks a
-- grant confirmed before this file, by a passkey nobody recorded; a reset revokes those too. No upgrade step is needed.
ALTER TABLE oauth_device_authorizations ADD COLUMN passkey_credential_id TEXT;
ALTER TABLE oauth_grants ADD COLUMN passkey_credential_id TEXT;
