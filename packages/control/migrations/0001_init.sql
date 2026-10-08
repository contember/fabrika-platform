-- Control-plane schema — SQLite/D1 dialect. `../migrations-postgres/0001_init.sql` states the same
-- schema for Postgres; add every later change to both sets. The deploy queue is a platform Queue on
-- Cloudflare, so the Postgres-only `jobs` table has no counterpart here.
--
-- The control plane owns the deploy REGISTRY (who is deployable, where, with which secrets) and the
-- RUN HISTORY (what was deployed, when, with what outcome). Self-owned string ids are caller-generated
-- (UUIDv7, never filled by SQL), `unixepoch()` defaults stamp creation time in seconds, and snake_case
-- columns match the row shapes in src/db.ts. Never write `unixepoch()` in a STATEMENT — Postgres has
-- no such function (see DATABASE.md).
--
-- SECRETS ARE STORED AS REFERENCES ONLY (the `*_ref` columns point into the vault). Never store a
-- plaintext token or secret value in these tables.

-- ── Apps (the deploy registry) ────────────────────────────────────────────────
--
-- One row per deployable app — the "paste a repo + domain" entry. Holds WHERE the source lives and
-- HOW to build it; per-environment targets live in app_envs. `github_connection_id` names the GitHub
-- connection whose App installation mints clone tokens for a private repository.
CREATE TABLE apps (
	id                      TEXT PRIMARY KEY,            -- stable app id (the AppConfig.id); drives resource + propustka naming
	repo_url                TEXT NOT NULL,               -- git remote, e.g. https://github.com/acme/app.git
	default_branch          TEXT NOT NULL DEFAULT 'main',-- branch a manual deploy uses when no ref is given
	worker_dir              TEXT,                        -- sub-dir within the clone the config lives in; NULL = '.'
	build_cmd               TEXT,                        -- override build command; NULL = use the config's pipeline.build
	config_path             TEXT,                        -- config file path relative to worker_dir; NULL = fabrika.config.ts
	github_installation_id  INTEGER,                     -- GitHub App installation id (clone-token minting); NULL = public/direct
	created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
	github_connection_id    TEXT
);

CREATE INDEX idx_apps_installation ON apps(github_installation_id);
CREATE INDEX idx_apps_github_source_binding ON apps(github_connection_id, github_installation_id);

-- ── Deployment namespaces (provider-owned placement, shared by app environments) ─
CREATE TABLE deployment_namespaces (
	id                   TEXT PRIMARY KEY,
	env                  TEXT NOT NULL,
	provider             TEXT NOT NULL,
	exclusive_app_id     TEXT REFERENCES apps(id) ON DELETE RESTRICT,
	provider_target_json TEXT NOT NULL,
	state                TEXT NOT NULL CHECK (state IN ('pending','provisioning','ready','failed')),
	last_error           TEXT,
	created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
	UNIQUE (id, provider, env)
);

-- ── App environments (per-app deploy targets) ────────────────────────────────
--
-- One row per (app, env): the public domain, the git ref that triggers a deploy to THIS env, and the
-- provider-owned target/artifact envelopes. A push whose ref matches `trigger_ref` (exact or
-- `*`-glob) deploys the app to `env`.
CREATE TABLE app_envs (
	app_id                 TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                    TEXT NOT NULL,
	domain                 TEXT,
	trigger_ref            TEXT,
	namespace_id           TEXT,
	provider               TEXT NOT NULL,
	provider_target_json   TEXT NOT NULL,
	provider_artifact_json TEXT NOT NULL,
	created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
	public_origin          TEXT,
	PRIMARY KEY (app_id, env),
	UNIQUE (namespace_id, app_id, env),
	FOREIGN KEY (namespace_id, provider, env)
		REFERENCES deployment_namespaces(id, provider, env) ON DELETE RESTRICT
);

-- A push ref is unique within an app. Partial because NULLs compare as distinct in a unique index.
CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

