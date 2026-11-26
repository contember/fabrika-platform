-- An agent's `write` grant at an environment whose `agent-write` gate is `passkey` is served only when the person
-- confirmed its approval with a passkey on the device page (ADR-0090 §5). Postgres dialect; `../migrations/0048_agent_write_passkey.sql` states the
-- same outcome.
--
-- `passkey_confirmed_at` is when that passkey answered: set on the device attempt by its approval and copied to the
-- grant at its redemption. NULL, as on every row before this file, means no passkey confirmed it, so an existing
-- `write` grant keeps being served only where the gate is `open`. No upgrade step is needed.
ALTER TABLE oauth_device_authorizations ADD COLUMN passkey_confirmed_at INTEGER;
ALTER TABLE oauth_grants ADD COLUMN passkey_confirmed_at INTEGER;
