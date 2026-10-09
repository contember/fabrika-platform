# @fabrika/db

The scoped data layer for applications on Postgres: handlers reach rows only through a capability
(`Ref` or `Within`) and only for the operation its action allows. It runs inside the application
process, so it stops honest mistakes and makes a bypass conspicuous; it is not a hard boundary against
code in the same process. Design: [scoped database access](../../docs/ideas/scoped-database-access.md).
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`): applications depend on it.

```bash
bun run typecheck
bun test    # policy · tables · store · guard · hardening · type-attacks · codegen · testing · postgres (needs FABRIKA_TEST_POSTGRES_URL)
```

| Module                | What it owns                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtins.ts`         | The built-ins captured at load, `NameSet`, and `parseList`, the one way a caller's array is read.                                              |
| `capability.ts`       | `Ref` / `Within` (opaque, type-only member), `CapabilityAuthority`, `MAX_WITHIN_VALUES`; no Bun.                                               |
| `policy.ts`           | `defineTables` / `readTables`: the table policies, checked against the generated column list; row types.                                       |
| `tables.ts`           | `@fabrika/db/tables`, browser-safe: the policies as data (`tablePolicies`), `readTables`, `isTables`.                                          |
| `description.ts`      | `ScopedSelect`: the frozen, non-executable query description a store callback receives.                                                        |
| `nodes.ts`            | Kysely operation nodes built from a description and a scope predicate.                                                                         |
| `guard.ts`            | The allowlist over the final operation tree, run immediately before compiling.                                                                 |
| `database.ts`         | `Database` (no public query method), `Session` (the only path to it), `applicationSchema` (`app_<id>`).                                        |
| `store.ts`            | `scoped(tables)` → `ScopedDatabase` (the stores); the generated locator; every capability check.                                               |
| `registry.ts`         | Which objects `scoped` created and the framework side of each (bind once → the locator); module-private.                                       |
| `framework.ts`        | `@fabrika/db/framework`, for `@fabrika/app` only: `bindScopedDatabase`, `isScopedDatabase`, `fileTablesOf`, `frameworkTablesOf`; browser-safe. |
| `file-table-sql.ts`   | A file collection's table name (`fabrika_files_<name>`) and its DDL (`fileTableSql`); pure.                                                    |
| `file-tables.ts`      | A file collection's rows, every request-made operation scoped by its `Ref`'s chain, as guarded trees.                                          |
| `links.ts`            | A `Ref`'s predicate over a table's containment links, shared by the stores and the file tables.                                                |
| `framework-tables.ts` | The webhook bindings and delivery keys the framework writes itself, as guarded trees.                                                          |
| `job-leases.ts`       | `fabrika_job_leases`: a job run's lease, its generations and deadlines, the last run; `fencedTransaction`.                                     |
| `migrations.ts`       | `@fabrika/db/migrations`: the framework's own tables (`fabrika_*`), the bundle `fabrika`; plain data.                                          |
| `codegen.ts`          | `@fabrika/db/codegen`: `src/db/schema.generated.ts` (types, `DB`, column list) from a migrated schema.                                         |
| `testing.ts`          | `@fabrika/db/testing`, test files only: `testDatabase`, the isolation fixtures, `tableProbe`.                                                  |
| `production.ts`       | `@fabrika/db/production`: the mark of a process that serves an application, which the test kits refuse.                                        |

Migrations are applied by `@fabrika/platform-node`'s application runner through `fabrika db migrate`
(ADR-0017); `fabrika db codegen` calls `codegen.ts`.

An application calls `scoped(tables)` once (its own `src/db/database.ts`), defines its stores with the
`defineStore` / `defineChildStore` it carries, and passes it to `implement({ database })`. `@fabrika/app/bun` opens
`Database.postgres` on `FABRIKA_APP_DATABASE_URL` and `app_<FABRIKA_APP_ID>`; `boot` binds the layer to it and to
`requestCapabilities`, the framework's `CapabilityAuthority`, which binds each capability to its request, through
`@fabrika/db/framework`. The bind answers the locator `on` and `in` use: one guarded select by key of the owning
table's containment columns. `frameworkTablesOf` gives the framework the writes no store makes: a `c.form`
appends one row to its inbox table (the declared columns only, answering nothing), and `c.webhook` keeps its
bindings and delivery ids in `fabrika_webhook_bindings` and `fabrika_webhook_deliveries`. The job runner of
`@fabrika/app` takes a job's lease in `fabrika_job_leases` (`frameworkTablesOf(…).jobs`). `fabrika db migrate`
applies those tables (`@fabrika/db/migrations`) as the bundle `fabrika` before the application's `app` bundle. Not
built yet: a store for `reference` tables, and reading an inbox.

`@fabrika/db/testing` is the database half of the generated isolation tests (`fabrika db test-scaffold`, A11):
`testDatabase` migrates a fresh `app_test_<hex>` schema through `@fabrika/platform-node`'s application runner, or
answers `null` after the standard skip message; `seedWorlds` seeds one row of a table in each of two containment
chains that share no value, every container row a table owns first; `tableProbe` reaches one table of a layer by
name. `@fabrika/app/testing/isolation` builds the policy isolation and endpoint access tests on them. Every text
column the seeding fills holds a distinct marker, so a leaked value is recognised anywhere in an answer.
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
  and arrays only, read through own data properties, unknown fields refused. The static reader reads
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
  through a raw connection of its own. Its seeding fills a required column it does not place with a sample of the
  column's type, and refuses a type codegen refuses.
- **A throwaway schema is held by its advisory lock for its whole life.** The lock (SHA-256 of
  `fabrika-test-schema:<name>`) is taken on a reserved connection before the schema exists. Each `testDatabase` first
  drops every `app_test_*` schema whose lock it can take, and never one whose lock is held. A failed migration drops
  the schema, and `close` runs every cleanup step even when one throws.