-- A resource inside a namespace, optionally owned by one app environment of that same namespace. Two
-- triggers enforce that the owner is immutable and lives in the claim's namespace.
CREATE TABLE namespace_resource_claims (
	namespace_id TEXT NOT NULL REFERENCES deployment_namespaces(id) ON DELETE RESTRICT,
	resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
	owner_app_id TEXT,
	owner_env    TEXT,
	created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (namespace_id, resource_key),
	CHECK (
		(owner_app_id IS NULL AND owner_env IS NULL)
		OR (owner_app_id IS NOT NULL AND owner_env IS NOT NULL)
	),
	FOREIGN KEY (owner_app_id, owner_env)
		REFERENCES app_envs(app_id, env) ON DELETE RESTRICT
);

CREATE TRIGGER namespace_resource_claims_owner_immutable
BEFORE UPDATE OF owner_app_id, owner_env ON namespace_resource_claims
FOR EACH ROW
WHEN NOT (
	OLD.owner_app_id IS NEW.owner_app_id
	AND OLD.owner_env IS NEW.owner_env
)
BEGIN
	SELECT RAISE(ABORT, 'namespace resource claim owner is immutable');
END;

CREATE TRIGGER namespace_resource_claims_owner_namespace_match
BEFORE INSERT ON namespace_resource_claims
FOR EACH ROW
WHEN NEW.owner_app_id IS NOT NULL AND NOT EXISTS (
	SELECT 1
	FROM app_envs
	WHERE app_id = NEW.owner_app_id
		AND env = NEW.owner_env
		AND namespace_id = NEW.namespace_id
)
BEGIN
	SELECT RAISE(ABORT, 'namespace resource claim owner belongs to another namespace');
END;

