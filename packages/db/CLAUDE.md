# @fabrika/db

The scoped data layer for applications, on Postgres (Bun, Zerops) or on SQLite (a Cloudflare Durable Object): handlers
reach rows only through a capability (`Ref` or `Within`) and only for the operation its action allows. It runs inside
the application process, so it stops honest mistakes and makes a bypass conspicuous; it is not a hard boundary against
code in the same process. Design: [ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md),
[ADR-0017](../../docs/decisions/0017-service-owned-postgres-migrations.md) for its migrations,
[ADR-0065](../../docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md) for
SQLite, and [application runtime](../../docs/reference/application-runtime.md) for how `serve` and `boot` bind it.
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`): applications depend on it.

```bash
bun run typecheck
bun test    # policy · derived-tables · tables · store · guard · hardening · type-attacks · codegen · testing · postgres, orm, data-ergonomics, testing-connections (need FABRIKA_TEST_POSTGRES_URL)
            # sqlite-engine · sqlite-migrate · codegen-sqlite · testing-sqlite · *-sqlite (bun:sqlite, no backend: they never skip)
```

| Module                 | What it owns                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtins.ts`          | The built-ins captured at load, `NameSet`, and `parseList`, the one way a caller's array is read.                                                                                                                                                         |
| `capability.ts`        | `Ref` / `Within` (opaque, type-only member), `CapabilityAuthority`, `MAX_WITHIN_VALUES`; no Bun.                                                                                                                                                          |
| `policy.ts`            | `defineTables` / `readTables`: the table policies, containment derived from the vocabulary, checked against the column list; row types.                                                                                                                   |
| `orm-types.ts`         | The mini-ORM's handle types and `DbIndex`, which `@fabrika/app`'s kit builds once; types only, exported by `@fabrika/db/tables` too.                                                                                                                      |
| `orm.ts`               | The mini-ORM at runtime: the `ctx.db` handles of one site, own-target read, `getForUpdate`, keyset lists, `unscoped`, queue claims; `dataAccess`.                                                                                                         |
| `vocabulary-tables.ts` | The vocabulary form of the policies (authoring and normalized types), `TypedColumnList`; types only.                                                                                                                                                      |
| `tables.ts`            | `@fabrika/db/tables`, browser-safe: the policies as data (`tablePolicies`), `readTables`, `isTables`, `applicationRowsPlan` and `applicationRowRefusalText`.                                                                                              |
| `application-rows.ts`  | `planApplicationRows`: the rule of the `appRows` an endpoint access case seeds (tables, columns, values, links, order), which `@fabrika/check` reports and the test kits throw.                                                                           |
| `temporal.ts`          | Days and timestamps at the boundary: a read's `YYYY-MM-DD` (`answerDays`), a write's strict day and ISO 8601 text (`dayInput`, `timestampInput`); on SQLite a timestamp's stored text (`storedTimestamp`) and a read's `Date` and boolean (`answerRows`). |
| `description.ts`       | `ScopedSelect`: the frozen, non-executable query description a store callback receives.                                                                                                                                                                   |
| `nodes.ts`             | Kysely operation nodes built from a description and a scope predicate.                                                                                                                                                                                    |
| `guard.ts`             | The allowlist over the final operation tree, run immediately before compiling.                                                                                                                                                                            |
| `database.ts`          | `Database` over a `DatabaseEngine` of its dialect (`fromEngine`, `fromDialect`; no public query method), `Session` (the only path to it), `InvocationTransaction` (`enclose`), `runFixedStatement`, `applicationSchema`, `openFirstConnection`; no Bun.   |
| `postgres.ts`          | `@fabrika/db/postgres`: `openPostgres`, the Postgres engine over Bun.SQL (`prepare: false`, the schema as `search_path`); the only runtime module that imports `bun`.                                                                                     |
| `sqlite.ts`            | `@fabrika/db/sqlite`: `openSqlite(storage)`, the engine over a Durable Object's `ctx.storage`; its frozen `SqliteCompiler`, the constraint errors as SQLSTATEs; Worker-safe.                                                                              |
| `sqlite-bun.ts`        | `bunSqliteStorage`: a `bun:sqlite` database shaped like a Durable Object's storage (foreign keys on, `sql.exec` refusing transaction statements, nested savepoints), for the tests and the SQLite kit; not a subpath.                                     |
| `sqlite-migrate.ts`    | `@fabrika/db/sqlite-migrate`: `migrateSqlite`, the bundles applied in the object's own database, ledger `fabrika_migrations`, ADR-0017's identity and checksum; Worker-safe.                                                                              |
| `migrations-sqlite.ts` | `@fabrika/db/migrations-sqlite`: `SQLITE_FRAMEWORK_MIGRATIONS`, the framework's tables in SQLite (bundle `fabrika`), and `SQLITE_NOW_FORMAT`; plain data.                                                                                                 |
| `sql.ts`               | `ctx.sql`: `classifySql` (the template's static text over `@fabrika/platform-node/sql`), the value binding, the row parse, `sqlTag`.                                                                                                                      |
| `store.ts`             | `scoped(tables)` → `ScopedDatabase`; the stores (`defineStore`, framework tests only); the generated locator; every check.                                                                                                                                |
| `registry.ts`          | Which objects `scoped` created and the framework side of each (bind once → the locator); module-private.                                                                                                                                                  |
| `framework.ts`         | `@fabrika/db/framework`, for `@fabrika/app` only: `bindScopedDatabase`, `isScopedDatabase`, `frameworkTablesOf`, `dataAccessOf`; browser-safe.                                                                                                            |
| `links.ts`             | A `Ref`'s predicate over a table's containment links, shared by the stores and the handles.                                                                                                                                                               |
| `framework-tables.ts`  | The webhook bindings (guarded trees) and the delivery claims (fixed statements: claim under a lease, complete in the handler's transaction, give back).                                                                                                   |
| `job-leases.ts`        | `fabrika_job_leases` and `fabrika_job_kicks`: a job run's lease, its generations and deadlines, a kick's pending run, the last run; `fencedTransaction`; `DialectTexts`, `SQLITE_NOW`, `sqliteNowPlus`.                                                   |
| `admissions.ts`        | `fabrika_form_admissions`, `fabrika_form_challenges`, `fabrika_form_bytes`: a procedure's per-minute buckets, accepted challenge tokens, hourly byte budget.                                                                                              |
| `migrations.ts`        | `@fabrika/db/migrations`: the framework's own tables (`fabrika_*`), the bundle `fabrika`; plain data.                                                                                                                                                     |
| `codegen.ts`           | `@fabrika/db/codegen`: `src/db/schema.generated.ts` (types, `DB`, each table's columns and foreign keys as `TypedColumnList<DB>`) from a Postgres catalog; `renderTables`, the renderer both dialects share.                                              |
| `codegen-sqlite.ts`    | `@fabrika/db/codegen-sqlite`: `generateSqliteSchema`, the same file from the bundles applied to an in-memory `bun:sqlite` database, typed by each column's declared type.                                                                                 |
| `testing.ts`           | `@fabrika/db/testing`, test files only: the Postgres `testDatabase`, the isolation fixtures, `tableProbe`, the framework's `defineStore`.                                                                                                                 |
| `testing-sqlite.ts`    | `@fabrika/db/testing-sqlite`, test files only: the SQLite `testDatabase` (in memory, migrated by `migrateSqlite`, opened with `openSqlite`; never `null`), `tableProbe`.                                                                                  |
| `testing-shared.ts`    | The kits' dialect-neutral half: the seeding plan over a `SeedingBackend`, `SeedLimitError`, the `TestDatabase` and world types, `probeTable`; not a subpath.                                                                                              |
| `production.ts`        | `@fabrika/db/production`: the mark of a process that serves an application, which the test kits refuse.                                                                                                                                                   |

On Postgres, migrations are applied by `@fabrika/platform-node`'s application runner through `fabrika db migrate`
(ADR-0017), and `fabrika db codegen` calls `codegen.ts`. On SQLite the application's Durable Object applies them itself
when it boots (`migrateSqlite`: `SQLITE_FRAMEWORK_MIGRATIONS` as `fabrika`, then its `db/migrations` as `app`), and
`fabrika db codegen` calls `codegen-sqlite.ts`.

An application calls `scoped(tables)` once, in `src/app.ts`, and passes it to `serve(contract, { database })`; its
handlers reach data through `ctx.db` (`orm.ts`). The result carries the policies and nothing else: the stores
(`defineStore(layer, table, build)` / `defineChildStore`) are the framework's own test entry, exported from
`@fabrika/db/testing` only. `@fabrika/app/bun` opens
`openPostgres` (`@fabrika/db/postgres`) as the runtime role `run_<FABRIKA_APP_ID>`, whose URL `@fabrika/platform-node`
derives from the provisioning credential `FABRIKA_APP_DATABASE_URL`, on `app_<FABRIKA_APP_ID>`; on Cloudflare the
application's object opens `openSqlite` (`@fabrika/db/sqlite`) over its `ctx.storage`. `boot` binds the layer to it and to
the runtime's `CapabilityAuthority` (one per `boot`), which binds each capability to its request, through
`@fabrika/db/framework`. The bind answers the locator `on` and `in` use: one guarded select by key of the owning
table's containment columns. `frameworkTablesOf` gives the framework the writes no store makes: `c.webhook` keeps its
bindings and delivery ids in `fabrika_webhook_bindings` and `fabrika_webhook_deliveries`. The job runner of
`@fabrika/app` takes a job's lease in `fabrika_job_leases` (`frameworkTablesOf(…).jobs`), and a procedure's admission
takes from its per-minute buckets, records accepted challenge tokens and reserves its `bytesPerHour`, keyed by the
endpoint id (`frameworkTablesOf(…).admissions`). Those tables keep the names and the `form` column they were created
with (`fabrika_form_admissions`, `fabrika_form_challenges`, `fabrika_form_bytes`): a framework migration is never
edited. `fabrika db migrate`
applies those tables (`@fabrika/db/migrations`) as the bundle `fabrika` before the application's `app` bundle; on
SQLite the object applies `@fabrika/db/migrations-sqlite` the same way.
`dataAccessOf` gives the framework the mini-ORM (`orm.ts`): an `InvocationTransaction` per invocation and the handles of
each staged-kit site's `ctx.db`, which read `reference` tables too. An application table (`scope: { app: '<why>' }`,
`ApplicationPolicy`) belongs to no dimension: its key is generated on insert, it has no chain, and only an `app`
capability (`AppGrant`, the action held as a global grant) reaches it, through `ctx.db.app` (`applicationTables` in
`orm.ts`; `appGrant`, `checkAppReach`, `appListPredicate`, `appRowPredicate`, `updatingApp` and `insertIntoApplication`
in `store.ts`, which address a row and write in an application table only),
which also lists every dimension and child table, read-only with the predicate `true`: its rows, counts and aggregates
where the capability's action is its read action or one of `actions.appRead`, with the columns of that action
(`visibleFor`, as a `Ref` reads its own row), and only its `count`, no row and no aggregate, for one of
`actions.appCount` (`appRecordPredicate`, `checkRecordReach`, `appRecordRows`): a group or a minimum is a row's value.
A scoped site's `ctx.db.app` (a `Ref` or a `Within`) lists every application table read-only, and reads one (every
row, its read action's columns) only where the capability's action is its read action (`scopedApplicationRead`).

`@fabrika/db/testing` is the database half of the generated isolation tests (`fabrika db test-scaffold`, A11):
`testDatabase` migrates a fresh `app_test_<hex>` schema with its own role family through `@fabrika/platform-node`'s
application runner (`migrate`, as the migration role: the framework's tables, then the application's, as
`fabrika db migrate` applies them), connects and seeds as its runtime role, so every test of
application code runs least-privileged, or answers `null` after the standard skip message; `seedWorlds` seeds one row of a table in each of two containment
chains that share no value, every container row a table owns first, with the author's seed values in the table's own
row (never a column that places it, nor a text column that holds a marker the leak cases look for), and answers each row's `chain` of dimension values (a share link's chain); `seedRow` seeds one row of an application
table, with the author's values in any column it does not stamp or fill with a file, and `seedApplicationRows` several,
in foreign-key order and linked (every table's values checked before the first insert, and a table that fails removes the rows seeded before it), with a `remove` that deletes them, the rows their required foreign keys and file columns made it insert, and every row that refers to any of them, however deep, each locked once found and all deleted in one statement (a foreign key is checked at its end, so rows that refer to each other go together); `seedUnder` seeds a row in a seeded row's object (a child row a fixture names); `tableProbe` reaches one table of a layer by
name. `@fabrika/app/testing/isolation` builds the policy isolation and endpoint access tests on them. Every text
column the seeding fills holds a distinct marker, so a leaked value is recognised anywhere in an answer, except a
foreign key outside the chain (`null`, or the key of a reference or application row) and a column a CHECK names (an
`IN` list's first value, or `null`). What the seeding cannot satisfy is a `SeedLimitError` naming the constraint.
There is no generated `move` case yet ([backlog 97](../../docs/backlog/97-the-generated-tests-have-no-move-case.md)):
`t.move` needs the source and the target `Ref`, which an endpoint gets through `access: { capabilities }`.
`@fabrika/db/testing-sqlite` is the same half for an application on Cloudflare: its `testDatabase({ migrations, label })`
migrates a fresh in-memory `bun:sqlite` database (`bunSqliteStorage`) with the object's runner and opens it with the
object's engine, so it needs no backend and never answers `null` (its type stays assignable to the Postgres kit's, so a
generated test compiles against both). There are no roles on SQLite: the seeding writes through the same storage. The
seeding plan, the worlds and the probe are `testing-shared.ts`, each kit giving it a `SeedingBackend` (its columns,
CHECKs, inserts and the removal of seeded application rows). On SQLite that removal finds rows by their rowid (a
`WITHOUT ROWID` table it reaches is a `SeedLimitError`) and defers the foreign keys to its commit; the object's one
writer needs no lock.

## Two dialects (ADR-0065)

A `Database` runs on a `DatabaseEngine`: its dialect (`SqlDialect`, `'postgres' | 'sqlite'`), a Kysely instance, the
frozen compiler that compiles every guarded tree, and a `TransactionRunner` that commits when its body resolves and rolls
back when it rejects. `Database.fromDialect` is Postgres over any Kysely dialect (`openPostgres` passes Bun.SQL's; tests
pass a recording one); `Database.fromEngine` takes another engine (`openSqlite`). `Session.dialect` and
`Database.dialect` name it.

- **The guard and the scoped query surface are shared; only the compiler, the transaction and the fixed texts differ.**
  Each fixed statement has a text per dialect (`DialectTexts` in `job-leases.ts`, `framework-tables.ts` and
  `stored-files.ts`; a pair or a switch on `session.dialect` in `admissions.ts` and `file-columns.ts`), and the session's
  dialect picks the one `runFixedStatement` runs. A new framework statement gets both texts and a test on both.
- **The SQLite compiler** (`SqliteCompiler` in `sqlite.ts`, frozen at load like the Postgres one) binds a `Date` as its
  ISO text, a boolean as 0 or 1, a `bigint` as a safe integer (else `invalid_value`); it gives every `like` `escape '\'`,
  writes `ilike` as `like` (case-insensitive for ASCII only), and drops every lock modifier (`FOR UPDATE`, `FOR SHARE`,
  `SKIP LOCKED`, `NOWAIT`): while a transaction is open the object serves no other event, so no row lock is needed, and
  the SQLite texts carry none either. An order term states Postgres's null order (`nodes.ts`), so a keyset page reads the
  same rows on both.
- **SQLite's stored forms** (the header of `migrations-sqlite.ts`): a timestamp is UTC ISO TEXT
  `YYYY-MM-DDTHH:MM:SS.sssZ`, what `strftime(SQLITE_NOW_FORMAT, 'now')` (`SQLITE_NOW`, the database's clock) and
  `Date#toISOString()` both write, so text order is time order; a boolean is INTEGER 0 or 1; a UUID is TEXT; a BIGINT
  INTEGER. The webhook tables keep their epoch-millisecond INTEGER times, as on Postgres. Every framework table is
  `STRICT`. A write binds a timestamp through `storedTimestamp` (an instant outside 0000–9999 UTC is refused); a read
  answers a timestamp column as a `Date` and a column of the column list's `booleans` as a boolean (`answerRows`), so a
  handler sees the values Postgres's driver answers.
- **Codegen on SQLite types a column by its declared type** (`codegen-sqlite.ts`, `DECLARED_TYPES`): TEXT, VARCHAR,
  CHAR, UUID are strings; INTEGER, INT, BIGINT, SMALLINT, REAL, DOUBLE, FLOAT numbers; BOOLEAN a boolean in `booleans`;
  TIMESTAMP, TIMESTAMPTZ, DATETIME a `Date` in `timestamps`; DATE a `YYYY-MM-DD` string in `dates`; BLOB a `Uint8Array`.
  Any other declared type, and a virtual table, is refused. It reads every table but `sqlite_*` and `fabrika_*`.
- **The transaction is the object's** (`openSqlite`'s runner is `storage.transaction(() => body(kysely))`): `sql.exec`
  refuses `BEGIN`, `COMMIT` and `SAVEPOINT`, and the Kysely driver refuses Kysely's own transactions. `readOnly` and the
  idle timeout have no SQLite form; a read-only session still refuses every write before compiling.
- **The invocation's transaction encloses its work on SQLite** (`InvocationTransaction.enclose`). A Durable Object's
  transaction holds back every other event, the answers to the object's own I/O included, until its callback ends, so the
  handler runs inside the callback, from its first statement to its commit; `commit()` and `rollback()` only decide, the
  COMMIT runs once the work returned, and a failed COMMIT rejects with a `DatabaseError`. On Postgres `enclose` only runs
  the work. Call it before the first statement.
- **A SQLite failure is a `DatabaseError` with a SQLSTATE or none** (`sqliteError`): a constraint message maps to
  `23505` (unique, primary key), `23503` (foreign key), `23514` (check) or `23502` (not null), and nothing of the message
  is kept, since it can quote row values. Callers compare SQLSTATEs as on Postgres.
- **The one `as` of the package** is in `sqlite.ts`'s connection: the cursor's untyped rows become Kysely's
  `QueryResult<R>` rows, which is what Bun.SQL's `any` rows do on Postgres. Add no other.
- **`ctx.sql` is refused on SQLite** (`sql_dialect`, in `sqlTag` before anything is sent): the classifier reads
  Postgres's lexical rules, and a Durable Object has no runtime role under it.
- **A Worker loads no Bun module.** The root, `@fabrika/db/framework`, `/sqlite`, `/sqlite-migrate` and
  `/migrations-sqlite` import neither `bun` nor `bun:sqlite`; Bun.SQL lives in `/postgres`, `bun:sqlite` in the tooling
  (`codegen-sqlite.ts`, `sqlite-bun.ts`, `testing-sqlite.ts`).

## Invariants

- **The generated tests catch mistakes; the data layer is the enforcement.** They catch what an application's author,
  usually an agent, gets wrong: a handler that serves another scope's rows, a cache keyed by nothing, a policy that
  does not hold. A deliberately hostile author runs in the same process and can always subvert them. Never weaken a
  store check because a generated test covers the case.
- **`@fabrika/db/tables` imports no Bun API, no driver and no Kysely runtime.** `@fabrika/app/contract` (the SPA)
  and the static contract reader (a Worker) import it; `tables.test.ts` bundles it for a browser.
- **`defineTables` and `readTables` are one parse** (`parseTables`), over values nobody type-checked: plain objects
  and arrays only, read through own data properties, unknown fields refused. Both take the vocabulary
  (`defineTables(vocabulary, columns)`, `readTables(columns, policies, vocabulary)`); the form that names the action
  union by hand, `defineTables<DB, Action>(columns)`, is gone, and a one-argument call throws. Its types answer
  `NormalizedPolicies`, which the kit's `DbIndex` reads.
- **Containment is the vocabulary's, never the policy's.** A dimension table's container is the dimension the
  vocabulary puts its own in; its column is `<container>_id`, or the one `in: { column }` names off that convention.
  A key defaults to `id`; a child's column defaults to `<parent dimension>_id`, and its chain is its parent's. Above a
  dimension no table owns, the chain keeps the vocabulary's ancestry on the `<dimension>_id` convention, so those
  columns are carried and stamped too. A stated value must agree: `in.dimension` other than the vocabulary's, `in` on a
  top-level dimension, or an `inherit` other than the parent's chain is refused, and so is a default the table has no
  column for, with a message that names the field to state. The vocabulary's own containment may not be a cycle.
- **A containment column is a foreign key to its container's key.** When a table owns the container (or the child's
  parent), the container column (or the child's column) must be a column of a foreign key, single or composite, that
  references that table's key; the column list carries the foreign keys. A column that only has the convention's name
  is refused, naming the column whose foreign key does reference the key. A container no table owns (a scope only IAM
  knows) has no key to reference, so the convention stands there.
- **An inherited chain is one foreign key with the containment column** (`requireCoveringKey`): a contained table's or
  a child's columns of its owner's chain go in the same composite foreign key as its container or parent column,
  `(project_id, org_id) references projects (id, org_id)`, or the parse refuses it and names that key. A `Within` of an
  ancestor reads a row by its inherited column alone, so a column the database does not tie to the owner would put the
  row in a scope its owner is not in.
- **Every action is the vocabulary's.** Table actions and a column's own read and write actions are refused unless the
  vocabulary declares them, in the one parse: the reader refuses them from source too.
- **The inbox scope is gone.** A policy that still states `scope: { inbox: … }` is refused with a message that says to
  declare an application table (`scope: { app: '<why>' }`) that a public procedure inserts into.
- **The authoring types pick each table's form by the scope it states** (`VocabularyPolicyMap<DB, V, P>`): a misspelt
  dimension is reported against the vocabulary's names, a child's parent against the tables that state a dimension
  scope, and a missing `key`, `in` or child `column` names `NamesItsKey` / `NamesItsContainerColumn` /
  `NamesItsParentColumn` in two lines; `derived-tables.test.ts` compiles `derived-mistakes/`. A map annotated with
  `VocabularyPolicyMap<DB, V>` states nothing narrower, so it is checked against every form.
- **The generated column list carries the row types.** `TypedColumnList<DB>` brands `ColumnList<DB>` with a type-only
  unique symbol, so `defineTables(vocabulary, columns)` needs no type argument; a list without the brand makes the
  policies' builder an `Unavailable` that names `fabrika db codegen`.
- **A capability reads a column that declares its own read action only when its action is exactly that one**
  (`RowFor` in `orm-types.ts`): a capability type widened to several actions proves none of them. The row type omits
  the hidden column (`Omit<DealsTable, "margin">`, which a diagnostic names), so a read of it is TypeScript's plain
  "does not exist" error; reference and unscoped rows read through the table's read action. An `unscoped` declaration's
  mode that may be `'write'` (a union or an optional one too) of a reference table is an `Unavailable` at its
  key (`ReadOnlyUnscoped`): no site writes it, and
  `insertUnscoped` still refuses it at run time. It has no key, so its unscoped `get` is an `Unavailable` that says
  to read it with `list`; `unscopedRows` still refuses it at run time (`row_address`). `RowOf<typeof tables, T, A>`
  (`@fabrika/db/tables`) is that row for an application's mapper; `A` defaults to the table's read action. A job's handles outside
  its transaction read only: every write is an `Unavailable` that names `ctx.transaction((tx) => …)` and `tx.db`. The static reader reads
  `src/db/tables.ts` through `readTables`, so a policy the runtime refuses is refused from source too.
- **Only the framework binds a layer, once, and only one `scoped` created.** The object `scoped` returns has no
  `connect` and no locator; `registry.ts` keeps its framework side in a module-private `WeakMap`, so a structural copy
  or a wrapper is no layer and gets no connection. `bindScopedDatabase` is the only path to the connection and answers
  the locator, which reads existence without a capability and so stays with the framework's access check. A second
  bind throws. Until then every store throws. The checker refuses an application import of `@fabrika/db/framework`.
  Never add another way to set the runtime of a `scoped` result, nor an application-facing locator.
- **The table probe is a store without the types, never without a check.** `tableProbe` reaches the registry's
  `probe`, which calls the same internals as `DimensionTable` and `ChildTable` (`insertIntoDimension`,
  `objectPredicate`, …), so kind, dimension, action and the authority run on every call. It exists for the generated
  tests, which address a table by name; add no operation to it that a store does not have.
- **`@fabrika/db/testing` is for test files only.** It refuses to load or run once `markProductionProcess` ran (the
  generated entrypoint calls it before it imports the application), and when `FABRIKA_RELEASE` is set. The mark is a
  non-writable, non-configurable property of `globalThis` under `Symbol.for('fabrika.production')`: every installed
  copy of this package reads it, it holds after the framework scrubbed `FABRIKA_*`, and nothing unmarks it.
  `@fabrika/check`'s `test-only-import` refuses the module outside a test file: it seeds rows past the data layer,
  through a raw connection of its own, as the runtime role. `@fabrika/db/testing-sqlite` refuses and is refused the
  same way. Its seeding fills a required column it does not place with a sample of the
  column's type, and refuses a type codegen refuses.
- **A throwaway schema is held by its advisory lock for its whole life.** The lock (SHA-256 of
  `fabrika-test-schema:<name>`) is taken on a reserved connection before the schema and its roles exist. Each
  `testDatabase` first drops every `app_test_*` schema and `app_test_*`/`run_test_*` role family whose lock it can
  take, and never one whose lock is held. A failed migration drops the schema and the roles, and `close` runs every
  cleanup step even when one throws. `FABRIKA_TEST_POSTGRES_URL` is a provisioning credential: it must be able to
  create roles (a superuser, or `CREATEROLE` with `CREATE` on the database); `fabrika db test-isolation` hands it a
  throwaway one. A family the kit cannot administer (another provisioner's) is left to its creator.
- **A test database holds at most `TEST_DATABASE_CONNECTIONS` (4) and never fails a case for want of one** (ADR-0043).
  One provisioning connection holds the lock and reads the CHECK constraints, the seeder has one, the runtime role two;
  migrating, reading the catalog and the drop borrow one more each, one at a time. `openTestDatabase` opens the first
  connection of every pool before the first case (`openFirstConnection`): Bun's pool then makes a statement wait for
  an open connection when the database refuses another. A refusal while it opens (SQLSTATE 53300) closes everything it
  opened and retries on a fresh schema (`withConnectionCapacity` of `@fabrika/platform-node`, up to
  `connectionWaitMs`, 60 s); then the file fails with `CONNECTION_CAPACITY_MESSAGE`, which `fabrika db test-isolation`
  recognises, and every later file of the process fails at once. `close` ends the runtime role's and the seeder's
  connections before the drop, which waits the same way.
- **`@fabrika/db/framework` imports no Bun API and no driver**: the Worker adapter imports `boot`, which imports it.
  It takes only types from the modules that need the driver (`framework-tables.ts`, `job-leases.ts`, `admissions.ts`,
  `stored-files.ts`); `store.ts` builds their implementations. `framework-tables.ts` reads a unique violation off
  `DatabaseError.sqlState`.
- **A delivery key is recorded by its primary key.** The `delivery_id` column holds the key `@fabrika/app` derives
  from the binding and the signed body, never an unsigned header. Two concurrent copies of one delivery insert the
  same `(binding_id, delivery_id)`; exactly one succeeds and the other answers "already recorded". Never replace this
  with a read before the insert. `recordDelivery` first drops the binding's keys older than its retention bound.
- **Every mutation of a job attempt is fenced by its lease** (`fencedWork` in `store.ts` → `fencedTransaction`). The
  authority's `fence()` names the attempt, or `null` in a request. In the mutation's transaction, before the write:
  a `for share` select requires the attempt's generation, holder and an unpassed `attempt_deadline`, and
  `statement_timeout` and `idle_in_transaction_session_timeout` are set to the time left. Just before `COMMIT` the same
  check runs again (on SQLite only these two checks run, with no lock, no timeout and no backend to cancel: no other
  event reaches the object while the transaction is open). A failed check, a statement the deadline cancelled, or `cancelInFlight` (the runner calls it when
  the attempt ends) rolls back with `LeaseLostError`. `cancelInFlight` aborts the transaction itself (`Session.transaction`'s
  signal), so it rolls back and gives its connection back even while its work waits on something else, and cancels a
  statement still running, matched by pid and `xact_start` so a reused pid is left alone. The lock makes a takeover or a renewal wait for the write, so no write of an old
  generation commits after a newer one was granted. A store's write runs in `fencedWork`; a handle's in its site's
  session: an invocation's transaction (a request or a webhook delivery, which hold no lease) or a job's
  `ctx.transaction`, which is `fencedWork`. A job's handles outside it refuse every write. Never add a write path
  outside these.
- **Every lease time is the database's clock.** `acquire`, `renew`, `finish`, `reapCrashed` and `claimOverdue` take
  durations and compute and compare with `now()` (`clock_timestamp()` inside a mutation's transaction, where `now()`
  is its start; `SQLITE_NOW` and `sqliteNowPlus` on SQLite). Never bind a process timestamp: two containers' clocks disagree.
- **A lease changes hands in one conditional statement.** `acquire` takes only a free lease; an expired lease whose
  holder never finished is freed first by `reapCrashed`, whose one winner reports the crash. `renew` and `finish`
  match the caller's generation and holder. `claimOverdue` sets `last_missed_reported_at` at most once per period, so
  one of many concurrent checkers reports. `tryAcquire` is `acquire` for a kick, on a connection requests share: it
  takes the row `for update skip locked` (on SQLite a plain conditional update), so it answers `null` at once instead of waiting on an attempt's fence. A
  kick's pending flag is `fabrika_job_kicks`, apart from the lease row for the same reason: `markPending` sets it,
  and `takePending` clears it for one caller. Never read a lease and then write it.
- **The lease and admission statements are fixed SQL** (`runFixedStatement` in `database.ts`, which no subpath
  exports), one text per dialect: they need `now()`, `set_config`, `pg_backend_pid()`, `on conflict` and `skip locked`
  (on SQLite `strftime`, `on conflict` and `json_each`), which the guard refuses on purpose. Only `job-leases.ts`, `admissions.ts`, `framework-tables.ts`, `stored-files.ts` and
  `file-columns.ts` call it, with constant texts and scalar parameters;
  never build a text from a value. `databaseNow` (`job-leases.ts`) is the database's clock a queue claim and a requeue
  bind as a value.
- **An admission bucket is taken in one statement** (`take`: an upsert whose update only runs below the limit), so
  concurrent instances never admit past it, and a byte reservation likewise (`reserveBytes`); never read a counter and
  then write it. Every take, challenge record and reservation also prunes up to 32 expired rows with
  `for update skip locked` (no wait, so no deadlock), never the row it writes itself, so the tables hold only the last
  minutes (the byte budget the last hour). On SQLite, which has no data-modifying CTE, the prune is a statement of its
  own before the write, in the same transaction. Times are the database's.
- **The framework migrations are migration identity** (ADR-0017): never edit an entry of `FRAMEWORK_MIGRATIONS` or
  `SQLITE_FRAMEWORK_MIGRATIONS`, add one. Both create the same tables and columns; a new framework table goes into both.
- **`applicationSchema` derives what `@fabrika/platform-node`'s `applicationDatabaseSchema` derives** (ADR-0017);
  `tables.test.ts` compares them. Change both together.

- **A read-only request writes nothing.** `DataLayerRuntime.readOnly` (the framework's
  `requestIsReadOnly`, true in an export's request) makes every session read-only — a store's, the
  locator's, the stored files', webhook and job-lease tables' — because `sessionOf` takes the runtime, never the bare
  connection: `Session.run` refuses
  any root but a select, and any lock, before compiling, whatever capability the operation carries,
  and runs each statement in a `READ ONLY` transaction (`transaction()` opens one too; SQLite has none, so there the
  refusal is the whole of it). Never route a
  statement past `Session.run`, or this stops holding.
- **Every select, update and delete carries its scope predicate as the top-level right conjunct of
  WHERE, by identity.** The caller's conditions sit in a `ParensNode` on the left. The guard checks this
  shape (`checkRoot`); without the parenthesis, `true or 1=1` followed by the scope would match every
  row. An insert carries no WHERE and gets its scope columns stamped from the capability instead.
- **A handle's `Within` lists every table whose containment chain holds its dimension** (`reachColumn`,
  `reachPredicate`), and a top-level table its own: tasks under a `Within` of `org` through their stamped `org_id`.
  The predicate, the keyset page, the projection and the hidden columns are the nearest container's. The stores'
  `select`/`aggregate` keep the nearest container only. `DbIndex<DB, P, V>` takes the vocabulary, so its types follow
  the chain past a dimension no table owns, as the parse does.
- **A Within's predicate is `column in (values)`, plus one `<chain column> in (values)` disjunct per container
  grant, in one parenthesis.** The container grants stay separate from the values (`WithinGrant.containers`), so
  the statement judges each row by the chain it carries now; a scope moved out of a container is out. A container
  must be a chain link above the Within's own dimension in that table, or the operation is refused. The guard
  admits a scope predicate only as `true`, an AND tree of `column = $n`, a single membership, or a parenthesized
  OR tree of memberships, over the statement's table.
- **A Within carries at most `MAX_WITHIN_VALUES` (1000) scope values, its own, its containers' and its contained grants' together.** Each
  is one bound parameter of every statement it scopes (Postgres binds at most 65535); the framework refuses to
  mint a larger one and the layer refuses to use one.
- **A Ref's predicate covers every link of its chain, one equality per chain column.** A table carries
  a column for each ancestor (`TableModel.chain`, resolved by `defineTables` through the tables that own
  each dimension); a `Ref` whose chain names a dimension the table has no column for is refused, never
  ignored. Otherwise a `Ref` minted before an ancestor moved would still reach its rows.
- **An insert into a container, a child insert and a move lock the destination row first** (`FOR SHARE`,
  matched on the destination `Ref`'s whole chain, in the mutation's transaction; `lockDestination`), when a
  table owns the destination dimension. A
  stale destination is 404 and nothing is written (the SQLite compiler drops the lock and keeps the read). The guard admits that lock only with `GuardContext.lock: 'share'`,
  and a handle's `getForUpdate` (`FOR UPDATE` of its own target in a mutation) only with `lock: 'update'`, and a queue
  claim's `FOR UPDATE SKIP LOCKED` only with `lock: 'claim'`; it admits no other lock, no `NOWAIT` and no `OF`. An
  insert carries `ON CONFLICT (<columns>) DO NOTHING` only with `onConflict: 'nothing'`, and never `DO UPDATE`.
- **A table action is one action or a list of them; any one allows the operation** (`ActionModel` holds lists, `includes`
  reads them). With several read actions a column's own read action hides it from the others, so `visible` is what
  every read action reads and a handle reads the columns of its capability's own action (`visibleFor`). The artifact
  keeps a single action as its text, so a policy that names one keeps its digest.
- **A queue claim is a lease committed on its own** (`claimRows` in `orm.ts`). Only a job outside `ctx.transaction`
  claims (`claim_site` otherwise): inside one a failure would roll the lease back and retry the row at once. It runs in
  `fencedWork` under the attempt's fence, compares `due` with `databaseNow`, takes rows `FOR UPDATE SKIP LOCKED`, and
  in the same transaction adds one attempt and moves `due` by the job's tick doubled per earlier claim (at most 30
  days). Each row answers the columns its action reads, its new version and `ref`: a `RowGrant` the authority mints
  (`CapabilityAuthority.row`), bound to the row's key and the containment it had when claimed. `tx.db.on(row.ref)`
  updates (`done: true` clears `due` in the same statement), removes with the delete action, or requeues. Never add a
  claim that waits for a lock or runs inside the work's transaction.
- **An insert's `onConflict` writes in SQL only `DO NOTHING`** (`insertOnConflict` in `store.ts`). `'update'` is a
  second statement in the same transaction: the table's update columns, by the conflict columns, within the insert's own
  containment, by a capability that also holds the update action. A conflicting row out of that reach is a 409.
- **Mutations answer `{ id, version }` (and `move` the new chain), never row data.** A capability reads its row only
  through a handle's own-target read (`orm.ts`, `visibleFor`): a `Ref` of any action the table names gets the row
  without every column that declares a read action other than exactly its own, the same columns `RowFor` omits from
  the type. A store's `get` and every `Within` read by the table's read action.
- **A column holds at most one stamped role.** The key, every containment column of the chain, `version`
  and `createdBy` are distinct columns, or `defineTables` refuses the policy (`checkStamps`). Otherwise
  one stamp overwrites another: `createdBy` on the key inserts the principal as the id, `version` on a
  container column moves the row on every update.
- **A `version` column is INTEGER (int4).** Postgres returns BIGINT as a string (the platform-node rule in
  `packages/platform-node/CLAUDE.md`), and the acknowledgement and `expectVersion` are numbers. The policy
  types accept only a column whose generated select type is `number` (`VersionColumn`); the column list
  carries names only, so at runtime a mutation that gets a non-number version back throws inside its
  transaction and writes nothing.
- **Insert and update data are read through own property descriptors** (`readValues`): a plain or
  null-prototype object only, no symbol keys, no accessors, every key checked before any value is read.
- **The data layer checks kind, dimension and action itself, on every operation.** The authority only
  says whether a value is an authentic capability of the current request. TypeScript checks method
  parameters bivariantly, so a widened handle passes a read `Ref` to `remove` without a cast — the
  runtime check is what refuses it.
- **`ConflictError` and `NotFoundError` are internal.** The root exports neither: an application throws `@fabrika/app`'s,
  and the framework maps these by `name` (409, 404).
- **No raw handle leaves the package; the one SQL text is a declared site's `ctx.sql`.** `Database` keeps its Kysely
  instance in a private field; the store reaches it through `sessionOf`, and `Session.run` guards every tree. An
  application's own SQL enters only through `sql.ts` (`DataAccess.sql`, which the framework builds for a site that
  declares `sql`): a tagged template whose static text `classifySql` reads with a `$n` for each value, so a value is
  only ever a bound parameter, refused before anything is sent for what escapes the statement, the transaction or the
  schema (see `docs/reference/application-runtime.md`), and run by `runApplicationStatement` through the session's
  private execute, so a statement the database refuses fails the invocation. On SQLite the tag refuses every statement
  (`sql_dialect`). Any refusal of the tag after its binding check (a statement, a value, a row) fails the site's transaction too (`SqlSite.fail`: `InvocationTransaction.fail` or `Session.fail`), so a handler that catches it still commits nothing; a nested `Session.transaction` with a failed statement throws instead of committing. A row error names the schema's top-level field and the issue's code and expected type, never the issue's message, a deeper path or a value. `QueryRefusedError` carries a `reason` from the closed `QUERY_REFUSALS` catalog, and `CapabilityError` one from `CAPABILITY_ERRORS`; `@fabrika/app` logs only the reason and its catalog text (as `query_refused` and `capability_refused`, for a request and a job attempt alike), never the message, which may quote a value the request sent. A new refusal picks a reason, or adds one with its fixed text. Do not add another method that takes
  SQL, a builder or an unguarded node.
- **`ctx.sql.scope(capability, table, alias?)` is the one interpolation that is not a single parameter.** It renders
  `scopeTerms` (`store.ts`) for what its table is to the statement (`ScopeUse`): a `Ref`'s object column and every link
  of its chain (`linkValues`), a `Within`'s values and container grants as `ctx.db.within` matches them, `(true)` for
  `all`, `(false)` when empty, and `(true)` for an `app` capability and for a scoped read of an application table. The
  tag lexes the statement into query blocks before it renders a fragment (`statementWrites` in `sql.ts`): each
  `SELECT`, `INSERT`, `UPDATE` and `DELETE` opens one, which ends with its parenthesis or at the next block of its
  depth, and `ON CONFLICT … DO UPDATE` is an `UPDATE` of its `INSERT`'s target. A fragment whose table and alias are
  the relation its own block's `UPDATE` or `DELETE` writes needs that operation's own action (`checkWriteTarget`), or
  for an `UPDATE` a column's own write action that every column its `SET` assigns declares (`assignedColumns` in
  `sql.ts` reads them to the list's end, a clause word inside brackets, a `CASE` or `IS [NOT] DISTINCT FROM` being the
  expression's, and a `SET` it cannot read with certainty assigns no column a column action writes; `updatingRef`'s
  rule for the handles), and
  an `app` capability writes application tables only, a `Ref` or `Within` never one. Any other fragment reads (another
  occurrence of the written table too), with an action the handles read the table with: any action it
  names for a `Ref`, its read action for a `Within`, what `ctx.db.app` lists it for with an `app` capability
  (`checkAppReach`: an application table under any action it names, a dimension or child table under its read action
  or one of `actions.appRead`), and its read action for a scoped site's application table (`scopedApplicationRead`).
  A reference table as any write target is refused, with a fragment or without. `scope` itself refuses a table the
  capability reaches for no use the site may make of it, and its types (`FragmentTable` in `orm-types.ts`) make that
  a type error at the table argument when the capability's dimension and action are literal. A fragment is a frozen object without a prototype;
  what it holds lives in a module-private `WeakMap` read through methods bound at load, so no object an application
  builds or patches passes for one, and the tag refuses a fragment of another site. Before it splices anything, the
  tag checks every interpolation's place in the original text (code level, not a literal, a quoted name, a dollar
  body or a comment, fragments with no value included) and each fragment's: alone, joined by AND, at the top level
  of a WHERE or JOIN … ON clause with no top-level OR or BETWEEN (`checkConjunct`). Then `classifySql` reads the
  whole statement. Never let any other object splice text.