- **`@fabrika/db/framework` imports no Bun API and no driver**: the Worker adapter imports `boot`, which imports it.
  It takes only types from `file-tables.ts` (which needs the driver); `store.ts` builds the file tables of a layer.
- **A file row carries its owner's whole chain**, under a composite foreign key with `ON UPDATE CASCADE` and
  `ON DELETE SET NULL`, and every operation a request makes on it takes the request's `Ref` and is scoped by that
  chain (`links.ts`, shared with the stores). Never add one keyed by the id alone: a `Ref` minted before its owner
  moved would still reach the file. The pending insert and its completion lock the owner row `for share` on the
  owner `Ref`'s chain in their transaction. Only a removed, orphaned or stale pending row is ever purged, after its
  object. Timestamps are bound as ISO strings: a bound `Date` reaches Postgres as `Date#toString()` through this
  driver.
  `framework-tables.ts` needs `bun` too (it reads a unique violation off `SQL.PostgresError`); `framework.ts` imports
  only its types, and `store.ts` builds the implementation.
- **A delivery key is recorded by its primary key.** The `delivery_id` column holds the key `@fabrika/app` derives
  from the binding and the signed body, never an unsigned header. Two concurrent copies of one delivery insert the
  same `(binding_id, delivery_id)`; exactly one succeeds and the other answers "already recorded". Never replace this
  with a read before the insert. `recordDelivery` first drops the binding's keys older than its retention bound.
- **Every mutation of a job attempt is fenced by its lease** (`mutation()` in `store.ts` → `fencedTransaction`). The
  authority's `fence()` names the attempt, or `null` in a request. In the mutation's transaction, before the write:
  a `for share` select requires the attempt's generation, holder and an unpassed `attempt_deadline`, and
  `statement_timeout` is set to the time left. Just before `COMMIT` the same check runs again. A failed check, a
  statement the deadline cancelled, or one `cancelInFlight` cancelled (the runner calls it when the attempt ends)
  rolls back with `LeaseLostError`. The lock makes a takeover or a renewal wait for the write, so no write of an old
  generation commits after a newer one was granted. Never add a write path outside `mutation()`.
- **Every lease time is the database's clock.** `acquire`, `renew`, `finish`, `reapCrashed` and `claimOverdue` take
  durations and compute and compare with `now()` (`clock_timestamp()` inside a mutation's transaction, where `now()`
  is its start). Never bind a process timestamp: two containers' clocks disagree.
- **A lease changes hands in one conditional statement.** `acquire` takes only a free lease; an expired lease whose
  holder never finished is freed first by `reapCrashed`, whose one winner reports the crash. `renew` and `finish`
  match the caller's generation and holder. `claimOverdue` sets `last_missed_reported_at` at most once per period, so
  one of many concurrent checkers reports. Never read a lease and then write it.
- **The lease statements are fixed SQL** (`runFixedStatement` in `database.ts`, which no subpath exports): they need
  `now()`, `set_config`, `pg_backend_pid()` and `on conflict`, which the guard refuses on purpose. Only `job-leases.ts`
  calls it, with constant texts and scalar parameters; never build a text from a value.
- **The framework migrations are migration identity** (ADR-0017): never edit an entry of `FRAMEWORK_MIGRATIONS`,
  add one.
- **`applicationSchema` derives what `@fabrika/platform-node`'s `applicationDatabaseSchema` derives** (ADR-0017);
  `tables.test.ts` compares them. Change both together.

- **Every select, update and delete carries its scope predicate as the top-level right conjunct of
  WHERE, by identity.** The caller's conditions sit in a `ParensNode` on the left. The guard checks this
  shape (`checkRoot`); without the parenthesis, `true or 1=1` followed by the scope would match every
  row. An insert carries no WHERE and gets its scope columns stamped from the capability instead.
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
  stale destination is 404 and nothing is written. The guard admits that one lock only with
  `GuardContext.lock`.
- **Mutations answer `{ id, version }` (and `move` the new chain), never row data.** A write action does
  not include the read action; returning the row would leak columns the caller may not read.
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
- **No raw handle leaves the package.** `Database` keeps its Kysely instance in a private field; the
  store reaches it through `sessionOf`, and `Session.run` guards every tree. Do not add a method that
  takes SQL, a builder or an unguarded node.
- **Bind scalars only.** `Bun.SQL` mis-binds a JS array (`in` lists are expanded into parameters) and
  stores a bound JSON string as a JSON string, so values are strings, numbers, bigints, booleans, Dates
  or null; the guard refuses anything else in a `ValueNode`. The pool runs with `prepare: false`:
  otherwise Bun keeps one prepared statement per distinct SQL text, and `in` lists of different
  lengths make that grow without bound.
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
- **A column with its own read action** (`columns: { c: { read } }`) falls back to nothing: every
  read needs the table's read action, so v1 never returns, filters or sorts by such a column.
- **Codegen types a column exactly as `Bun.SQL` decodes it, or refuses it.** `int8` and `numeric` are
  strings (bound as a number, bigint or string), dates are `Date`, an enum is its label union; JSON,
  `bytea`, arrays and domains are refused rather than typed `unknown`, because the layer cannot bind
  them. `codegen.test.ts` pins every mapping against a real decode. The fixture `schema.generated.ts`
  is codegen output that the Postgres suite regenerates byte for byte: change the renderer and the
  fixture together. Interface names are `<Pascal>Table`, with a `T` prefix when the name would not
  start with a letter; a collision, and the table names `__proto__`, `constructor` and `prototype`, are
  refused. `fabrika db codegen --verify` compares text, so an application's formatter must
  skip the generated file (the output is already dprint-stable here).
