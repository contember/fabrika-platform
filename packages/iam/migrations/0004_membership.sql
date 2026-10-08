-- Membership, delegation grants and share links for multi-tenant applications (A12). SQLite/D1 dialect;
-- `../migrations-postgres/0004_membership.sql` states the same outcome. Every row written before this
-- file keeps NULL in each new column, which is what an app without the declarations means.

-- What a contract compiles into its schema: a dimension's container, its creator role and the actions
-- that manage and list its members; who may assign a membership role (JSON array of role keys).
ALTER TABLE app_scopes ADD COLUMN parent_scope TEXT;
ALTER TABLE app_scopes ADD COLUMN creator_role TEXT;
ALTER TABLE app_scopes ADD COLUMN members_manage TEXT;
ALTER TABLE app_scopes ADD COLUMN members_list TEXT;
ALTER TABLE roles ADD COLUMN assignable_by TEXT;

-- Share-link mounts. `grants` is a JSON array of exact actions, like `roles.permissions`.
CREATE TABLE app_link_mounts (
	app       TEXT NOT NULL,
	mount     TEXT NOT NULL,
	dimension TEXT NOT NULL,
	grants    TEXT NOT NULL,
	issued_by TEXT NOT NULL,
	max_days  INTEGER NOT NULL CHECK (max_days > 0),
	PRIMARY KEY (app, mount)
);

-- The endpoints whose requests may spend the caller's membership authority through a delegation grant.
CREATE TABLE app_delegated_endpoints (
	app       TEXT NOT NULL,
	endpoint  TEXT NOT NULL,
	action    TEXT NOT NULL,
	dimension TEXT NOT NULL,
	purpose   TEXT NOT NULL CHECK (purpose IN ('members', 'creates')),
	PRIMARY KEY (app, endpoint)
);

-- A value IAM created for an app. Membership itself is ordinary role grants scoped to the value; this
-- row records who created it and is the row a revoke locks, so two concurrent revokes cannot each
-- remove one of the last two holders of the creator role.
CREATE TABLE membership_scopes (
	app         TEXT NOT NULL,
	scope_type  TEXT NOT NULL,
	scope_value TEXT NOT NULL,
	created_by  TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at  INTEGER NOT NULL,
	PRIMARY KEY (app, scope_type, scope_value)
);

-- Single-use delegation grants (ADR-0022 rule 6): bound to one caller, one endpoint and one request,
-- stored only as a hash and spent by a conditional UPDATE, like `auth_codes`.
CREATE TABLE delegation_grants (
	id           TEXT PRIMARY KEY,
	grant_hash   TEXT NOT NULL UNIQUE,
	app          TEXT NOT NULL,
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	endpoint     TEXT NOT NULL,
	request_id   TEXT NOT NULL,
	expires_at   INTEGER NOT NULL,
	consumed_at  INTEGER,
	created_at   INTEGER NOT NULL
);

CREATE INDEX idx_delegation_grants_expires ON delegation_grants(expires_at);

-- An invitation to a membership role in one value, accepted only by the verified owner of `email` (the
-- normalized mailbox). The one-time token travels in the invitation email and only its hash is kept.
CREATE TABLE membership_invitations (
	id          TEXT PRIMARY KEY,
	token_hash  TEXT NOT NULL UNIQUE,
	app         TEXT NOT NULL,
	scope_type  TEXT NOT NULL,
	scope_value TEXT NOT NULL,
	role_key    TEXT NOT NULL,
	email       TEXT NOT NULL,
	invited_by  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	expires_at  INTEGER NOT NULL,
	accepted_at INTEGER,
	accepted_by TEXT REFERENCES principals(id) ON DELETE SET NULL,
	-- Set by the one acceptance that won; the grant is written only for the attempt that holds it.
	acceptance_id TEXT UNIQUE,
	revoked_at  INTEGER,
	created_at  INTEGER NOT NULL
);

-- One open invitation per (value, role, mailbox), so repeating an invitation answers the same one. The
-- predicate must stay character-for-character equal to the Postgres set (`ON CONFLICT` infers from it).
CREATE UNIQUE INDEX idx_membership_invitations_open
	ON membership_invitations(app, scope_type, scope_value, role_key, email)
	WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_membership_invitations_expires ON membership_invitations(expires_at);

-- A share link is an anonymous credential bound to a link mount and the containment chain of its object
-- (a JSON array of `{type, value}`, the object first). NULL on every other credential.
ALTER TABLE credentials ADD COLUMN link_mount TEXT;
ALTER TABLE credentials ADD COLUMN link_dimension TEXT;
ALTER TABLE credentials ADD COLUMN link_chain TEXT;