- **`Database` is frozen, the class and its prototype, and so are `openPostgres` and `openSqlite`.** Application
  modules load after them, and a replaced opener would receive the database URL or the object's storage;
  `@fabrika/app/bun` also takes `openPostgres` before it imports the application. Never add a writable static. `hardening.test.ts` is the witness; `@fabrika/check`'s
  `framework-write` refuses the write in source.
- **Bind scalars only.** `ctx.sql` encodes a list as a Postgres array literal (one text parameter) for the same
  reason. `Bun.SQL` mis-binds a JS array (`in` lists are expanded into parameters) and
  stores a bound JSON string as a JSON string, so values are strings, numbers, bigints, booleans, Dates
  or null; the guard refuses anything else in a `ValueNode`. The pool runs with `prepare: false`:
  otherwise Bun keeps one prepared statement per distinct SQL text, and `in` lists of different
  lengths make that grow without bound.
- **A `Date` is bound as its ISO 8601 UTC text, in one place per dialect: the layer's compiler** (`ParameterCompiler`
  in `database.ts`, `SqliteCompiler` in `sqlite.ts`). Unprepared, `Bun.SQL` sends a `Date` as `Date#toString()`, which Postgres refuses as a
  timestamp in every time zone. An invalid `Date` is refused there with `QueryRefusedError` before anything is sent. Callers bind
  `Date` values; never convert one at a call site. `runFixedStatement` skips the compiler, so `FixedParameter`
  has no `Date`. `date-binding.test.ts` is the witness, in a process west of UTC.
