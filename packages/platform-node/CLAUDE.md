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
- **Bundle names, filenames, ledger tables, and advisory lock ids are durable migration identity**
  (ADR-0017). `definePostgresServiceMigrations` keeps service identity and dependency order explicit
  inputs — do not rename them, and do not introduce a shared ledger.
- **Nothing logs credentials, an endpoint, or an error object that might quote a signed URL.**

## Patterns

- One S3 implementation covers both R2 and Zerops object storage (MinIO); only endpoint and
  credentials differ. Note `get()` costs an extra HEAD on a hit, which the R2 binding does not.
- Real Postgres and S3 tests skip unless `FABRIKA_TEST_POSTGRES_URL` / `FABRIKA_TEST_S3_*` are set.
