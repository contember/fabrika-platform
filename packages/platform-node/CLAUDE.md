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

- **Every statement and every batch runs on a connection reserved from the pool** (`onReservedConnection` in
  `sql-postgres.ts`), and a batch sends its own `BEGIN`/`COMMIT` there. Bun 1.3.14's pool sends an unreserved query
  onto a connection that holds another caller's transaction, so under a burst of batches larger than the pool the
  process hangs; its `begin()` on a reserved connection rejects a failed statement twice, once unhandled; and a
  reservation's `release()` rejects once the pool has closed its connection. `sql-postgres.test.ts` pins the first two
  (the plain query that must not wait, the atomic batch), control's `zerops-server-shutdown.test.ts` the third. Never
  call the pool's `unsafe` or `begin` directly.

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
- **An application migration names only its own schema**, read by role (`nameReferences`): a qualified
  relation, call, type or `OPERATOR(…)` of another schema is refused, `pg_catalog` relations included,
  while an alias or `NEW.x` is a column. The runner refuses it for a pending file before any SQL runs;
  the wrapper's `plan()` keeps no qualifier scan of its own, so an applied, checksum-locked file is never
  re-judged. The test kit's throwaway schema depends on this: a migration that reached `public` would
  change live rows on every run.
- **An application migration may not escape; its database code is a deviation** (ADR-0017), checked
  twice for every application plan, the framework bundle included. Before any SQL runs,
  `classifyMigrations` (`migration-classify.ts`) sorts every statement into paved, deviation (`{ kind,
  object, file, line }`, keyed by `kind` + `object`, never the line) or refused, and the runner refuses a
  file the ledger has not recorded that holds a refusal. An allowlist at every level, never a blocklist:
  a statement form, an `ALTER TABLE` clause, a body statement and a function call it does not name are
  refused, so a form a later Postgres adds is refused instead of executed. Bodies are parsed with the
  same lexer; a qualified name is a schema only where it names a relation, a call or a type
  (`nameReferences`, `sql-names.ts`), so `NEW.x` and `alias.col` stay columns. Inside the migration's
  transaction, before its commit, `databaseCodeCheck` (`database-code.ts`) fails it on an integrity
  escape or on any database object the manifest folded through that file does not name. The classifier
  feeds the approval (Control cannot reach the database); the catalog check is its runtime witness, and
  `@fabrika/db`'s codegen runs the same `databaseCodeQuery` against the whole manifest at every start.
- **No framework name in an application migration.** The framework's tables (`fabrika_*`) share the
  schema and hold webhook secrets, deliveries and job leases; `isFrameworkName` refuses every reference,
  case-insensitive, quoted or not, in bodies too. Only the bundle the plan marks `frameworkBundle` (the
  first of several) is exempt, and a file collection's own `fabrika_files_<name>` table, its `_status` check and its
  indexes, and the exact `ALTER TABLE` an older release's `fileScanSql` wrote (`fileScanAlterTable` in
  `file-table-ddl.ts`, which also holds those DDL fragments and `fileTableScanReady`, the checker's question); no other
  `ALTER` of one. An adoption migration may also reference `fabrika_files` as a file column's foreign key, read a
  collection table in an `INSERT … SELECT`, and call `SELECT fabrika_files_copy_legacy('<collection>');` and
  `SELECT fabrika_files_release('<collection>');`, each as a statement of its own. The classifier reports each adoption
  (`INSERT … SELECT` from a collection table) and each release as the file's `adoptions`, which Control's approval shows.
- **Function calls are an allowlist** (`functionUse`, `refusedFunctionCall`): a paved or reviewed
  `pg_catalog` built-in, or a function the migration set declares. A declaration may not take a
  `pg_catalog` function name or a keyword (`pg-catalog-names.ts`, the union over every supported major — 17
  and 18, CI's `test` matrix — generated by `src/__tests__/helpers/generate-pg-catalog-names.ts`, whose header
  says how, and pinned by `pg-catalog-names.test.ts`): overload resolution would otherwise let it admit the
  built-in. A major added to CI is added to the generator's run in the same change, or its test fails. A
  routine has one signature (a second create with another argument list is refused), so the manifest and
  the catalog name it by its name alone.
- **The classifier is a coarse, fail-closed defense in depth, not a Postgres grammar**; the
  application's role family (below) is the privilege boundary. Where a form is hard to read, refuse the
  form (`parenthesizedTarget`, a field-selection call, `serial` and `CREATE SEQUENCE`, an unqualified
  `pg_…` name in DDL) rather than emulate the grammar. Never admit a built-in that runs SQL
  from a string or reaches past the schema (`query_to_xml`, `dblink`, `lo_*`, `pg_read_file`,
  `pg_advisory_*`, `set_config`): these are name rules, and the role family bounds what they miss.