- **The guard depends on Kysely internals** (node factories marked `@internal`, node property names,
  the operator and function strings the compiler prints). `kysely` and `kysely-postgres-js` are pinned
  exactly; `guard.test.ts` and `type-attacks.test.ts` are the upgrade check.
- **The guard and every policy and allowlist check use only the built-ins `builtins.ts` captured at
  load, index loops, and frozen `NameSet` lookups.** Loading `database.ts` freezes the Kysely compiler's
  prototype chain. Both close the two same-process attacks that succeeded against the spike (patching
  the compiler after the guard ran; patching `Set.prototype.has`). Do not use an iterator, a spread, a
  `Set`/`Map` method or a prototype method in `guard.ts`, `identifier.ts`, or a check in `policy.ts`,
  `description.ts` or `store.ts`. Building the tree (`nodes.ts`, the value `Map`) still uses ordinary
  built-ins, so a patched `Array.prototype.map` can change what is built after the checks passed.
- **A caller's array is read only through `parseList`:** a plain array, by index, through own data
  properties. A subclass, an own property besides the indexes and `length` (an own `map`, `filter` or
  `Symbol.iterator`), a hole or an accessor element is refused, so no method the input owns ever runs.
  Each element is validated before it is copied.
- **Unknown keys in insert and update data are refused, not dropped**, so an agent learns about them.
  The key, scope columns, version and `createdBy` are stamped by the layer and can never be written.
