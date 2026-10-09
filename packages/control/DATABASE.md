# @fabrika/control — database, SQL, and migrations

Read this before editing `src/db.ts`, `src/db/`, `migrations/`, or `migrations-postgres/`. It is the half of the
control plane's rules that only apply to persistence; the request pipeline, ACL, vault, and run
lifecycle stay in `CLAUDE.md`.

## The portability seam

- **All database access goes through the capability repositories in `src/db/`, exported by `src/db.ts`** — prepared
  statements, snake_case rows, caller-stamped UUIDv7. Portable operations take the `SqlDatabase` port
  (`@fabrika/platform`), which `D1Database` satisfies structurally.
- **A composition root may replace a COMPLETE capability** when an operation needs dialect-specific
  statement count, atomicity, or locking. **Shared code never switches on a database id.** See
  ADR-0015.
- `src/env.ts` declares every core handle as a port; D1 and Fetcher satisfy theirs structurally,
  while R2 and Queues are adapted in `src/platform-cf.ts`. `RUNNER_SVC` is not a core port — the
  Cloudflare composition passes it straight to its provider.

## Dialect rules

- **TIMESTAMPS ARE CALLER-STAMPED, never `unixepoch()`** (Postgres has no such function). The
  relevant repository capabilities and `Vault` carry an injectable `now()` in unix SECONDS (default
  `Math.floor(Date.now() / 1000)`), like `SqlDeployLocks` does in milliseconds — so the stamp is
  deterministic in tests. The CREATION stamps are the exception: `createApp` / `createRun` / the three
  upserts / `Vault.putSecret` omit `created_at` and rely on the DDL default, which is `unixepoch()`
  on SQLite and `FLOOR(EXTRACT(EPOCH FROM now()))` in `migrations-postgres/`. Never write
  `unixepoch()` in a STATEMENT.
- **A column a row shape types `number` must be `INTEGER` (int4) in Postgres.** Bun decodes
  `int8`/`numeric` as a STRING by column-type OID, so a BIGINT silently changes the row shape. The
  one exception is `deploy_locks.expires_at` (and the `jobs` table's two stamps): unix MILLISECONDS,
  which int4 cannot hold at all — those are BIGINT and are NEVER read into JS, only compared inside
  SQL. `src/__tests__/postgres-schema.test.ts` pins both halves of that rule against a real database.
- **Layering by `(app, env)` is the ORDER BY, not the rowids.** `getAppSecretsForEnv` /
  `getAppVarsForEnv` rank the all-env row before the env-specific one with an explicit
  `CASE WHEN env IS NULL THEN 0 ELSE 1 END`, so the caller's last-write-wins loop lands on the
  narrower layer. Bare `ORDER BY name` left that tie to SQLite's rowid fallback, and
  `ORDER BY name, env` would invert it on Postgres (NULLS LAST by default).

## Migrations

- **`migrations/` (SQLite/D1) and `migrations-postgres/` state the same schema.** What must match is the OUTCOME: `src/db.ts` runs against both unmodified. Add a change to
  BOTH sets, knowingly. Only `jobs` is Postgres-only — the Cloudflare queue has no schema — and it stays
  `CREATE TABLE IF NOT EXISTS`, column for column with `@fabrika/platform-node`'s `0001_jobs.sql`,
  because Control and Operations create it in one shared schema on the light Zerops tier.
- **Before 1.0 the history may be squashed** into one initial file per dialect when installations are
  reinstalled (ADR-0017). A squash must reproduce the schema and seed rows exactly: dump both dialects
  before and after and diff them. Otherwise an applied file is immutable and a change is a new file.
- **SQLite cannot change a CHECK**, so `0005_approved_access.sql` rebuilds `runs` for the `awaiting_approval`
  status. `operations_release_sync` references `runs` with `ON DELETE CASCADE`: its rows are copied aside and
  restored around the rebuild, because dropping the parent would cascade into them. Rebuild a referenced table
  the same way.
- **`app_env_protection` has no foreign key, and nothing deletes its rows, on purpose.** Deleting an environment
  or its app writes the `protected` flag and the counters there, `generation` advanced, in the delete's own batch;
  inserting an environment seeds all three from it. Recreation therefore never resets the publication
  compare-and-swap. Never add an `ON DELETE CASCADE` or a delete of it.
- **Every write of an environment takes its coordinate lock first** (`src/db/coordinate-lock.ts`): it ensures the
  `app_env_protection` row (`INSERT … ON CONFLICT DO NOTHING`), locks it (`UPDATE … SET generation = generation`,
  the portable row lock), and only then reads the tombstone or `app_envs`. That covers registry put, delete and
  protection change and both publication writes in `runs.ts`. A write that may create an environment, and
  `deleteApp`, lock the `apps` row before it. Keep the order: `deploy_locks` lease row, `apps` row, protection rows,
  `app_envs` rows. A new writer of `app_envs` takes the same lock.
- **A registry write is conditional on what it read** (`AppEnvExpectation`). A lost expectation fails the whole
  batch, so nothing of the write commits, its namespace claims included: an absent-expected put is a plain insert
  that fails on the key; a generation-expected put first inserts a duplicate of the locked protection row when the
  generation differs. `expectedWrite` turns the failure into `AppEnvChangedError`.
- **The Bun migration wrapper owns `control_schema_migrations`, bundle `control`, and advisory lock
  `4471902583`.** Bundle and filename form the migration identity; see ADR-0017.

```bash
bunx wrangler d1 migrations apply DB --local      # SQLite/D1
bun run migrate:postgres                          # migrations-postgres/ (FABRIKA_CONTROL_DATABASE_URL)

# The Postgres-backed tests SKIP unless a database is configured:
docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/control
```
