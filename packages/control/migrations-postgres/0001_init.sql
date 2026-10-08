-- Control-plane schema — POSTGRES dialect. `../migrations/0001_init.sql` states the same schema for
-- SQLite/D1. What must match exactly is the OUTCOME: `src/db.ts` and `src/vault.ts` run against both
-- UNMODIFIED — same column names, same constraints, same partial unique indexes. Add every later
-- change to both sets. Only `jobs` exists on this side alone (see its block).
--
-- ── TYPES: the rule, and where it bites ──────────────────────────────────────────────────────────
--
-- Bun's Postgres client decodes by COLUMN TYPE OID, not by value: `int8`/`numeric` come back as a
-- STRING, always, even for a value of 5 (see @fabrika/platform-node's sql-postgres.ts). D1 hands back
-- a `number`. So every column a row shape in `src/db.ts` types as `number` is INTEGER (int4) here.
--
-- Every unix-SECONDS timestamp fits int4 until 2038-01-19. That 2038 problem is noted, not solved:
-- widening the columns also means teaching every reader to accept a string.
--
-- THE EXCEPTIONS ARE `deploy_locks.expires_at` AND THE TWO `jobs` STAMPS — unix MILLISECONDS, which
-- must be BIGINT and are never read into JS.
--
-- ── DEFAULTS ─────────────────────────────────────────────────────────────────────────────────────
--
-- `unixepoch()` is SQLite-only, so `src/db.ts` binds every timestamp it WRITES from an injected clock.
-- The CREATION stamps are the exception: `createApp` / `upsertAppEnv` / `upsertAppSecret` /
-- `upsertAppVar` / `createRun` / `Vault.putSecret` omit `created_at` and rely on the DDL default —
-- `FLOOR(EXTRACT(EPOCH FROM now()))` is the Postgres spelling of `unixepoch()`, floored so it agrees
-- exactly with `Math.floor(Date.now() / 1000)` on the write path.

-- ── Apps (the deploy registry) ────────────────────────────────────────────────
--
-- One row per deployable app — the "paste a repo + domain" entry. Holds WHERE the source lives and
-- HOW to build it; per-environment targets live in app_envs. `github_connection_id` names the GitHub
-- connection whose App installation mints clone tokens for a private repository.
CREATE TABLE apps (
	id                      TEXT PRIMARY KEY,             -- stable app id (the AppConfig.id); drives resource + propustka naming
	repo_url                TEXT NOT NULL,                -- git remote, e.g. https://github.com/acme/app.git
	default_branch          TEXT NOT NULL DEFAULT 'main', -- branch a manual deploy uses when no ref is given
	worker_dir              TEXT,                         -- sub-dir within the clone the config lives in; NULL = '.'
	build_cmd               TEXT,                         -- override build command; NULL = use the config's pipeline.build
	config_path             TEXT,                         -- config file path relative to worker_dir; NULL = fabrika.config.ts
	-- INTEGER, not BIGINT: `AppRow.github_installation_id` is typed `number | null`, and a BIGINT would
	-- decode as a string. GitHub installation ids are ~1e8 today, well inside int4.
	github_installation_id  INTEGER,
	created_at              INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
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
	created_at           INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	UNIQUE (id, provider, env)
);

-- ── App environments (per-app deploy targets) ────────────────────────────────
--
-- One row per (app, env): the public domain, the git ref that triggers a deploy to THIS env, and the
-- provider-owned target/artifact envelopes. A push whose ref matches `trigger_ref` (exact or
-- `*`-glob) deploys the app to `env`. PK (app_id, env): an app has at most one row per environment.
CREATE TABLE app_envs (
	app_id                 TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                    TEXT NOT NULL,                -- e.g. 'prod' | 'stage'
	domain                 TEXT,                         -- public domain for this stage; NULL = platform default
	trigger_ref            TEXT,                         -- git ref (or glob) that triggers a deploy here; NULL = manual-only
	created_at             INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	provider               TEXT NOT NULL DEFAULT 'cloudflare',
	provider_target_json   TEXT NOT NULL,
	provider_artifact_json TEXT NOT NULL,
	namespace_id           TEXT,
	public_origin          TEXT,
	PRIMARY KEY (app_id, env),
	CONSTRAINT app_envs_namespace_owner_unique UNIQUE (namespace_id, app_id, env),
	CONSTRAINT app_envs_namespace_coordinates_fk FOREIGN KEY (namespace_id, provider, env)
		REFERENCES deployment_namespaces(id, provider, env) ON DELETE RESTRICT
);

-- A push ref is unique within an app (you can't point two of an app's envs at the same branch).
-- Partial because NULLs compare as distinct in a unique index on both engines.
CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

-- A resource inside a namespace, optionally owned by one app environment of that same namespace. Two
-- triggers enforce that the owner is immutable and lives in the claim's namespace.
CREATE TABLE namespace_resource_claims (
	namespace_id TEXT NOT NULL REFERENCES deployment_namespaces(id) ON DELETE RESTRICT,
	resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
	owner_app_id TEXT,
	owner_env    TEXT,
	created_at   INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	PRIMARY KEY (namespace_id, resource_key),
	CHECK (
		(owner_app_id IS NULL AND owner_env IS NULL)
		OR (owner_app_id IS NOT NULL AND owner_env IS NOT NULL)
	),
	CONSTRAINT namespace_resource_claims_owner_fk FOREIGN KEY (owner_app_id, owner_env)
		REFERENCES app_envs(app_id, env) ON DELETE RESTRICT
);

CREATE FUNCTION reject_namespace_resource_claim_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.owner_app_id IS DISTINCT FROM NEW.owner_app_id
		OR OLD.owner_env IS DISTINCT FROM NEW.owner_env
	THEN
		RAISE EXCEPTION 'namespace resource claim owner is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_resource_claims_owner_immutable
BEFORE UPDATE OF owner_app_id, owner_env ON namespace_resource_claims
FOR EACH ROW
EXECUTE FUNCTION reject_namespace_resource_claim_owner_change();

CREATE FUNCTION reject_namespace_resource_claim_owner_namespace_mismatch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.owner_app_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM app_envs
			WHERE app_id = NEW.owner_app_id
				AND env = NEW.owner_env
				AND namespace_id = NEW.namespace_id
		)
	THEN
		RAISE EXCEPTION 'namespace resource claim owner belongs to another namespace'
			USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_resource_claims_owner_namespace_match