- **A column with its own read action** (`columns: { c: { read } }`) is read, filtered and sorted only by a capability
  of exactly that action reading its own target; a read by the table's read action never returns it.
- **A column with its own write action** (`columns: { assignee: { write: 'tasks.assign' } }`) is updated only by a
  capability of that action, through a handle's `update` (`updatingRef` + `updatableBy`), and the table's update action
  does not update it: such a column is not in `update`, its action is not the table's update action, and no stamped
  column takes one (the parse refuses each). The action counts as one the table names, so its `Ref` reads its own row.
  It is in the artifact (`columns.<c>.write`), so the static reader reads it and a new one widens the approval diff.
- **An update sets any subset of the columns its action updates, and never bumps the version alone.** One that sets
  none (`{}`, or only `undefined` values) is no UPDATE: `updateRow` selects its acknowledgement under the same scope,
  conditions and `expectVersion`, so it answers the row's current `{ id, version }`, 404 or 409 and writes nothing.
- **An invocation's transaction ends once, and never commits after a refused statement.** `InvocationTransaction`
  opens on its first statement (setting `idle_in_transaction_session_timeout`), or on SQLite before its work, inside
  `enclose`; a statement the database refused
  marks it failed: Postgres answers a COMMIT of an aborted transaction with a silent ROLLBACK, so `commit()` rolls back
  and throws instead. Ended (no statement runs in it, a kept `Session` included) and released (its connection is back
  in the pool) are two states: its body is a Kysely `transaction().execute` that waits for the framework's decision,
  so the connection goes back whether the COMMIT succeeded, failed or the connection died. Never move it onto a
  controlled transaction, which keeps the connection after a failed COMMIT. A query's (`readOnly`) is `READ ONLY`, and
  so is any invocation while `DataLayerRuntime.readOnly` holds.
