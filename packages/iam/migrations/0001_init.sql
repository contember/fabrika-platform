-- IAM schema — SQLite/D1 dialect. `../migrations-postgres/0001_init.sql` states the same schema for
-- Postgres; add every later change to both sets.
--
-- Two concerns with opposite characteristics live here:
--   * policies — mutable current state, read on every request.
--   * audit    — append-only history, written often, read rarely.
-- They are distinct table groups (logical separation, one D1) with different
-- retention: prune `auth_log` after weeks, keep `audit_events` long.
--
-- All self-owned string ids are UUIDv7 (time-sortable), generated in-Worker —
-- the TEXT id columns are never filled by SQL. `auth_log` is the one exception:
-- it uses a plain INTEGER rowid (densest table, cheapest insert, never FK'd) —
-- and deliberately NOT AUTOINCREMENT (the more expensive variant, no benefit here).
--
-- Timestamps (`created_at`, unix seconds) are NOT NULL with NO default: the writer
-- always binds them. `unixepoch()` does not exist in Postgres, so a DDL default would
-- pin this schema to SQLite; binding caller-side is the repo convention anyway (see
-- the root CLAUDE.md and @fabrika/platform's `sql.ts`).

-- ── Policies ────────────────────────────────────────────────────────────────

CREATE TABLE principals (
	id           TEXT PRIMARY KEY,                 -- UUIDv7, ours; STABLE — grants & audit reference this, never external_id
	type         TEXT NOT NULL CHECK (type IN ('user','service')),
	external_id  TEXT,                             -- IdP `sub` (user) / client_id (service). NULL = user INVITED, not yet claimed
	email        TEXT,                             -- users: the NORMALIZED mailbox, invite-match key + label source; NULL for services
	label        TEXT NOT NULL,                    -- email / token name, human-readable
	disabled_at  INTEGER,                          -- soft-disable, NULL = active
	created_at   INTEGER NOT NULL,                 -- unix seconds, bound by the writer (no DDL default — see header)
	activated_at INTEGER                           -- set once a user claims (OIDC) or enrolls a password; services at creation
);

-- Status is derived: invited (external_id IS NULL) → claimed/active → disabled (disabled_at set).
-- external_id is NULL for invited-not-yet-claimed users, so a plain UNIQUE(type, external_id)
-- would treat those NULLs as distinct. Partial unique indexes (same pattern as grants):
CREATE UNIQUE INDEX idx_principals_uq_external ON principals(type, external_id)
	WHERE external_id IS NOT NULL;
-- At most one user principal per email (the invite target, then the claimed identity):
CREATE UNIQUE INDEX idx_principals_uq_email ON principals(email)
	WHERE type = 'user' AND email IS NOT NULL;

-- The seeded PROVISIONING identity. `resolveCaller` (src/auth.ts) resolves a bearer matching the
-- FABRIKA_IAM_PROVISIONING_KEY secret to a synthetic global admin with this id; the row exists so the
-- audit that key drives resolves its principal_id FK. A migration cannot bind a parameter, so
-- `created_at` is a fixed literal.
INSERT INTO principals (id, type, external_id, email, label, disabled_at, created_at, activated_at)
	VALUES ('provisioning-admin', 'service', NULL, NULL, 'provisioning', NULL, 1782561600, 1782561600);

-- Reserves a normalized mailbox for exactly one user principal.
CREATE TABLE principal_email_claims (
	normalized_email TEXT PRIMARY KEY,
	principal_id     TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE
);

-- ── App-declared vocabulary (reconciled from each app's code) ───────────────

-- The scope DIMENSIONS an app understands. Opaque to authz (scope matching is string equality); this
-- exists so the admin UI offers a real dropdown per app.
CREATE TABLE app_scopes (
	app        TEXT NOT NULL,
	scope_type TEXT NOT NULL,                       -- 'organization' | 'team' | 'project' | …
	label      TEXT,                                -- human label for the admin UI
	PRIMARY KEY (app, scope_type)
);

-- The ACTION CATALOG per app — every concrete action the app authorizes against.
CREATE TABLE app_actions (
	app         TEXT NOT NULL,
	action      TEXT NOT NULL,                      -- concrete action, e.g. 'project.read'
	description TEXT,
	PRIMARY KEY (app, action)
);

-- Named permission BUNDLES. JSON validity is NOT a DB constraint: `json_valid()` is SQLite-only and
-- `IS JSON` is Postgres-only, so the only writer JSON-encodes and every reader goes through
-- `parseJsonOrNull` (src/json.ts).
CREATE TABLE roles (
	app         TEXT NOT NULL,
	role_key    TEXT NOT NULL,
	name        TEXT NOT NULL,
	description TEXT,
	permissions TEXT NOT NULL,                                     -- JSON array of action patterns
	origin      TEXT NOT NULL CHECK (origin IN ('app', 'custom')),  -- 'app'=reconciled from code, 'custom'=admin-made
	created_at  INTEGER NOT NULL,
	PRIMARY KEY (app, role_key)
);

-- Return origins an app registered for the cross-host session handoff (ADR-0021).
CREATE TABLE app_return_origins (
	app        TEXT NOT NULL,
	origin     TEXT NOT NULL, -- canonical scheme://host[:port], lower-cased, no trailing slash
	created_at INTEGER NOT NULL,
	PRIMARY KEY (app, origin)
);

-- ── grants ──────────────────────────────────────────────────────────────────
--
-- Scope is the generic, flat (scope_type, scope_value) pair. A grant is EITHER role-based OR inline,
-- never both, never neither. role_key is deliberately NOT FK'd to roles(app, role_key): a grant may
-- set app=NULL (cross-app) while a role row always has a concrete app.
CREATE TABLE grants (
	id           TEXT PRIMARY KEY,                  -- UUIDv7
	principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	app          TEXT,                              -- NULL = all apps (cross-app, e.g. super-admin)
	role_key     TEXT,                              -- named role/policy; XOR permissions
	permissions  TEXT,                              -- inline action set (JSON array); XOR role_key. No json_valid CHECK — see roles above.
	scope_type   TEXT,                              -- NULL = global (all scopes)
	scope_value  TEXT,                              -- opaque, app-owned; NULL = global
	granted_by   TEXT REFERENCES principals(id),
	expires_at   INTEGER,                           -- NULL = permanent
	created_at   INTEGER NOT NULL,
	CHECK ((role_key IS NULL) <> (permissions IS NULL)),  -- exactly one of role_key / inline permissions
	CHECK ((scope_type IS NULL) = (scope_value IS NULL))  -- scope is both-or-neither
);

-- `ON CONFLICT` infers its target from the index predicate + expression list, so these must stay
-- character-for-character equal to the Postgres set. They constrain ONLY role-based grants. NULL app
-- folds to '*' because raw NULLs compare as distinct in a unique index.
CREATE UNIQUE INDEX idx_grants_uq_scoped ON grants(principal_id, role_key, scope_type, scope_value, COALESCE(app, '*'))
	WHERE role_key IS NOT NULL AND scope_value IS NOT NULL;
CREATE UNIQUE INDEX idx_grants_uq_global ON grants(principal_id, role_key, COALESCE(app, '*'))
	WHERE role_key IS NOT NULL AND scope_value IS NULL;
CREATE INDEX idx_grants_principal ON grants(principal_id);

-- ── Credentials (unified opaque API keys / share links) ─────────────────────
--
-- An opaque `px_` secret (only its SHA-256 hash kept) resolved into a short signed access token.
-- principal_id set → the credential carries that principal's LIVE permissions; principal_id NULL → an
-- anonymous credential whose FROZEN inline grants, bound to `app`, are the whole permission set.
CREATE TABLE credentials (
	id           TEXT PRIMARY KEY,                  -- UUIDv7, ours
	token_hash   TEXT NOT NULL UNIQUE,              -- SHA-256 of the opaque `px_` secret; never plaintext
	label        TEXT,                              -- human-readable, e.g. 'opice CI — ingest'
	principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE, -- NULL = anonymous (frozen inline grants)
	issued_by    TEXT REFERENCES principals(id),    -- resolved server-side at issue, never self-asserted
	expires_at   INTEGER,                           -- absolute expiry (unix seconds); NULL = no expiry
	revoked_at   INTEGER,                           -- explicit revoke; NULL = active
	created_at   INTEGER NOT NULL,                  -- unix seconds, bound by the writer
	app          TEXT                               -- the app it was issued for; an anonymous credential without one never resolves
);

CREATE INDEX idx_credentials_principal ON credentials(principal_id);
CREATE INDEX idx_credentials_expires ON credentials(expires_at);
CREATE INDEX idx_credentials_app ON credentials(app);

-- What an inline-grant credential confers: 1..N (action, scope) entries, matched by permits().
CREATE TABLE credential_grants (
	credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
	action        TEXT NOT NULL,
	scope_type    TEXT,
	scope_value   TEXT,
	CHECK ((scope_type IS NULL) = (scope_value IS NULL))
);

CREATE INDEX idx_credential_grants_credential ON credential_grants(credential_id);

-- ── Audit ───────────────────────────────────────────────────────────────────

CREATE TABLE audit_events (
	id                  TEXT PRIMARY KEY,           -- UUIDv7 = time-sortable
	request_id          TEXT NOT NULL,              -- correlates with auth log
	principal_id        TEXT REFERENCES principals(id) ON DELETE SET NULL,
	principal_label     TEXT NOT NULL,              -- SNAPSHOT, survives principal deletion
	credential_id       TEXT,                       -- set when acting under a credential; principal_id is NULL then
	app                 TEXT NOT NULL,              -- self-asserted caller id (audit() carries no token)
	action              TEXT NOT NULL,              -- 'project.settings.update'
	resource_type       TEXT NOT NULL,              -- 'project'
	resource_id         TEXT,
	-- diff/metadata hold JSON text. There is no JSON-validity predicate in the SQLite ∩ Postgres
	-- common subset (`json_valid()` is SQLite-only, `IS JSON` is Postgres-only), so validity is
	-- NOT a DB constraint: the only writer JSON-encodes, and the admin read path parses
	-- defensively (`parseJsonOrNull`, src/json.ts) so a hand-written row can't 500 the API.
	diff                TEXT,                       -- {"field":["old","new"]}
	metadata            TEXT,
	created_at          INTEGER NOT NULL
);

CREATE INDEX idx_audit_resource  ON audit_events(resource_type, resource_id, created_at);
CREATE INDEX idx_audit_principal ON audit_events(principal_id, created_at);
CREATE INDEX idx_audit_request   ON audit_events(request_id);

CREATE TABLE auth_log (
	-- SQLite's rowid alias; the Postgres set spells it `BIGINT GENERATED BY DEFAULT AS IDENTITY`
	-- (writeAuthLog omits `id`).
	id            INTEGER PRIMARY KEY,
	request_id    TEXT NOT NULL,
	app           TEXT NOT NULL,
	kind          TEXT NOT NULL CHECK (kind IN ('authenticate')),
	principal_id  TEXT REFERENCES principals(id) ON DELETE SET NULL,
	credential_id TEXT,
	decision      TEXT NOT NULL CHECK (decision IN ('allow','deny')),
	reason        TEXT,
	created_at    INTEGER NOT NULL
);

CREATE INDEX idx_auth_log_principal ON auth_log(principal_id, created_at);
CREATE INDEX idx_auth_log_request   ON auth_log(request_id);

-- ── Sessions ────────────────────────────────────────────────────────────────
--
-- The long-lived opaque credential a browser carries; only the SHA-256 hash of the cookie value is
-- stored. `app` NULL marks an IAM session (held on IAM's own host); non-NULL marks a child session the
-- proxy holds on ONE app's host. Revoking the parent revokes every child derived from it.
CREATE TABLE sessions (
	id                    TEXT PRIMARY KEY,
	token_hash            TEXT NOT NULL UNIQUE,
	principal_id          TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	idp_sub               TEXT,
	email                 TEXT,
	authentication_method TEXT NOT NULL CHECK (authentication_method IN ('oidc', 'password', 'local_dev')),
	created_at            INTEGER NOT NULL,
	expires_at            INTEGER NOT NULL,
	revoked_at            INTEGER,
	app                   TEXT,
	parent_session_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
	CHECK (
		(authentication_method IN ('oidc', 'local_dev') AND idp_sub IS NOT NULL)
		OR (authentication_method = 'password' AND idp_sub IS NULL)
	)
);

CREATE INDEX idx_sessions_principal ON sessions(principal_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_principal_method ON sessions(principal_id, authentication_method);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

-- One-time codes that hand a parent session over to an app host.
CREATE TABLE auth_codes (
	id                TEXT PRIMARY KEY, -- UUIDv7, minted caller-side
	code_hash         TEXT NOT NULL UNIQUE, -- SHA-256; the plaintext lives in one redirect
	app               TEXT NOT NULL,
	parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	return_url        TEXT NOT NULL, -- carried server-side so redemption cannot be pointed elsewhere
	expires_at        INTEGER NOT NULL,
	consumed_at       INTEGER,
	created_at        INTEGER NOT NULL
);

CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);

-- ── Password authentication ─────────────────────────────────────────────────
--
-- Passwords, one-time action tokens, and login throttles are separate concerns. Only derived
-- password material and token/login-key hashes live in the database.

CREATE TABLE password_accounts (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	state        TEXT NOT NULL CHECK (state IN ('disabled', 'pending', 'enabled')),
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE password_credentials (
	principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	algorithm     TEXT NOT NULL,
	parameters    TEXT NOT NULL,
	salt          TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);

CREATE TABLE password_action_tokens (
	id             TEXT PRIMARY KEY,
	principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	purpose        TEXT NOT NULL CHECK (purpose IN ('enrollment', 'reset')),
	token_hash     TEXT NOT NULL UNIQUE,
	issued_by      TEXT REFERENCES principals(id) ON DELETE SET NULL,
	expires_at     INTEGER NOT NULL,
	consumed_at    INTEGER,
	consumption_id TEXT UNIQUE,
	created_at     INTEGER NOT NULL
);

CREATE INDEX idx_password_action_tokens_principal ON password_action_tokens(principal_id, purpose);
CREATE INDEX idx_password_action_tokens_expires ON password_action_tokens(expires_at);
CREATE UNIQUE INDEX uq_password_action_tokens_active
	ON password_action_tokens(principal_id, purpose) WHERE consumed_at IS NULL;

CREATE TABLE password_login_throttles (
	login_key_hash    TEXT PRIMARY KEY,
	window_started_at INTEGER NOT NULL,
	attempt_count     INTEGER NOT NULL CHECK (attempt_count > 0),
	blocked_until     INTEGER,
	updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_password_login_throttles_updated ON password_login_throttles(updated_at);

-- ── Device authorization (builder pairing) ──────────────────────────────────

CREATE TABLE device_authorizations (
	id                   TEXT PRIMARY KEY,
	app                  TEXT NOT NULL,
	label                TEXT NOT NULL,
	permissions          TEXT NOT NULL,
	key_lifetime_seconds INTEGER NOT NULL CHECK (key_lifetime_seconds > 0 AND key_lifetime_seconds <= 2592000),
	redemption_challenge TEXT NOT NULL,
	approval_challenge   TEXT NOT NULL,
	expires_at           INTEGER NOT NULL,
	next_poll_at         INTEGER NOT NULL,
	status               TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'issued', 'denied', 'cancelled', 'authority_lost')),
	approver_id          TEXT,
	consent_id           TEXT UNIQUE,
	scope_type           TEXT,
	scope_value          TEXT,
	key_expires_at       INTEGER,
	claim_id             TEXT UNIQUE,
	credential_id        TEXT,
	principal_id         TEXT,
	issued_at            INTEGER,
	created_at           INTEGER NOT NULL
);

CREATE INDEX idx_device_authorizations_issuer ON device_authorizations (approver_id, app, id);
CREATE INDEX idx_device_authorizations_expiry ON device_authorizations (expires_at);