BEFORE INSERT ON namespace_resource_claims
FOR EACH ROW
EXECUTE FUNCTION reject_namespace_resource_claim_owner_namespace_mismatch();

-- ── App secrets (the pipeline.secrets resolution seam) ────────────────────────
--
-- One row per secret an app's deploy needs (the names the app declares in `pipeline.secrets`). `env`
-- NULL = applies to every environment of the app; a non-null `env` narrows it to that environment
-- (the narrower row wins at resolution). `value_ref` is a VAULT REFERENCE, never the plaintext value.
CREATE TABLE app_secrets (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                    -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                           -- the secret name the app declares in pipeline.secrets
	value_ref  TEXT NOT NULL,                           -- REFERENCE into the vault; NEVER the plaintext value
	created_at INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))
);

-- A secret name is unique within an (app, env) LAYER, and the NULL-env layer is a distinct layer from
-- a concrete env. These must match the SQLite set character for character: `ON CONFLICT` infers its
-- target from a partial index's predicate + expression list (see `upsertAppSecret`, which prepares one
-- statement per layer), so a differently-spelled predicate silently stops inferring.
CREATE UNIQUE INDEX idx_app_secrets_uq_env ON app_secrets(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_secrets_uq_all ON app_secrets(app_id, name)      WHERE env IS NULL;

-- ── App vars (NON-secret deploy-time config; PLAINTEXT, mirrors app_secrets' layering) ──
--
-- Environment/account-specific CONFIG the engine injects into the deploy child's process.env, NOT
-- secrets: the value is stored in plaintext and is readable over the API, unlike the vault.
CREATE TABLE app_vars (
	app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env        TEXT,                                    -- NULL = all envs of the app; set = that env only (narrower wins)
	name       TEXT NOT NULL,                           -- the var name the app declares in pipeline.vars
	value      TEXT NOT NULL,                           -- PLAINTEXT config value (non-secret)
	created_at INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))
);

