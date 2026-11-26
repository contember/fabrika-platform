-- SCIM 2.0 provisioning of users by the organization's identity provider (ADR-0091). Postgres dialect;
-- `../migrations/0044_scim_provisioning.sql` states the same outcome. Every change is additive.
--
-- `scim_tokens` holds the installation's one SCIM bearer token, or none: `id` is always 1. An installation
-- administrator creates and rotates it through IAM's administration API; only its SHA-256 hash is stored, and the
-- plaintext is shown once. No row is no token, and every SCIM request is then refused.
CREATE TABLE scim_tokens (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	token_id   TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

-- A user the identity provider manages: its SCIM resource id is the principal's id. `user_name_key` is `user_name`
-- as IAM compares it (SCIM's userName is case-insensitive), computed by IAM, never by the engine. The mailbox stays in
-- `principals.email`; these columns are what the provider sent and nothing reads them for authorization. A deleted
-- user keeps its row with `deleted_at`, so the provider no longer finds it and a later POST of the same mailbox
-- links the same principal again. A principal no row names has never been provisioned.
CREATE TABLE scim_users (
	principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	user_name     TEXT NOT NULL CHECK (length(user_name) BETWEEN 1 AND 256),
	user_name_key TEXT NOT NULL,
	external_id   TEXT CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 256),
	display_name  TEXT CHECK (display_name IS NULL OR length(display_name) <= 256),
	given_name    TEXT CHECK (given_name IS NULL OR length(given_name) <= 256),
	family_name   TEXT CHECK (family_name IS NULL OR length(family_name) <= 256),
	deleted_at    INTEGER,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX scim_users_uq_user_name ON scim_users (user_name_key) WHERE deleted_at IS NULL;
CREATE INDEX scim_users_external_id ON scim_users (external_id) WHERE deleted_at IS NULL;
