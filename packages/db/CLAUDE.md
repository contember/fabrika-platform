# @fabrika/db

The scoped data layer for applications on Postgres: handlers reach rows only through a capability
(`Ref` or `Within`) and only for the operation its action allows. It runs inside the application
process, so it stops honest mistakes and makes a bypass conspicuous; it is not a hard boundary against
code in the same process. Design: [ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md),
[ADR-0017](../../docs/decisions/0017-service-owned-postgres-migrations.md) for its migrations, and
[application runtime](../../docs/reference/application-runtime.md) for how `serve` and `boot` bind it.
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`): applications depend on it.

```bash
bun run typecheck
bun test    # policy · derived-tables · tables · store · guard · hardening · type-attacks · codegen · testing · postgres, orm, data-ergonomics (need FABRIKA_TEST_POSTGRES_URL)
```

| Module                 | What it owns                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtins.ts`          | The built-ins captured at load, `NameSet`, and `parseList`, the one way a caller's array is read.                                                              |
| `capability.ts`        | `Ref` / `Within` (opaque, type-only member), `CapabilityAuthority`, `MAX_WITHIN_VALUES`; no Bun.                                                               |
| `policy.ts`            | `defineTables` / `readTables`: the table policies, containment derived from the vocabulary, checked against the column list; row types.                        |
| `orm-types.ts`         | The mini-ORM's handle types and `DbIndex`, which `@fabrika/app`'s kit builds once; types only, exported by `@fabrika/db/tables` too.                           |
| `orm.ts`               | The mini-ORM at runtime: the `ctx.db` handles of one site, own-target read, `getForUpdate`, keyset lists, `unscoped`; `dataAccess`.                            |
| `vocabulary-tables.ts` | The vocabulary form of the policies (authoring and normalized types), `TypedColumnList`; types only.                                                           |
| `tables.ts`            | `@fabrika/db/tables`, browser-safe: the policies as data (`tablePolicies`), each inbox's columns (`inboxColumns`), `readTables`, `isTables`.                   |
| `temporal.ts`          | Days and timestamps at the boundary: a read's `YYYY-MM-DD` (`answerDays`), a write's strict day and ISO 8601 text (`dayInput`, `timestampInput`).              |
| `description.ts`       | `ScopedSelect`: the frozen, non-executable query description a store callback receives.                                                                        |
| `nodes.ts`             | Kysely operation nodes built from a description and a scope predicate.                                                                                         |
| `guard.ts`             | The allowlist over the final operation tree, run immediately before compiling.                                                                                 |
| `database.ts`          | `Database` (no public query method), `Session` (the only path to it), `InvocationTransaction`, `applicationSchema` (`app_<id>`).                               |
| `sql.ts`               | `ctx.sql`: `classifySql` (the template's static text over `@fabrika/platform-node/sql`), the value binding, the row parse, `sqlTag`.                           |
| `store.ts`             | `scoped(tables)` → `ScopedDatabase`; the stores (`defineStore`, framework tests only); the generated locator; every check.                                     |
| `registry.ts`          | Which objects `scoped` created and the framework side of each (bind once → the locator); module-private.                                                       |
| `framework.ts`         | `@fabrika/db/framework`, for `@fabrika/app` only: `bindScopedDatabase`, `isScopedDatabase`, `fileTablesOf`, `frameworkTablesOf`, `dataAccessOf`; browser-safe. |
| `file-table-sql.ts`    | A file collection's table name (`fabrika_files_<name>`), its DDL (`fileTableSql`) and the scan migration (`fileScanSql`); pure.                                |
| `file-tables.ts`       | A file collection's rows, every request-made operation scoped by its `Ref`'s chain, as guarded trees.                                                          |
| `links.ts`             | A `Ref`'s predicate over a table's containment links, shared by the stores and the file tables.                                                                |
| `framework-tables.ts`  | The webhook bindings and delivery keys the framework writes itself, as guarded trees.                                                                          |
| `job-leases.ts`        | `fabrika_job_leases` and `fabrika_job_kicks`: a job run's lease, its generations and deadlines, a kick's pending run, the last run; `fencedTransaction`.       |
| `form-admissions.ts`   | `fabrika_form_admissions` and `fabrika_form_challenges`: a form's per-minute buckets and accepted challenge tokens, one statement each.                        |
| `migrations.ts`        | `@fabrika/db/migrations`: the framework's own tables (`fabrika_*`), the bundle `fabrika`; plain data.                                                          |
| `codegen.ts`           | `@fabrika/db/codegen`: `src/db/schema.generated.ts` (types, `DB`, each table's columns and foreign keys as `TypedColumnList<DB>`).                             |
| `testing.ts`           | `@fabrika/db/testing`, test files only: `testDatabase`, the isolation fixtures, `tableProbe`, `withoutInboxes`, the framework's `defineStore`.                 |
| `production.ts`        | `@fabrika/db/production`: the mark of a process that serves an application, which the test kits refuse.                                                        |

Migrations are applied by `@fabrika/platform-node`'s application runner through `fabrika db migrate`
(ADR-0017); `fabrika db codegen` calls `codegen.ts`.

An application calls `scoped(tables)` once, in `src/app.ts`, and passes it to `serve(contract, { database })`; its
handlers reach data through `ctx.db` (`orm.ts`). The result carries the policies and nothing else: the stores
(`defineStore(layer, table, build)` / `defineChildStore`) are the framework's own test entry, exported from
`@fabrika/db/testing` only. `@fabrika/app/bun` opens
`Database.postgres` as the runtime role `run_<FABRIKA_APP_ID>`, whose URL `@fabrika/platform-node` derives from the
provisioning credential `FABRIKA_APP_DATABASE_URL`, on `app_<FABRIKA_APP_ID>`; `boot` binds the layer to it and to
the runtime's `CapabilityAuthority` (one per `boot`), which binds each capability to its request, through
`@fabrika/db/framework`. The bind answers the locator `on` and `in` use: one guarded select by key of the owning
table's containment columns. `frameworkTablesOf` gives the framework the writes no store makes: a `c.form`
appends one row to its inbox table (the declared columns only, answering nothing), taking one from the form's
accepted bucket in the same transaction, and `c.webhook` keeps its
bindings and delivery ids in `fabrika_webhook_bindings` and `fabrika_webhook_deliveries`. The job runner of
`@fabrika/app` takes a job's lease in `fabrika_job_leases` (`frameworkTablesOf(…).jobs`), and a form's admission
takes from its per-minute buckets in `fabrika_form_admissions` and records accepted challenge tokens in
`fabrika_form_challenges` (`frameworkTablesOf(…).forms`). `fabrika db migrate`
applies those tables (`@fabrika/db/migrations`) as the bundle `fabrika` before the application's `app` bundle.
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
Not built yet: reading an inbox on the road (an `unscoped` declaration reads it).

`@fabrika/db/testing` is the database half of the generated isolation tests (`fabrika db test-scaffold`, A11):
`testDatabase` migrates a fresh `app_test_<hex>` schema with its own role family through `@fabrika/platform-node`'s
application runner (`migrate`, as the migration role: the framework's tables, then the application's, as
`fabrika db migrate` applies them), connects and seeds as its runtime role, so every test of
application code runs least-privileged, or answers `null` after the standard skip message; `seedWorlds` seeds one row of a table in each of two containment
chains that share no value, every container row a table owns first, with the author's seed values in the table's own
row (never a column that places it, nor a text column that holds a marker the leak cases look for), and answers each row's `chain` of dimension values (a share link's chain); `seedUnder` seeds a row in a seeded row's object (a child row a fixture names); `tableProbe` reaches one table of a layer by
name. `@fabrika/app/testing/isolation` builds the policy isolation and endpoint access tests on them. Every text
column the seeding fills holds a distinct marker, so a leaked value is recognised anywhere in an answer, except a
foreign key outside the chain (`null`, or the key of a reference or application row) and a column a CHECK names (an
`IN` list's first value, or `null`). What the seeding cannot satisfy is a `SeedLimitError` naming the constraint.
There is no generated `move` case yet: an access form hands a handler one capability, and `t.move` needs the source
and the target `Ref`, so no handler can call it.

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
- **Every action is the vocabulary's.** Table actions, an inbox's `scope.read` and a column's own read action are
  refused unless the vocabulary declares them, in the one parse: the reader refuses them from source too.
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
  mode that may be `'write'` (a union or an optional one too) of a reference or inbox table is an `Unavailable` at its
  key (`ReadOnlyUnscoped`): no site writes either, and
  `insertUnscoped` still refuses it at run time. Neither has a key, so its unscoped `get` is an `Unavailable` that says
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
  through a raw connection of its own, as the runtime role. Its seeding fills a required column it does not place with a sample of the
  column's type, and refuses a type codegen refuses.
- **A throwaway schema is held by its advisory lock for its whole life.** The lock (SHA-256 of
  `fabrika-test-schema:<name>`) is taken on a reserved connection before the schema and its roles exist. Each
  `testDatabase` first drops every `app_test_*` schema and `app_test_*`/`run_test_*` role family whose lock it can
  take, and never one whose lock is held. A failed migration drops the schema and the roles, and `close` runs every
  cleanup step even when one throws. `FABRIKA_TEST_POSTGRES_URL` is a provisioning credential: it must be able to
  create roles (a superuser, or `CREATEROLE` with `CREATE` on the database); `fabrika db test-isolation` hands it a
  throwaway one. A family the kit cannot administer (another provisioner's) is left to its creator.
- **`@fabrika/db/framework` imports no Bun API and no driver**: the Worker adapter imports `boot`, which imports it.
  It takes only types from `file-tables.ts` (which needs the driver); `store.ts` builds the file tables of a layer.
- **A file row carries its owner's whole chain**, under a composite foreign key with `ON UPDATE CASCADE` and
  `ON DELETE SET NULL`, and every operation a request makes on it takes the request's `Ref` and is scoped by that
  chain (`links.ts`, shared with the stores). Never add one keyed by the id alone: a `Ref` minted before its owner
  moved would still reach the file. The pending insert and its completion lock the owner row `for share` on the
  owner `Ref`'s chain in their transaction. Only a removed, orphaned or stale pending row is ever purged, after its
  object. `list` takes the owner's `Ref` for the read action, never the write one; `removeOwned` takes one for the
  delete action and also marks the owner's pending uploads removed, so an upload begun before an erasure never
  completes after it. `find`, `locate`, `list` and `removeOwned` run in
  the session their caller passes (`using`: `@fabrika/app`'s `ctx.files` passes the site's), so a removal commits or
  rolls back with the invocation.
- **A file row is `pending`, `quarantined`, `live` or `rejected`** (`FILE_STATUSES`, the named check `<table>_status`).
  A held file (`live`, `quarantined`, `rejected`) is located, found, listed, counted against the quota and removable;
  a removed or orphaned one is purgeable in every held state. A scanning collection's table carries `object_version`,
  `scan_attempts` and `scan_after`, and only a spec with `scan: true` reads them. `scan_after` is when a quarantined
  file became due — its completion, its re-quarantine, or its next try — and `quarantined` returns the due files
  oldest first by it (`dueSince`), so the scan pass can order every collection's files together. The scan writes `promote` (which
  records the scanned object's version), `reject` and `deferScan` are the only writes keyed by the id alone, and only
  inside a job attempt's lease (`fencedTransaction`; without a fence they throw); `requarantine` takes the download's
  `Ref`. The SQL all readers agree on lives in `@fabrika/platform-node/sql`'s `file-table-ddl.ts`: `fileTableSql` and
  `fileScanSql` write it, the classifier admits exactly the scan statement, and the checker recognizes it.
  `framework-tables.ts` reads a unique violation off `DatabaseError.sqlState`; `framework.ts` imports only its types,
  and `store.ts` builds the implementation.
- **A delivery key is recorded by its primary key.** The `delivery_id` column holds the key `@fabrika/app` derives
  from the binding and the signed body, never an unsigned header. Two concurrent copies of one delivery insert the
  same `(binding_id, delivery_id)`; exactly one succeeds and the other answers "already recorded". Never replace this
  with a read before the insert. `recordDelivery` first drops the binding's keys older than its retention bound.
- **Every mutation of a job attempt is fenced by its lease** (`fencedWork` in `store.ts` → `fencedTransaction`). The
  authority's `fence()` names the attempt, or `null` in a request. In the mutation's transaction, before the write:
  a `for share` select requires the attempt's generation, holder and an unpassed `attempt_deadline`, and
  `statement_timeout` and `idle_in_transaction_session_timeout` are set to the time left. Just before `COMMIT` the same
  check runs again. A failed check, a statement the deadline cancelled, or `cancelInFlight` (the runner calls it when
  the attempt ends) rolls back with `LeaseLostError`. `cancelInFlight` aborts the transaction itself (`Session.transaction`'s
  signal), so it rolls back and gives its connection back even while its work waits on something else, and cancels a
  statement still running, matched by pid and `xact_start` so a reused pid is left alone. The lock makes a takeover or a renewal wait for the write, so no write of an old
  generation commits after a newer one was granted. A store's write runs in `fencedWork`; a handle's in its site's
  session: an invocation's transaction (a request or a webhook delivery, which hold no lease) or a job's
  `ctx.transaction`, which is `fencedWork`. A job's handles outside it refuse every write. Never add a write path
  outside these.
- **Every lease time is the database's clock.** `acquire`, `renew`, `finish`, `reapCrashed` and `claimOverdue` take
  durations and compute and compare with `now()` (`clock_timestamp()` inside a mutation's transaction, where `now()`
  is its start). Never bind a process timestamp: two containers' clocks disagree.
- **A lease changes hands in one conditional statement.** `acquire` takes only a free lease; an expired lease whose
  holder never finished is freed first by `reapCrashed`, whose one winner reports the crash. `renew` and `finish`
  match the caller's generation and holder. `claimOverdue` sets `last_missed_reported_at` at most once per period, so
  one of many concurrent checkers reports. `tryAcquire` is `acquire` for a kick, on a connection requests share: it
  takes the row `for update skip locked`, so it answers `null` at once instead of waiting on an attempt's fence. A
  kick's pending flag is `fabrika_job_kicks`, apart from the lease row for the same reason: `markPending` sets it,
  and `takePending` clears it for one caller. Never read a lease and then write it.
- **The lease and admission statements are fixed SQL** (`runFixedStatement` in `database.ts`, which no subpath
  exports): they need `now()`, `set_config`, `pg_backend_pid()`, `on conflict` and `skip locked`, which the guard
  refuses on purpose. Only `job-leases.ts` and `form-admissions.ts` call it, with constant texts and scalar parameters;
  never build a text from a value.
- **A form bucket is taken in one statement** (`take`: an upsert whose update only runs below the limit), so
  concurrent instances never admit past it; never read a counter and then write it. Every take and every challenge
  record also prunes up to 32 expired rows with `for update skip locked` (no wait, so no deadlock), never the row it
  writes itself, so both tables hold only the last minutes. Times are the database's.
- **The framework migrations are migration identity** (ADR-0017): never edit an entry of `FRAMEWORK_MIGRATIONS`,
  add one.
- **`applicationSchema` derives what `@fabrika/platform-node`'s `applicationDatabaseSchema` derives** (ADR-0017);
  `tables.test.ts` compares them. Change both together.

- **A read-only request writes nothing.** `DataLayerRuntime.readOnly` (the framework's
  `requestIsReadOnly`, true in an export's request) makes every session read-only — a store's, the
  locator's, the file, webhook and job-lease tables' — because `sessionOf` takes the runtime, never the bare
  connection: `Session.run` refuses
  any root but a select, and any lock, before compiling, whatever capability the operation carries,
  and runs each statement in a `READ ONLY` transaction (`transaction()` opens one too). Never route a
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
- **A Within carries at most `MAX_WITHIN_VALUES` (1000) scope values, its own and its containers' together.** Each
  is one bound parameter of every statement it scopes (Postgres binds at most 65535); the framework refuses to
  mint a larger one and the layer refuses to use one.
- **A Ref's predicate covers every link of its chain, one equality per chain column.** A table carries
  a column for each ancestor (`TableModel.chain`, resolved by `defineTables` through the tables that own
  each dimension); a `Ref` whose chain names a dimension the table has no column for is refused, never
  ignored. Otherwise a `Ref` minted before an ancestor moved would still reach its rows.
- **An insert into a container, a child insert and a move lock the destination row first** (`FOR SHARE`,
  matched on the destination `Ref`'s whole chain, in the mutation's transaction; `lockDestination`), when a
  table owns the destination dimension. A
  stale destination is 404 and nothing is written. The guard admits that lock only with `GuardContext.lock: 'share'`,
  and a handle's `getForUpdate` (`FOR UPDATE` of its own target in a mutation) only with `lock: 'update'`; it admits
  no other lock, no `NOWAIT`, `SKIP LOCKED` or `OF`.
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
  private execute, so a statement the database refuses fails the invocation. Any refusal of the tag after its binding check (a statement, a value, a row) fails the site's transaction too (`SqlSite.fail`: `InvocationTransaction.fail` or `Session.fail`), so a handler that catches it still commits nothing; a nested `Session.transaction` with a failed statement throws instead of committing. A row error names the schema's top-level field and the issue's code and expected type, never the issue's message, a deeper path or a value. `QueryRefusedError` carries a `reason` from the closed `QUERY_REFUSALS` catalog, and `CapabilityError` one from `CAPABILITY_ERRORS`; `@fabrika/app` logs only the reason and its catalog text (as `query_refused` and `capability_refused`, for a request and a job attempt alike), never the message, which may quote a value the request sent. A new refusal picks a reason, or adds one with its fixed text. Do not add another method that takes
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
- **`Database` is frozen, the class and its prototype.** Application modules load after `database.ts`, and a
  replaced `Database.postgres` would receive the database URL; `@fabrika/app/bun` also takes the factory before it
  imports the application. Never add a writable static. `hardening.test.ts` is the witness; `@fabrika/check`'s
  `framework-write` refuses the write in source.
- **Bind scalars only.** `ctx.sql` encodes a list as a Postgres array literal (one text parameter) for the same
  reason. `Bun.SQL` mis-binds a JS array (`in` lists are expanded into parameters) and
  stores a bound JSON string as a JSON string, so values are strings, numbers, bigints, booleans, Dates
  or null; the guard refuses anything else in a `ValueNode`. The pool runs with `prepare: false`:
  otherwise Bun keeps one prepared statement per distinct SQL text, and `in` lists of different
  lengths make that grow without bound.
- **A `Date` is bound as its ISO 8601 UTC text, in one place: the layer's compiler** (`ParameterCompiler` in
  `database.ts`). Unprepared, `Bun.SQL` sends a `Date` as `Date#toString()`, which Postgres refuses as a
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
  opens on its first statement (setting `idle_in_transaction_session_timeout`), and a statement the database refused
  marks it failed: Postgres answers a COMMIT of an aborted transaction with a silent ROLLBACK, so `commit()` rolls back
  and throws instead. Ended (no statement runs in it, a kept `Session` included) and released (its connection is back
  in the pool) are two states: its body is a Kysely `transaction().execute` that waits for the framework's decision,
  so the connection goes back whether the COMMIT succeeded, failed or the connection died. Never move it onto a
  controlled transaction, which keeps the connection after a failed COMMIT. A query's (`readOnly`) is `READ ONLY`, and
  so is any invocation while `DataLayerRuntime.readOnly` holds.
- **A driver failure leaves the layer as a `DatabaseError` with its SQLSTATE only** (`Session`, at every statement,
  BEGIN, COMMIT and ROLLBACK). The driver's message, detail and hint can quote the whole failing row, hidden columns
  included; never attach the driver's error, its message or its fields. Bun's driver rejects its release of a
  connection the database already closed without awaiting it, so such a loss also prints one unhandled rejection
  (`connection-loss.ts` runs that case in a process of its own).
- **Every capability reads the key and the version.** A column policy on either is refused: a page is ordered by the
  key and a write answers both. A list's every order column, the synthesized tiebreak included, is held to the
  capability's columns, and its cursor is the database's text of each (`cast(… as text)`, the one cast the guard
  admits, as a selected own column), so a timestamp keeps its microseconds.
- **Every handle checks its site first** (`DataSite.check`, the framework's binding to its invocation), then refuses
  what the site's kind or declaration does not allow with the message its type gives, then runs the store's own
  checks. A handle is built per invocation; never cache one across invocations or skip the check for a read.
- **Codegen types a column exactly as the layer answers it, or refuses it.** `int8` and `numeric` are
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
- **Codegen refuses a schema that escapes or holds undeclared database code** (ADR-0017): it runs the
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
