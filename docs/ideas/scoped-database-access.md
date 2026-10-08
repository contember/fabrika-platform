# Scoped database access

A proposal for one recommended way for Fabrika applications to talk to their database: a `@fabrika/db`
package over [Kysely](https://kysely.dev). It is part of the [opinionated application framework](opinionated-app-framework.md):
an agent steered by an inexperienced person must not be able to read or change rows the caller may not touch.

The contract says **who** may call an endpoint and hands the handler a `Ref<dim, action>` (one authorized
object, for one action) or a `Within<dim, action>` (the scope values the caller holds the action in). This
layer makes those the only way to reach scoped rows, and only for the operation the action allows.

**What this layer is and is not.** It runs inside the application process. It stops honest mistakes and makes
a bypass conspicuous, but code in the same process with the same credentials can go around it. The checker and,
with [platform enforcement](platform-enforcement.md), the platform-owned build make the bypass hard; per-application
database roles with row-level security are a later hardening step; a platform data executor is the long-term hard
boundary.

## Scope of v1

- **Postgres only** (Bun + Postgres on Zerops). Cloudflare / D1 applications keep raw D1 for now: the D1
  dialect has no interactive transactions, the type sets differ, and
  [ADR-0015](../decisions/0015-repository-operations-are-the-sql-portability-seam.md) already found the
  differences are not only textual. [`portability-surface.md`](../reference/portability-surface.md) rejects
  Kysely for the platform's own dual-dialect services; that reasoning does not carry over to applications,
  and the document should say so.
- **The namespace is the boundary between applications.** A cheap Zerops namespace has one Postgres service and
  one credential, shared by every application in it ([ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md)).
  v1 keeps this: the applications of a cheap namespace trust each other. An application that must be isolated from
  other applications goes to an exclusive namespace. This layer protects rows from the wrong **user**, which is the
  main threat; it does not protect them from another application in the same namespace.

## Schema source of truth

**SQL migration files are the only DDL. Types are generated from a migrated database. The access policy of
each table is declared in `src/db/tables.ts`.**

```
db/migrations/20261008120000_init.sql    # frozen once merged; plain SQL
db/seeds/example.sql                     # local and test only
src/db/schema.generated.ts               # fabrika db codegen output; committed; never hand-edited
src/db/tables.ts                         # the access policy of every application table; a literal
src/db/stores/*.ts                       # the application's queries, written against the scoped API
```

- Types come from `fabrika db codegen` (`@fabrika/db/codegen`), which reads the catalog of `app_<id>`, leaves
  out framework tables (`fabrika_*`: the migration ledger, files, job leases, webhook deliveries), and writes the
  interfaces, `DB` and the runtime column list in one file. It types a column as `Bun.SQL` decodes it and refuses
  a type the layer cannot bind (JSON, `bytea`, arrays, domains). `kysely-codegen` was not used: it writes no
  column list and needs the `pg` driver beside `Bun.SQL`.
  `--verify` runs in the checker's build step against a throwaway Postgres and fails when the committed types
  are stale.
- The driver is [`kysely-postgres-js`](https://github.com/kysely-org/kysely-postgres-js) over `Bun.SQL`. Only
  the framework creates the connection, from a credential it removes from `process.env`. The pool runs with
  `prepare: false`, because Bun keeps a prepared statement per distinct SQL text and `in` lists of different
  lengths make that grow without bound. `Bun.SQL` mis-binds a JavaScript array and stores a bound JSON string
  as a JSON string, so the layer binds scalars only and expands `in` lists into parameters. `int8`, `count`,
  `sum` and `numeric` come back as strings; streaming is not supported, and v1 does not need it.
- Row shapes stay snake_case and mirror the migrations; no `CamelCasePlugin`.

Rejected: a schema declared in TypeScript plus a catalog verifier (a second schema language and two places to
edit), and diff-generated migrations (`drizzle-kit generate` asks interactively about renames and knows nothing
about expand/contract).

## Every table declares its access policy

`tables.ts` is a mapped type over the application's tables; a table without a policy does not compile. The
policy names the action each operation requires. **The file is a literal** (object and array literals, strings,
the `defineTables` call), like the contract, so that Control can read it from the commit without executing it once
[platform enforcement](platform-enforcement.md) exists.

```ts
export const tables = defineTables<DB, typeof contract>()({
	notes: {
		scope: {
			dimension: 'note',
			key: 'id',
			in: { dimension: 'workspace', column: 'workspace_id' },
		},
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.delete',
		},
		insert: ['title', 'body'], // id, scope columns, created_by and created_at are stamped by the layer
		update: ['title', 'body'], // scope columns can never appear here
		version: 'version',
		createdBy: 'created_by',
	},
	note_comments: {
		scope: {
			child: 'notes',
			key: 'id',
			column: 'note_id',
			inherit: ['workspace_id'],
		}, // composite FK to notes
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.write',
		},
		insert: ['body'],
		update: ['body'],
	},
	contact_messages: { scope: { inbox: 'contact', read: 'notes.admin' } }, // appended only by the form
	countries: {
		scope: { reference: 'read-only lookup data' },
		actions: { read: 'notes.read' },
	},
})
```

| Scope mode                      | Reachable through                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `{ dimension, key, in? }`       | a `Ref<dimension, action>` (that row) or a `Within<in.dimension, action>`                   |
| `{ child, column, inherit }`    | a `Ref` of the parent object; a composite foreign key keeps the child in the parent's scope |
| `{ inbox: form, read: action }` | append by the named form only; reads with `Within` of the read action                       |
| `{ reference: reason }`         | reads with any `Ref`/`Within` of its read action; never written by a handler                |

- **Locators are generated from the policy.** The core's `on: 'note'` resolves `note → workspace` with a query
  the framework generates from `scope.in`; there is no hand-written locator to "fix". The resulting `Ref` carries
  the whole chain (`note:n1`, `workspace:w1`), and every statement for that `Ref` includes every chain column in
  its predicate.
- **Every row carries its whole containment chain.** When `workspaces` lies in `organization`, `notes` carries
  `organization_id` as well as `workspace_id` (the same column name as in the table that owns the dimension), and
  children inherit every chain column of their parent. A composite foreign key with `ON UPDATE CASCADE` keeps the
  columns current when an ancestor moves, so a `Ref` minted before the move reaches nothing. `defineTables`
  refuses a table that lacks a chain column, and the layer refuses a `Ref` whose chain names a dimension the table
  carries no column for.
- **Membership needs no mode of its own.** IAM holds scoped grants (`editor @ workspace:w1`), so a
  `Within<'workspace', 'notes.read'>` contains exactly the workspaces where the caller holds the action.
- **A policy change is an access change.** A new table, a different scope mode or a changed action changes who can
  reach which rows. With platform enforcement, every such change waits for approval on a protected environment, so
  moving a table to `reference` to "fix an empty list" waits for a human.

## The store API

Handlers do not write SQL. They call store functions in `src/db/stores/`, built with `defineStore`:

```ts
export const notes = defineStore('notes', (t) => ({
	list: (within: Within<'workspace', 'notes.read'>, page: Page) =>
		t.select(
			within,
			(q) => q.columns(['id', 'title']).orderBy('id').limit(page.limit),
		),
	get: (note: Ref<'note', 'notes.read'>) => t.get(note),
	create: (workspace: Ref<'workspace', 'notes.write'>, values: NewNote) =>
		t.insert(workspace, values),
	update: (note: Ref<'note', 'notes.write'>, values: NoteEdit, expect: number) =>
		t.update(note, values, { expectVersion: expect }),
	remove: (note: Ref<'note', 'notes.delete'>) => t.remove(note),
}))
```

- **A `Ref` or `Within` is bound to the request or job run that obtained it** (tracked with
  `AsyncLocalStorage`). The layer refuses one whose request has ended and one from a different live request, so
  caching `ctx.within` or a `Ref` in a module-level map (a typical "performance" edit) fails instead of serving
  user A's scope to user B. Cache locator results, never capabilities.
- **Every operation checks the action at runtime.** `t.remove` requires a `Ref` whose action is the table's
  `delete` action. The types catch the honest mistake, but **not every widening**: TypeScript checks method
  parameters bivariantly, so assigning the table handle to a variable typed `{ remove(ref: Ref<string, string>) }`
  compiles without a cast and passes a read `Ref` to `remove` (shown by the spike). The runtime check is therefore
  required, and the checker refuses `Ref<string, …>` and `Within<string, …>` in application code.
- **Every entry point takes a `Ref` or a `Within`.** The table handle has no method that takes a bare id or no
  scope. The checker refuses an exported store function with a plain `string` id parameter. Child tables get their
  own entry point, `defineChildStore`, where one row is addressed by `(parentRef, childKey)` and a list by the parent
  `Ref` or by a `Within` of the parent's container.
- **The callback receives a frozen query description, not a Kysely builder.** Its methods are `columns`,
  `where` (this table's columns, an operator from a literal allowlist, plain values only), `whereAny` (one OR
  group), `contains` (a case-insensitive `ILIKE` with the user's `%`, `_` and `\` escaped), `orderBy`, `limit`, `offset`, and `join` to a
  declared child. There is no `selectFrom`, subquery, `union`, CTE, plugin, `execute` or `sql`; calling one is a
  type error and, with the types defeated, a `TypeError`. Identifiers must match `^[a-z_][a-z0-9_]*$`, and the
  callback must return the description it received.
- **Joins** are inner only, to declared children, with an `ON` generated from the composite foreign key; the
  child's read action must equal the capability's action; joined columns come back prefixed
  (`note_comments.body`).
- **The framework validates the final operation tree before compiling.** The layer wraps the description's
  `where` in a `ParensNode`, appends the scope predicate as the top-level AND conjunct, and walks the Kysely
  `OperationNode` tree against an allowlist: one table in `FROM`, no schema, qualified references only, `RawNode`
  only as an `asc`/`desc` order direction, operators and aggregate functions from string allowlists, inline values
  only for null and booleans, and each join's `ON` equal to the generated foreign-key predicate. This is the
  backstop for a builder that was bypassed. Without the parenthesis node, `where` with `true or 1=1` followed by
  the scope would compile to `true or 1=1 and scope` and match every row.
- **The guard depends on Kysely internals** (node factories marked `@internal`, compiler output of operator and
  function strings). Kysely is pinned, and the guard's attack tests run on every upgrade.
- **The process limit is concrete.** The spike's only two successful attacks patched globals in the same process:
  the Kysely compiler prototype after the guard ran, and `Set.prototype.has` (which disabled the allowlists). At
  boot the framework captures the built-ins it relies on and freezes the Kysely compiler prototypes before
  application modules load; the checker refuses assignments to prototypes.
- An empty `Within` returns `[]` without a query.
- `get`, `update` and `remove` on an object that no longer exists answer `NotFoundError` (404).
- **Column allowlists at runtime,** from a column list generated next to the types. Unknown keys in insert and
  update data are **refused**, not dropped, so the agent learns about them. `created_by` is a policy field stamped
  from the request's principal. The layer never selects `*`: it names the readable columns. A column may declare
  its own read action in `tables.ts` (`columns: { internal: { read: 'notes.admin' } }`); without one it falls back
  to the table's read action ([ADR-0050](../decisions/0050-approved-access.md)). Every read needs the table's read
  action, so in v1 a column with a different read action is written but never returned, filtered or sorted by.
- **Mutations answer an acknowledgement, not the row:** `insert` and `update` answer `{ id, version }` (`version`
  only for a versioned table), `move` also the new chain. A write action does not include the read action, so a
  handler that needs the row reads it with a read capability.
- **Optimistic concurrency** with `version`: zero changed rows → one follow-up read → 404 or 409. The update and
  its follow-up read, and a move with its children, run in one transaction.
- **The destination is checked against the database.** An insert into a container, a child insert and a move
  first select the destination row with the destination `Ref`'s whole chain, `FOR SHARE`, in the same
  transaction. A `Ref` minted before its object moved finds nothing (404), and nothing is inserted or moved.
- **`t.move(ref, toRef)`** takes one target container (`Ref<'workspace', insertAction>`) and requires the delete
  action at the source. It sets every chain column from the target's chain; children that copy them follow
  through `ON UPDATE CASCADE` on the composite foreign key.
- **Aggregates:** `t.aggregate(within, { groupBy, count, sum, min, max })`. `count` is typed `string`, because
  Postgres returns a bigint.

### No unscoped access in v1

There is no importable unscoped database, and v1 has no unscoped capability either: a raw handle in a job cannot
be fenced (a long statement commits after its lease expired), and routine reports would make granting it a
habit. Data repairs are an operator task outside the application: a reviewed SQL migration.

**Reports** use the scoped aggregate API instead of an escape hatch. The spike showed that the five most common
queries of a notes app fit (paginated list, search, count per workspace, comments of a note, latest N), and that
these do not: an aggregate over a join (notes with their comment counts), "notes without comments" (no LEFT JOIN
or `NOT EXISTS`), nested AND/OR groups, SQL functions (`lower`, `date_trunc`), full-text search and JSON columns.
Those are the first requests that will push against the builder; the next design step is to add the most common
of them as declared, scoped report kinds rather than to open raw access.

## Migrations

**Runner.** Reuse the [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md) runner in
`@fabrika/platform-node`, not Kysely's `Migrator`. Kysely's migrator stores no checksum, uses one fixed lock id
for every user, and throws `corrupted migrations` when the database is ahead of the code — exactly the state
after a rollback. The ADR-0017 runner tolerates that. For applications it needs:

- a ledger in the application's schema with a checksum column (the platform services' ledgers stay as they are);
- `SET lock_timeout` and `SET statement_timeout`, so a blocked `ALTER` fails the deploy instead of stalling the
  live old version;
- a lock key derived from `fabrika-db:<appId>`.

`CREATE INDEX CONCURRENTLY` cannot run inside the per-file transaction ADR-0017 requires; v1 does not support it.

**Identity.** Each application gets its own schema `app_<id>`, its own ledger
`app_<id>.fabrika_migrations (bundle, name, checksum, applied_at)` with bundle `app`, and its own lock key
([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md) states the derivations and the timeouts).
`fabrika db migrate` reads `FABRIKA_APP_ID` and `FABRIKA_APP_DATABASE_URL`. The
schema separates names, not access: in a cheap namespace every application uses the same credential.

**Who runs them.** The application container, before the new version serves: `fabrika db migrate` in
`run.initCommands`. In part A the template's `zerops.yaml` carries the command and the checker verifies it; with
platform enforcement the provider generates it. Control cannot run them: a namespace is its own Zerops project,
and projects share no private network.

**File names** are `YYYYMMDDHHMMSS_slug.sql`, so parallel agent worktrees do not collide. `fabrika db new <slug>`
writes one; because an agent authoring over MCP has no local CLI, the checker refuses any other name.

**Expand only.** The previous release keeps serving while a migration runs, and a rollback starts old code on
the new schema. A drop, rename or type change ships in a later release than the one that stopped using it.

**Destructive-change protection,** in the checker:

1. [`squawk`](https://squawkhq.com/docs/rules) with `ban-drop-column`, `ban-drop-table`, `renaming-column`,
   `renaming-table`, `changing-column-type`, `adding-required-field`, `require-lock-timeout` and
   `require-statement-timeout`.
2. A destructive statement requires `-- fabrika:contract` naming the earlier release that stopped using the
   object.
3. A merged migration that changed or was deleted is refused.
4. Views, triggers, functions, `GRANT`, `SECURITY DEFINER` and policy statements are refused; they are not
   application DDL.

**Migrations are access changes.** A backfill can move rows between scopes without any policy change
(`UPDATE notes SET workspace_id = …`). With platform enforcement, every new or changed migration file is a change
that waits for approval on a protected environment, with the file shown in the prompt. Moving an object between
scopes has a supported operation instead (`t.move(ref, toRef)`).

## Drift checks

| When         | Check                                                      | Catches                         |
| ------------ | ---------------------------------------------------------- | ------------------------------- |
| Compile time | `tables.ts` covers every application table                 | a table without a policy        |
| Build        | migrate into a throwaway Postgres, then `codegen --verify` | stale types                     |
| Startup      | `assertMigrated()` before serving                          | a missing or changed migration  |
| Operator     | `fabrika db verify --url …`                                | manual drift in a live database |

## Testing

- `@fabrika/db/testing` creates a random schema, applies migrations through the real runner, and skips with the
  standard message when `FABRIKA_TEST_POSTGRES_URL` is unset (`FABRIKA_TEST_POSTGRES_REQUIRED=1` turns the skip
  into a failure; the build sets it). It refuses to load when `FABRIKA_RELEASE` is set, so test helpers cannot ship.
- `testCaller(grants)` builds a caller with `@fabrika/auth-core`'s `permits`, so test semantics equal production.
- **Generated isolation tests:** for every scoped table, `fabrika db test-scaffold` writes tests in which a caller
  of workspace `w1` gets 404 on get, update and delete of a `w2` row, an empty list, and 403 on create in `w2`; and
  in which a `Ref` for the read action is refused by update and delete. The checker verifies their content hash, so
  they can be neither deleted nor weakened.

## Framework (part A)

What the framework gives on today's platform:

- action-bound, request-bound `Ref`/`Within`; generated locators; the allowlisted, non-executable query
  description with a runtime operation-tree check; runtime column allowlists; refusal of unknown keys;
- the migration runner with checksums and timeouts, run by `fabrika db migrate` from the template's
  `initCommands`;
- the checker: no database driver or `Bun.sql` in application code, no `sql` anywhere, store functions take no
  bare ids, `tables.ts` is a literal, migration file names, squawk rules, isolation-test hashes;
- the agent skill: `fabrika db new` for schema changes (or the file-name rule over MCP); every table gets a
  policy; children carry the parent's scope column and a composite foreign key; expand, switch, contract; never
  change a table's scope mode without asking the human.

## Platform enforcement (part B)

What [platform enforcement](platform-enforcement.md) adds:

- Control reads `tables.ts` and the migration list from the commit; a changed policy or a new or changed
  migration waits for approval on a protected environment;
- the generated run section owns `fabrika db migrate`; the platform-owned build runs the checker, `tsc`, codegen
  verification and the isolation tests, so the agent cannot drop them;
- credential custody: the database credential arrives under a framework-only name.

Later hardening, not in v1: a Postgres role per application with a separate owner role, then row-level security
compiled from `tables.ts` (`FORCE ROW LEVEL SECURITY`, scope values set per transaction with
`set_config(…, true)`). RLS is meaningful only when the owner credential never enters the application container,
which needs those roles first.

## Risks

- **Kysely types over a generic table parameter** were the expected blocker. The spike solved it without casts:
  internally the layer uses a string-keyed Kysely instance and the public types come from its own mapped types
  over `DB` and the policy. The cost is two store entry points and one place where row types are trusted
  (`CompiledQuery<O>`), as Kysely itself does.
- **Expressiveness.** Reports are the first place an agent will want more than the builder allows; if the gap is
  too wide, agents will ask for raw access.
- **Shared credential in a cheap namespace.** A copied migration or a hand-written query can touch another
  application's schema. The namespace choice must say so.
- **Cloudflare applications get no recommended path** in v1.

## Open questions

- Soft delete (`deleted_at` with partial unique indexes) as a policy field, or left to the application?