-- ── App secrets (the pipeline.secrets resolution seam) ────────────────────────
--
-- One row per secret an app's deploy needs. `env` NULL = applies to every environment of the app; a
-- non-null `env` narrows it to that environment (the narrower row wins at resolution).
CREATE TABLE app_secrets (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                      -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                             -- the secret name the app declares in pipeline.secrets
	value_ref  TEXT NOT NULL,                             -- REFERENCE into the vault; NEVER the plaintext value
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A name is unique within an (app, env) LAYER. `ON CONFLICT` infers its target from these predicates,
-- so they must match the Postgres set character for character.
CREATE UNIQUE INDEX idx_app_secrets_uq_env ON app_secrets(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_secrets_uq_all ON app_secrets(app_id, name)      WHERE env IS NULL;

-- ── App vars (NON-secret deploy-time config; PLAINTEXT, mirrors app_secrets' layering) ──
CREATE TABLE app_vars (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                      -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                             -- the var name the app declares in pipeline.vars
	value      TEXT NOT NULL,                             -- PLAINTEXT config value (non-secret)
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_app_vars_uq_env ON app_vars(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_vars_uq_all ON app_vars(app_id, name)      WHERE env IS NULL;

-- ── Runs (deploy history + live lifecycle) ────────────────────────────────────
CREATE TABLE runs (
	id                  TEXT PRIMARY KEY,                  -- UUIDv7 (time-sortable), ours
	app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                 TEXT NOT NULL,                     -- target environment (an app_envs.env)
	ref                 TEXT NOT NULL,                     -- git ref deployed (branch/tag/sha)
	commit_sha          TEXT,                              -- resolved commit, once known
	trigger             TEXT NOT NULL CHECK (trigger IN ('webhook','manual','poll')),
	status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
	exit_code           INTEGER,                           -- deploy exit code, once the deploy ran
	log_key             TEXT,                              -- blob key of the streamed log (runs/<id>/logs.ndjson)
	created_at          INTEGER NOT NULL DEFAULT (unixepoch()),    -- enqueued
	started_at          INTEGER,                           -- moved to 'running'
	finished_at         INTEGER,                           -- reached a terminal state
	external_run_id     TEXT,                              -- the provider's id for its asynchronous deploy
	provider_state_json TEXT,                              -- credential-free provider progress, to resume an external deploy
	cancel_requested_at INTEGER                            -- durable cancellation; freezes provider-side lifecycle writes
);

CREATE INDEX idx_runs_app_env ON runs(app_id, env, id);
CREATE INDEX idx_runs_status  ON runs(status, id);

-- ── Repo polling (public repos: no GitHub App install → pulled, not pushed) ──
CREATE TABLE repo_poll_state (
	app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env            TEXT NOT NULL,                          -- the app_envs.env this state tracks
	etag           TEXT,                                   -- last feed ETag for the conditional GET; NULL = never fetched
	last_seen_sha  TEXT,                                   -- change cursor the poller last enqueued for; NULL = none yet
	last_polled_at INTEGER,                                -- unix seconds of the last poll attempt (success or failure)
	last_error     TEXT,                                   -- SHORT diagnostic on a failed poll (never a body); NULL = last poll ok
	PRIMARY KEY (app_id, env)
);

-- ── Vault (envelope-encrypted secret VALUES) ──────────────────────────────────
--
-- Each row carries its OWN random 256-bit data key (DEK) that encrypts the value (AES-256-GCM); the
-- DEK is wrapped by the master key from `FABRIKA_CONTROL_VAULT_KEY`. `scope`/`label` are an audit aid
-- and the ownership record a `vault:<id>` ref is checked against, never the key.
CREATE TABLE vault (
	id          TEXT PRIMARY KEY,                       -- UUIDv7; the `<id>` in a `vault:<id>` ref
	scope       TEXT NOT NULL CHECK (scope IN ('app','app-env','platform')),
	label       TEXT,                                   -- human handle for audit; NEVER the value
	ciphertext  TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the value (DEK-encrypted)
	value_iv    TEXT NOT NULL,                          -- base64 96-bit random IV for the value encryption
	wrapped_dek TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the 256-bit DEK (KEK-wrapped)
	dek_iv      TEXT NOT NULL,                          -- base64 96-bit random IV for the DEK wrap
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	rotated_at  INTEGER                                 -- last value rotation / master-key re-wrap
);

CREATE INDEX idx_vault_scope ON vault(scope);

-- ── Deploy locks (per-(app, env) mutual exclusion) ────────────────────────────
--
-- One row per lease; the row IS the lock (`SqlDeployLocks`). `expires_at` is a `Date.now()`-based
-- deadline in unix MILLISECONDS, spelled BIGINT so the same DDL survives the Postgres port.
CREATE TABLE deploy_locks (
	lock_key   TEXT PRIMARY KEY,  -- the lease target, `<app_id>:<env>`
	holder     TEXT NOT NULL,     -- the run id holding the lease; release is checked against it
	expires_at BIGINT NOT NULL    -- unix MILLISECONDS after which the lease is stale and takeable
);

-- ── Operations synchronization ────────────────────────────────────────────────

-- The catalog Control last pushed to Operations; one row, seeded at revision 0.
CREATE TABLE operations_catalog_sync (
	singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
	desired_revision      INTEGER NOT NULL,
	applied_revision      INTEGER NOT NULL,
	attempted_revision    INTEGER,
	last_snapshot_hash    TEXT NOT NULL,
	applied_snapshot_hash TEXT NOT NULL,
	last_attempt_at       INTEGER,
	last_success_at       INTEGER,
	last_error            TEXT
);

INSERT INTO operations_catalog_sync (
	singleton, desired_revision, applied_revision, last_snapshot_hash, applied_snapshot_hash
)
VALUES (1, 0, 0, '', '');

CREATE TABLE operations_release_sync (
	run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
	desired_revision  INTEGER NOT NULL,
	applied_revision  INTEGER NOT NULL DEFAULT 0,
	payload_json      TEXT NOT NULL,
	last_attempt_at   INTEGER,
	last_success_at   INTEGER,
	last_error        TEXT
);

CREATE INDEX idx_operations_release_sync_pending
	ON operations_release_sync(applied_revision, desired_revision, run_id);

-- The Sentry DSN/public key is client-visible write configuration, not a server secret.
-- Keep it out of app_vars so operators cannot edit or delete platform-managed coordinates.
CREATE TABLE operations_ingest_configs (
	app_id              TEXT NOT NULL,
	env                 TEXT NOT NULL,
	service_key         TEXT NOT NULL,
	credential_id       TEXT NOT NULL UNIQUE,
	public_key          TEXT NOT NULL,
	ingest_project_id   TEXT,
	dsn                 TEXT,
	activated_revision  INTEGER,
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, service_key),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);

-- ── GitHub connections (ADR-0029) ─────────────────────────────────────────────
--
-- Control holds every connection's GitHub App key and webhook secret in its vault; these rows carry
-- only `vault:` references and non-secret coordinates.

CREATE TABLE github_source_setup_attempts (
	id                          TEXT PRIMARY KEY,
	status                      TEXT NOT NULL CHECK (status IN ('active','repair_required','completed','failed')),
	phase                       TEXT NOT NULL CHECK (phase IN (
		'awaiting_manifest_callback',
		'exchange_claimed',
		'credential_stored',
		'app_verified',
		'webhook_secret_stored',
		'webhook_configured',
		'installation_required',
		'connected'
	)),
	version                     INTEGER NOT NULL CHECK (version >= 1),
	state_hash                  TEXT UNIQUE,
	manifest_state_secret_ref   TEXT CHECK (manifest_state_secret_ref IS NULL OR manifest_state_secret_ref LIKE 'vault:%'),
	initiated_by                TEXT NOT NULL,
	expected_origin             TEXT NOT NULL,
	desired_owner               TEXT NOT NULL,
	desired_app_name            TEXT NOT NULL,
	desired_public              INTEGER NOT NULL CHECK (desired_public IN (0, 1)),
	requested_repositories_json TEXT NOT NULL,
	app_id                      TEXT,
	app_slug                    TEXT,
	app_html_url                TEXT,
	app_credential_ref          TEXT CHECK (app_credential_ref IS NULL OR app_credential_ref LIKE 'vault:%'),
	webhook_secret_ref          TEXT CHECK (webhook_secret_ref IS NULL OR webhook_secret_ref LIKE 'vault:%'),
	last_error_code             TEXT,
	created_at                  INTEGER NOT NULL,
	updated_at                  INTEGER NOT NULL,
	expires_at                  INTEGER NOT NULL,
	terminal_at                 INTEGER,
	CHECK ((status = 'active' AND phase = 'awaiting_manifest_callback' AND state_hash IS NOT NULL) OR state_hash IS NULL),
	CHECK ((status = 'completed') = (phase = 'connected')),
	CHECK (state_hash IS NULL OR (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*')),
	CHECK (status NOT IN ('completed','failed') OR terminal_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_github_source_setup_active
	ON github_source_setup_attempts((1)) WHERE status IN ('active','repair_required');
CREATE INDEX idx_github_source_setup_status ON github_source_setup_attempts(status, updated_at);

CREATE TABLE github_source_connections_keyed (
	connection_id               TEXT PRIMARY KEY,
	app_id                      TEXT NOT NULL,
	app_slug                    TEXT NOT NULL,
	app_html_url                TEXT NOT NULL,
	app_owner                   TEXT NOT NULL,
	app_name                    TEXT NOT NULL,
	app_public                  INTEGER NOT NULL CHECK (app_public = 0),
	app_credential_ref          TEXT NOT NULL CHECK (app_credential_ref LIKE 'vault:%'),
	webhook_url                 TEXT NOT NULL,
	webhook_secret_ref          TEXT NOT NULL CHECK (webhook_secret_ref LIKE 'vault:%'),
	installation_id             INTEGER NOT NULL CHECK (installation_id > 0),
	installation_account_login  TEXT NOT NULL,
	installation_selection      TEXT NOT NULL CHECK (installation_selection IN ('all','selected')),
	verified_repositories_json  TEXT NOT NULL,
	requested_repositories_json TEXT NOT NULL,
	connected_by                TEXT NOT NULL,
	connected_at                INTEGER NOT NULL,
	verified_at                 INTEGER NOT NULL,
	version                     INTEGER NOT NULL CHECK (version >= 1)
);

CREATE UNIQUE INDEX idx_github_source_connections_keyed_owner
	ON github_source_connections_keyed(lower(app_owner));
CREATE INDEX idx_github_source_connections_keyed_page
	ON github_source_connections_keyed(connection_id);

-- The builder's idempotency receipt for a connection request, one per setup attempt.
CREATE TABLE builder_connection_receipts (
	attempt_id   TEXT PRIMARY KEY,
	app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	creator_id   TEXT NOT NULL,
	request_key  TEXT NOT NULL,
	receipt_json TEXT NOT NULL
);
CREATE INDEX builder_connection_receipts_app ON builder_connection_receipts(app_id);