CREATE UNIQUE INDEX idx_app_vars_uq_env ON app_vars(app_id, env, name) WHERE env IS NOT NULL;
CREATE UNIQUE INDEX idx_app_vars_uq_all ON app_vars(app_id, name)      WHERE env IS NULL;

-- ── Runs (deploy history + live lifecycle) ────────────────────────────────────
--
-- One row per deploy run, created `pending` at trigger time and moved through its lifecycle by the
-- consumer (pending → running → succeeded|failed). `log_key` points at the blob the relay streams logs
-- into (runs/<id>/logs.ndjson); `commit_sha` is filled once the ref is resolved.
--
-- `trigger` is a NON-RESERVED keyword in Postgres, so it is legal unquoted as a column name — which it
-- must be, because `src/db.ts` names it unquoted and that SQL is shared with SQLite.
CREATE TABLE runs (
	id                  TEXT PRIMARY KEY,                  -- UUIDv7 (time-sortable), ours; also the keyset cursor
	app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env                 TEXT NOT NULL,                     -- target environment (an app_envs.env)
	ref                 TEXT NOT NULL,                     -- git ref deployed (branch/tag/sha) — always CONCRETE, never a glob
	commit_sha          TEXT,                              -- resolved commit, once known
	trigger             TEXT NOT NULL CHECK (trigger IN ('webhook','manual','poll')),
	status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
	exit_code           INTEGER,                           -- deploy exit code, once the deploy ran
	log_key             TEXT,                              -- blob key of the streamed log (runs/<id>/logs.ndjson)
	created_at          INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),  -- enqueued
	started_at          INTEGER,                           -- moved to 'running'
	finished_at         INTEGER,                           -- reached a terminal state
	external_run_id     TEXT,                              -- the provider's id for its asynchronous deploy
	provider_state_json TEXT,                              -- credential-free provider progress, to resume an external deploy
	cancel_requested_at INTEGER                            -- durable cancellation; freezes provider-side lifecycle writes
);

CREATE INDEX idx_runs_app_env ON runs(app_id, env, id);
CREATE INDEX idx_runs_status  ON runs(status, id);

-- ── Repo polling (public repos: no GitHub App install → pulled, not pushed) ──
--
-- Keyed (app_id, env). `etag` is the feed's last ETag for the conditional GET (If-None-Match).
-- `last_seen_sha` is the change cursor the poller last enqueued for — a branch head sha, or the newest
-- tag name matching a glob trigger_ref. `last_error` records a SHORT diagnostic (never a response
-- body); cleared on a successful poll.
CREATE TABLE repo_poll_state (
	app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env            TEXT NOT NULL,                          -- the app_envs.env this state tracks
	etag           TEXT,                                   -- last feed ETag for the conditional GET; NULL = never fetched
	last_seen_sha  TEXT,                                   -- change cursor the poller last enqueued for; NULL = none yet
	last_polled_at INTEGER,                                -- unix SECONDS of the last poll attempt (bound by the writer)
	last_error     TEXT,                                   -- SHORT diagnostic on a failed poll; NULL = last poll ok
	PRIMARY KEY (app_id, env)
);