- **An application's SQL runs only as its own roles** (ADR-0017, `application-postgres-roles.ts`). The migration
  role `app_<id>` owns the schema and everything in it; the runtime role `run_<id>` has USAGE and DML on every table
  but the ledger (`grantRuntimeRole`, reset after every run under the lock), never DDL. `migrate(provisioningUrl)` uses
  the provisioning credential only to create, re-password and check the family (`provisionPostgresRoles`: attributes,
  memberships, `CREATE`, any grant or ownership outside the schema, callable `SECURITY DEFINER` routines), then applies
  the plan as the migration role; `application-postgres-grants.ts` clears PUBLIC from the migration role's default
  privileges before the plan, resets PUBLIC's and the runtime role's privileges after it, and verifies the runtime
  role's effective ones. The migration lock wait is bounded (`advisoryLockTimeoutMs`): any role may take it. Never
  apply an application's plan as the provisioning credential and never fall back to it: a credential that cannot
  create roles, a schema the migration role does not own, and a widened role are refused. Passwords are HMAC-derived from the provisioning
  password and sent only as SCRAM verifiers; never put a derived password in SQL text. The derivation (`derivedPassword`,
  `postgresRoleUrl`, `applicationRuntimeUrl`) is platform protocol: the Cloudflare deploy derives the runtime role's
  password to hand it to Hyperdrive, so changing it breaks every installed application's connection. Each migrate resets
  both roles' session defaults and gives the runtime role exactly one, `search_path` = its schema, in the same
  transaction as the reset: through Hyperdrive, which refuses startup parameters, the role's default is the only
  `search_path` the data layer gets (`@fabrika/db/hyperdrive` checks it). An existing installation gets it on its next migrate. `apply(db)` grants nothing and
  exists for the runner's own tests. `dropApplicationDatabase` is for throwaway test databases; `createTestProvisioner` (Postgres 16+) makes the
  credential code the platform did not write gets for them. It logs in for `TEST_PROVISIONER_LIFETIME_MINUTES` only,
  and creating one first sweeps the provisioners killed runs left behind: expired (or without a validity), administered
  by the credential, and without a session of their own or of a role they created. Never drop on a weaker test: a
  concurrent run's provisioner may have no session between its creation and the tests' first connection. Grant or revoke on the database only through
  `changeCreateOnDatabase`: it holds an advisory lock every run shares, since concurrent changes of the one `pg_database`
  row fail with `tuple concurrently updated`.
- **`@fabrika/platform-node/sql` is runtime-neutral.** `sql.ts` reaches only `migration-sql.ts`, `sqlite-sql.ts` (`lexSqlite`, SQLite's lexical rules for
  `ctx.sql` and the checker),
  `sql-names.ts`, `pg-catalog-names.ts`, `migration-classify.ts`, `application-schema.ts` (`applicationDatabaseSchema`,
  so Control classifies against the runner's schema name) and `postgres-migration-error.ts`, which import
  nothing outside themselves: Control loads it in
  a Worker. `sql-subpath.test.ts` pins the import graph; never import Bun, Node or a driver there.
- **Neither check may depend on the session.** `sqlTokens` follows Postgres' lexer (whitespace is
  `[ \t\n\r\f\v]`; every character from U+0080 up belongs to a name; unquoted names fold ASCII only and
  truncate at 63 bytes), the catalog query has no backslash and carries the manifest as hex text, and
  every place that runs it pins `search_path` to `pg_catalog` and `standard_conforming_strings` on.
  The guard qualifies every function, operator and type with `pg_catalog`, because a migration runs with
  its own schema first on the path. Service plans are not checked: a service is trusted platform code.
- **Checksums are verified before anything is applied.** An applied file that changed fails the run with
  nothing applied; a ledger row with no file (a rollback) is tolerated.
- **Only a refused connection is waited out** (`connection-capacity.ts`): `withConnectionCapacity` retries on
  SQLSTATE 53300 alone, with jittered exponential backoff, and throws `ConnectionCapacityError`
  (`CONNECTION_CAPACITY_MESSAGE`) once its wait ran out. Its attempt releases what it opened before it throws, so a
  waiting caller holds no slot another needs.
- **Nothing logs credentials, an endpoint, or an error object that might quote a signed URL.**

## Patterns

- One S3 implementation covers both R2 and Zerops object storage (MinIO); only endpoint and
  credentials differ. Note `get()` costs an extra HEAD on a hit, which the R2 binding does not.
  `S3BlobStore` also implements `FileObjectStore`: `write` counts the bytes in a transform that errors past
  `maxBytes`, which cancels the body and fails the upload, then deletes the key; `read` is one HEAD (`stat`)
  for the size and type, then the stream.
- Real Postgres and S3 tests skip unless `FABRIKA_TEST_POSTGRES_URL` / `FABRIKA_TEST_S3_*` are set.
