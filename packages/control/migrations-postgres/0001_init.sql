-- Control-plane schema — POSTGRES dialect. The parallel of `../migrations/*.sql` (SQLite/D1).
--
-- WHY TWO SETS. `migrations/` is applied to a deployed D1 and is therefore IMMUTABLE — its files are
-- history and must never be edited. This set is the same schema for the other backend. It is NOT a
-- file-for-file translation: `migrations/0003` and `0004` only exist because SQLite cannot ALTER a
-- constraint or drop a foreign key and had to rebuild those tables (create-copy-drop-rename). Postgres
-- can, so those rebuilds are not reproduced — the FINAL shape is expressed directly, once. What must
-- match exactly is the OUTCOME: `src/db.ts` and `src/vault.ts` run against this schema UNMODIFIED,
-- same column names, same constraints, same partial unique indexes.
--
-- Correspondence, so a future migration can be added to both sets knowingly:
--   migrations/0001_init           → apps, app_envs, app_secrets, runs (minus what later files changed);
--                                    `accounts` is never created (dropped by 0003)
--   migrations/0002_vault          → vault
--   migrations/0003_single_account → app_envs' final shape (no account_name / propustka_url), the
--                                    tightened vault.scope CHECK, `accounts` gone
--   migrations/0004_repo_poll      → repo_poll_state; runs.trigger CHECK already admits 'poll'
--   migrations/0005_app_vars       → app_vars
--   migrations/0006_deploy_locks   → deploy_locks
--
-- ── TYPES: the rule, and where it bites ──────────────────────────────────────────────────────────
--
-- Bun's Postgres client decodes by COLUMN TYPE OID, not by value: `int8`/`numeric` come back as a
-- STRING, always, even for a value of 5 (see @fabrika/platform-node's sql-postgres.ts). D1 hands back
-- a `number`. So every column a row shape in `src/db.ts` types as `number` is INTEGER (int4) here:
-- `created_at`, `started_at`, `finished_at`, `last_polled_at`, `rotated_at`, `exit_code`,
-- `github_installation_id`.
--
-- Every timestamp in THIS file is unix SECONDS, which int4 holds until 2038-01-19. That 2038 problem
-- is noted, not solved: widening the columns also means teaching every reader to accept a string.
--
-- THE ONE EXCEPTION IS `deploy_locks.expires_at` — see the block on that table. It is unix
-- MILLISECONDS, it must be BIGINT, and it is never read into JS.
--
-- ── DEFAULTS ─────────────────────────────────────────────────────────────────────────────────────
--
-- `unixepoch()` is SQLite-only, so `src/db.ts` binds every timestamp it WRITES from an injected clock
-- (`markRunStarted`, `markRunFinished`, `sweepStaleRuns`, `upsertRepoPollState`, `Vault.rotate`). The
-- CREATION stamps are the exception: `createApp` / `upsertAppEnv` / `upsertAppSecret` / `upsertAppVar`
-- / `createRun` / `Vault.putSecret` all omit `created_at` and rely on the DDL default, which is why
-- each one below declares its own — `FLOOR(EXTRACT(EPOCH FROM now()))` is the Postgres spelling of
-- `unixepoch()`, floored so it agrees exactly with `Math.floor(Date.now() / 1000)` on the write path.

-- ── Apps (the deploy registry) ────────────────────────────────────────────────
--
-- One row per deployable app — the "paste a repo + domain" entry. Holds WHERE the source lives and
-- HOW to build it; per-environment targets (domain/trigger) live in app_envs. The GitHub App
-- installation id (when onboarded via the GitHub App) lets the control plane mint clone tokens.
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
	created_at              INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))
);

CREATE INDEX idx_apps_installation ON apps(github_installation_id);

-- ── App environments (per-app deploy targets) ────────────────────────────────
--
-- One row per (app, env): the public domain and the git ref that triggers a deploy to THIS env. A push
-- whose ref matches `trigger_ref` (exact or `*`-glob) deploys the app to `env`. PK (app_id, env): an
-- app has at most one row per environment.
CREATE TABLE app_envs (
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,                          -- e.g. 'prod' | 'stage'
	domain      TEXT,                                   -- public domain for this stage; NULL = platform default
	trigger_ref TEXT,                                   -- git ref (or glob) that triggers a deploy here; NULL = manual-only
	created_at  INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),
	PRIMARY KEY (app_id, env)
);

-- A push ref is unique within an app (you can't point two of an app's envs at the same branch).
-- Partial because NULLs compare as distinct in a unique index on both engines.
CREATE UNIQUE INDEX idx_app_envs_trigger ON app_envs(app_id, trigger_ref) WHERE trigger_ref IS NOT NULL;

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
-- a concrete env. These must match `../migrations/0001_init.sql` character for character: `ON CONFLICT`
-- infers its target from a partial index's predicate + expression list (see `upsertAppSecret`, which
-- prepares one statement per layer), so a differently-spelled predicate silently stops inferring.
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
	id          TEXT PRIMARY KEY,                          -- UUIDv7 (time-sortable), ours; also the keyset cursor
	app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	env         TEXT NOT NULL,                             -- target environment (an app_envs.env)
	ref         TEXT NOT NULL,                             -- git ref deployed (branch/tag/sha) — always CONCRETE, never a glob
	commit_sha  TEXT,                                      -- resolved commit, once known
	trigger     TEXT NOT NULL CHECK (trigger IN ('webhook','manual','poll')),
	status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
	exit_code   INTEGER,                                   -- deploy exit code, once the deploy ran
	log_key     TEXT,                                      -- blob key of the streamed log (runs/<id>/logs.ndjson)
	created_at  INTEGER NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now()))),  -- enqueued
	started_at  INTEGER,                                   -- moved to 'running'
	finished_at INTEGER                                    -- reached a terminal state
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
-- the DEK is itself wrapped by the master key (KEK) from `VOZKA_VAULT_KEY`. Plaintext DEKs and
-- plaintext values never touch the database. A `vault:<id>` ref (the id is this PK, a UUIDv7) is what
-- gets written onto `app_secrets.value_ref`; `scope`/`label` are an audit aid only, never the key.
CREATE TABLE vault (
	id          TEXT PRIMARY KEY,                       -- UUIDv7; the `<id>` in a `vault:<id>` ref
	scope       TEXT NOT NULL CHECK (scope IN ('app','app-env')),
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
-- `expires_at` IS THE ONE BIGINT IN THIS SCHEMA. It is a `Date.now()`-based DEADLINE in unix
-- MILLISECONDS, not a creation timestamp, so it does NOT follow the unix-seconds convention every
-- other `*_at` column here uses. A millisecond epoch is ~1.8e12 and int4 tops out at 2147483647, so
-- INTEGER cannot hold it at all — the insert fails outright with "integer out of range". (SQLite's
-- INTEGER is 64-bit, which is why the single DDL in `../migrations/0006_deploy_locks.sql` is correct
-- there and the overflow only appears after the port.) Nothing reads the column into JS — Bun would
-- decode a BIGINT as a STRING — every comparison stays inside SQL.
CREATE TABLE deploy_locks (
	lock_key   TEXT PRIMARY KEY,  -- the lease target, `<app_id>:<env>`
	holder     TEXT NOT NULL,     -- the run id holding the lease; release is checked against it
	expires_at BIGINT NOT NULL    -- unix MILLISECONDS after which the lease is stale and takeable
);
