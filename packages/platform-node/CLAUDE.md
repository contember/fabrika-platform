# @fabrika/platform-node

`@fabrika/platform`'s ports implemented for a long-running Bun process: Postgres, S3/MinIO, a jobs
table, a filesystem asset server, supervised background tasks. Assumes the root CLAUDE.md and the
port contracts in `@fabrika/platform`.

Built on Bun's own clients (`Bun.SQL`, `Bun.S3Client`) — no `pg`/`postgres`/`@aws-sdk` dependency.
The runtime is Bun by construction (ADR-0003), so they are available.

## Where Postgres diverges from D1

Read this before moving a service onto this driver.

- **BIGINT and NUMERIC come back as STRINGS.** Bun decodes by column type, not by value: `int8` and
  `numeric` are `string`, never `number`, even for a value of 5. **A column a row shape types
  `number` must be `INTEGER` (int4) in the Postgres migration.** int4 tops out at 2147483647 — fine
  for unix SECONDS, not for unix millis.
- **`meta.changes`** is mapped from Bun's `count` only for INSERT/UPDATE/DELETE/MERGE, and reports 0
  otherwise, because for a SELECT `count` is the row count while D1 reports 0. The guarded-UPDATE
  idiom (`changes === 0` means the guard did not match) is therefore accurate on both.
- **Parameter types are checked.** `WHERE text_col = $1` bound with a number fails loudly; SQLite
  would have compared them happily and returned no rows.
- **`undefined` binds as NULL** (D1 throws). Deliberate — it matches the existing `bun:sqlite` test
  harnesses.
- Placeholders are rewritten `?` → `$n` mechanically.

## Invariants

- **The job queue's delivery model is VISIBILITY, not locking.** Claiming pushes `visible_at` forward
  and bumps `attempts`; `ack()` deletes the row; a crash lets the timeout lapse and the job is
  claimable again. That is the only reason a consumer dying mid-job does not strand it, so
  `visibilityTimeoutMs` must exceed the slowest handler.
- **The claim is a SINGLE statement** — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
  RETURNING …` — so it runs through the `SqlDatabase` port with no explicit transaction. `SKIP
  LOCKED` is what lets N consumers drain one queue without blocking or double-delivery. It is the one
  Postgres-specific statement here; the DDL stays in the common subset.
- **`WaitUntil` must swallow rejections.** An unhandled rejection from a background promise
  terminates the process by default, which would turn a failed log flush into an outage. Log a short
  message and drop it. `drain()` exists for shutdown and for tests that assert on background work
  without sleeping.
- **Bundle names, filenames, ledger tables, and advisory lock ids are migration identity**
  (ADR-0017). `definePostgresServiceMigrations` keeps service identity and dependency order explicit
  inputs — do not rename them, and do not introduce a shared ledger. There is no adoption of an older
  ledger: an empty service ledger means a fresh schema.
- **An application's migration identity is derived, never configured** (ADR-0017,
  `application-postgres-migrations.ts`): schema `app_<id>`, ledger `app_<id>.fabrika_migrations` with a
  checksum column, bundle `app`, lock key from SHA-256(`fabrika-db:<appId>`). Changing a derivation
  orphans every deployed ledger or lets two containers migrate at once; the tests pin each one. Only an
  application plan (`plan.application`) records checksums, sets `lock_timeout`/`statement_timeout` and
  may name a schema-qualified ledger; service ledgers keep `(bundle, name, applied_at)`. The optional
  `framework` bundle (the framework's `fabrika_*` tables, which the CLI passes from `@fabrika/db/migrations`)
  runs before `app` in the same ledger and under the same checksum rule.
- **The runner owns each migration's transaction and settings.** `migration-sql.ts` refuses a file with
  a top-level transaction-control or setting statement before any SQL runs (`validateBundle`, every
  plan); `guardCheck` then fails the transaction when the file ended it or loosened `lock_timeout`,
  `statement_timeout` or `search_path` (`set_config()` included). Keep both: the tokenizer cannot see
  procedural calls, and the guard cannot undo a `COMMIT`.
- **An application migration names only its own schema.** Every application plan refuses a
  schema-qualified reference to `public`, an `app_…` or a `fabrika…` schema, quoted or not, also
  inside a dollar-quoted body (`foreignSchemaReference`, the same tokenizer). Unqualified names
  resolve through the runner's `search_path`; `pg_catalog.` stays allowed. A table alias with such
  a name is refused too: the tokenizer cannot tell a schema from a table. The test kit's throwaway
  schema depends on this: a migration that reached `public` would change live rows on every run.
- **An application migration installs no database code** (ADR-0017), checked twice for every
  application plan, the framework bundle included. Before any SQL runs, `disallowedStatement`
  (`migration-allowlist.ts`) admits only the allowlisted statements, `ALTER TABLE` clauses and
  `CREATE TABLE` forms, naming no schema but the application's: an allowlist at every level, never a
  blocklist, because a missed form is then refused instead of executed. It reads only files the ledger
  has not recorded, since applied files are checksum-locked. Inside the migration's transaction,
  before its commit, `databaseCodeCheck` (`database-code.ts`) reads the catalog and fails the
  transaction on any database code, including expressions whose parsed tree calls a function or
  operator outside the reviewed `pg_catalog` lists. Trust built-ins by name, never by volatility.
  `@fabrika/db`'s codegen runs the same `databaseCodeQuery` at start.
- **Neither check may depend on the session.** `sqlTokens` follows Postgres' lexer (whitespace is
  `[ \t\n\r\f\v]`; every character from U+0080 up belongs to a name), the catalog query has no backslash,
  and every place that runs it pins `search_path` to `pg_catalog` and `standard_conforming_strings` on.
  The guard qualifies every function, operator and type with `pg_catalog`, because a migration runs with
  its own schema first on the path. Service plans are not checked: a service is trusted platform code.
- **Checksums are verified before anything is applied.** An applied file that changed fails the run with
  nothing applied; a ledger row with no file (a rollback) is tolerated.
- **Nothing logs credentials, an endpoint, or an error object that might quote a signed URL.**

## Patterns

- One S3 implementation covers both R2 and Zerops object storage (MinIO); only endpoint and
  credentials differ. Note `get()` costs an extra HEAD on a hit, which the R2 binding does not.
  `S3BlobStore` also implements `FileObjectStore`: `write` counts the bytes in a transform that errors past
  `maxBytes`, which cancels the body and fails the upload, then deletes the key; `read` is one HEAD (`stat`)
  for the size and type, then the stream.
- Real Postgres and S3 tests skip unless `FABRIKA_TEST_POSTGRES_URL` / `FABRIKA_TEST_S3_*` are set.