- **A driver failure leaves the layer as a `DatabaseError` with its SQLSTATE only** (`Session`, at every statement,
  BEGIN, COMMIT and ROLLBACK). The driver's message, detail and hint can quote the whole failing row, hidden columns
  included; never attach the driver's error, its message or its fields. The SQLite engine maps its constraint failures
  to the same SQLSTATEs (see above). Bun's driver rejects its release of a
  connection the database already closed without awaiting it, so such a loss also prints one unhandled rejection
  (`connection-loss.ts` runs that case in a process of its own).
- **Every capability reads the key and the version.** A column policy on either is refused: a page is ordered by the
  key and a write answers both. A list's every order column, the synthesized tiebreak included, is held to the
  capability's columns, and its cursor is the database's text of each (`cast(… as text)`, the one cast the guard
  admits, as a selected own column), so a timestamp keeps its microseconds.
- **Every handle checks its site first** (`DataSite.check`, the framework's binding to its invocation), then refuses
  what the site's kind or declaration does not allow with the message its type gives, then runs the store's own
  checks. A handle is built per invocation; never cache one across invocations or skip the check for a read.
- **Codegen types a column exactly as the layer answers it, or refuses it** (SQLite's declared types: see above). On
  Postgres `int8` and `numeric` are
  strings (bound as a number, bigint or string); a `date` is `YYYY-MM-DD` text, which a handle selects as the
  database's own text (`cast(… as text)`, the column list's `dates`), never through the `Date` `Bun.SQL` decodes, which
  drifts by the process's offset outside 0001–9999; such a day is refused. A timestamp is a `Date`; a write also takes
  strict ISO 8601 text with `Z` or an offset (the column list's `timestamps`), and refuses `now`, `10/12/2026` or an
  impossible day before anything is sent, as a day's text must be a real `YYYY-MM-DD`. An enum is its label union; JSON,
  `bytea`, arrays and domains are refused rather than typed `unknown`, because the layer cannot bind
  them. `codegen.test.ts` pins every mapping against a real decode. The fixture `schema.generated.ts`
  is codegen output that the Postgres suite regenerates byte for byte: change the renderer and the
  fixture together. Interface names are `<Pascal>Table`, with a `T` prefix when the name would not
  start with a letter; a collision, and the table names `__proto__`, `constructor` and `prototype`, are
  refused. `fabrika db codegen --verify` compares text, so an application's formatter must
  skip the generated file (the output is already dprint-stable here).
- **Codegen on Postgres refuses a schema that escapes or holds undeclared database code** (ADR-0017): it runs the
  migration runner's own pre-commit catalog query (`databaseCodeQuery`, `@fabrika/platform-node`) against
  the migrations' manifest (`PostgresApplicationMigrations.objects()`, which the CLI and the test kit pass;
  `introspectSchema`/`generateSchema` take it as an argument). It refuses an integrity escape (a
  `SECURITY DEFINER` function, a function `SET` clause or foreign language, a dependency outside the
  schema and `pg_catalog`, a sequence other than an identity column's, a routine overload) and any trigger,
  rule, view, function, policy or domain no migration
  declares: a store's guarded write would fire such code unseen, and a declared one is a deviation the
  approver already saw. This is what finds an object created at runtime, at every start (`codegen
  --verify`) and in the test kit. It runs in a read-only transaction that pins `search_path` and
  `standard_conforming_strings`, so a role-level setting cannot blind it.
