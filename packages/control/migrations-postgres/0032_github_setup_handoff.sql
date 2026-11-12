-- The SHA-256 of the handoff token an administrator minted for a setup attempt, so an organization owner without a
-- console session can create and install the App from their own browser. Null when no link was minted; the link works
-- only while the attempt waits for the manifest callback.
ALTER TABLE github_source_setup_attempts ADD COLUMN handoff_token_hash TEXT;