-- ── Vault (envelope-encrypted secret VALUES) ──────────────────────────────────
--
-- Each row carries its OWN random 256-bit data key (DEK) that encrypts the secret value (AES-256-GCM);
-- the DEK is itself wrapped by the master key (KEK) from `FABRIKA_CONTROL_VAULT_KEY`. Plaintext DEKs and
-- plaintext values never touch the database. A `vault:<id>` ref (the id is this PK, a UUIDv7) is what
-- gets written onto `app_secrets.value_ref`; `scope`/`label` are an audit aid only, never the key.
CREATE TABLE vault (
	id          TEXT PRIMARY KEY,                       -- UUIDv7; the `<id>` in a `vault:<id>` ref
	scope       TEXT NOT NULL CHECK (scope IN ('app','app-env','platform')),
	label       TEXT,                                   -- human handle for audit; NEVER the value
	ciphertext  TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the value (DEK-encrypted)
	value_iv    TEXT NOT NULL,                          -- base64 96-bit random IV for the value encryption
	wrapped_dek TEXT NOT NULL,                          -- base64 AES-256-GCM ciphertext of the 256-bit DEK (KEK-wrapped)
	dek_iv      TEXT NOT NULL,                          -- base64 96-bit random IV for the DEK wrap
	created_at  INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	rotated_at  INTEGER                                 -- last value rotation / master-key re-wrap
);

CREATE INDEX idx_vault_scope ON vault(scope);

-- ── Deploy locks (per-(app, env) mutual exclusion) ────────────────────────────
--
-- One row per lease; the row IS the lock. `acquire` (@fabrika/platform's `SqlDeployLocks`) is ONE
-- conditional upsert whose `changes` count is the answer, so there is no read-then-write window —
-- which is why the same implementation is correct on SQLite and Postgres alike.
--
-- `expires_at` is a `Date.now()`-based DEADLINE in unix MILLISECONDS. A millisecond epoch is ~1.8e12
-- and int4 tops out at 2147483647, so INTEGER cannot hold it at all — the insert fails outright with
-- "integer out of range". Nothing reads the column into JS — Bun would decode a BIGINT as a STRING —
-- every comparison stays inside SQL.
CREATE TABLE deploy_locks (
	lock_key   TEXT PRIMARY KEY,  -- the lease target, `<app_id>:<env>`
	holder     TEXT NOT NULL,     -- the run id holding the lease; release is checked against it
	expires_at BIGINT NOT NULL    -- unix MILLISECONDS after which the lease is stale and takeable
);

-- ── The deploy QUEUE, as a table — POSTGRES ONLY ─────────────────────────────
--
-- On Cloudflare the queue is a platform primitive with no schema. Off Cloudflare a process polls a
-- table of due work with `SELECT … FOR UPDATE SKIP LOCKED`.
--
-- OWNERSHIP. The statements over this table live in `@fabrika/platform-node`'s `PostgresJobQueue`, and
-- the reference DDL is that package's `migrations/0001_jobs.sql`. It is restated here because DDL is
-- per-SERVICE. On the light Zerops tier Control and Operations share one database and both create this
-- table, so the declaration stays `IF NOT EXISTS` and column-for-column identical to the reference.
--
-- TYPES. `visible_at` and `created_at` are unix MILLISECONDS and therefore BIGINT, never read into JS.
-- `attempts`/`max_attempts` are INTEGER precisely so they DO come back as numbers.
CREATE TABLE IF NOT EXISTS jobs (
	id           TEXT PRIMARY KEY,   -- UUIDv7, minted caller-side (time-ordered)
	queue        TEXT NOT NULL,      -- queue name, so several queues share one table
	payload      TEXT NOT NULL,      -- the JSON-serialized message
	visible_at   BIGINT NOT NULL,    -- unix MILLIS: claimable once now >= this (delay + visibility timeout)
	attempts     INTEGER NOT NULL,   -- claims consumed so far
	max_attempts INTEGER NOT NULL,   -- claims allowed before the job is abandoned
	created_at   BIGINT NOT NULL     -- unix MILLIS, enqueued
);

-- The claim's access path: due rows of one queue, oldest first. `id` tie-breaks so the order is total
-- and two consumers scan in the same sequence (which is what makes SKIP LOCKED skip cheaply).
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(queue, visible_at, id);

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
	CHECK (state_hash IS NULL OR state_hash ~ '^[0-9a-f]{64}$'),
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
