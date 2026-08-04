# @fabrika/control — database, SQL, and migrations

Read this before editing `src/db.ts`, `migrations/`, or `migrations-postgres/`. It is the half of the
control plane's rules that only apply to persistence; the request pipeline, ACL, vault, and run
lifecycle stay in `CLAUDE.md`.

## The portability seam

- **All database access goes through the capability repositories in `src/db.ts`** — prepared
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

- **`migrations/` is IMMUTABLE history; `migrations-postgres/` expresses the FINAL schema.** The
  SQLite set carries create-copy-drop-rename rebuilds it needed because SQLite cannot ALTER a
  constraint; the Postgres set never reproduces them — it states the outcome once. What must match is
  the OUTCOME: `src/db.ts` runs against both unmodified. Add a change to BOTH sets, knowingly.
- **The Bun migration wrapper owns `control_schema_migrations`, bundle `control`, and advisory lock
  `4471902583`.** Bundle and filename form durable identity. Legacy `schema_migrations` rows may be
  adopted only when the control sentinels and migration effects prove ownership; see ADR-0017.

```bash
bunx wrangler d1 migrations apply DB --local      # SQLite/D1
bun run migrate:postgres                          # migrations-postgres/ (FABRIKA_CONTROL_DATABASE_URL)

# The Postgres-backed tests SKIP unless a database is configured:
docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/control
```
