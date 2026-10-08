# Scoped database access

A proposal for one recommended way for Fabrika applications to talk to their database: a
`@fabrika/db` package over [Kysely](https://kysely.dev). It shares the goal and threat model of
[secure-by-default application runtime](secure-by-default-app-runtime.md): an agent steered by an
inexperienced person must not be able to read or change rows the caller is not allowed to touch.

The endpoint declaration says **who** may call and **which actions** the endpoint exercises. This
layer says **which rows** those actions reach. Neither repeats the other.

## Scope of v1

- **Postgres only** (Bun + Postgres on Zerops). The builder already targets Zerops only
  (`packages/builder/CLAUDE.md`).
- Cloudflare / D1 applications keep raw D1 for now. Reasons:
  - The community D1 dialect throws `Transactions are not supported yet` from `beginTransaction()`;
    D1 itself offers only an atomic `batch()`
    ([D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
  - No `uuid`, `timestamptz`, `jsonb`, native boolean or `SKIP LOCKED`; two DDL sets; two verifiers;
    two test backends.
  - [ADR-0015](../decisions/0015-repository-operations-are-the-sql-portability-seam.md) already found
    that the SQLite/Postgres differences are not only textual.
- The rejection of Kysely in [`portability-surface.md`](../reference/portability-surface.md) concerns
  the platform's own services, which share SQL between D1 and Postgres. It does not carry over to
  applications; that document should say so.

## Schema source of truth

**SQL migration files are the only DDL. Types are generated from a migrated database. One small
hand-written file declares what the database cannot know: the access policy of each table.**

```
db/migrations/20261008120000_init.sql            # frozen once merged; plain SQL
db/migrations/20261020093000_note_idx.notx.sql   # runs outside a transaction (CREATE INDEX CONCURRENTLY)
db/seeds/example.sql                             # local and test only; never applied by a deploy
src/db/schema.generated.ts                       # kysely-codegen output; committed; never hand-edited
src/db/tables.ts                                 # the access policy of every table
src/migrate.ts                                   # three lines, run by run.initCommands
```

- Types come from [`kysely-codegen`](https://github.com/RobinBlomberg/kysely-codegen), whose `--verify`
  flag fails when the committed types are stale. By default it types `int8` as a string, which matches
  what `Bun.SQL` returns.
- The driver is [`kysely-postgres-js`](https://github.com/kysely-org/kysely-postgres-js) over `Bun.SQL`,
  maintained by the Kysely organization. It reserves one backend connection per Kysely connection, so a
  transaction stays on one backend.
- No `CamelCasePlugin`. Row shapes stay snake_case and mirror the migration files, as in the rest of the
  repository; one name everywhere is easier for an agent to grep.

Rejected:

- **A schema declared in TypeScript plus a verifier against the live catalog.** It works — an earlier
  in-house framework we studied does it — but it is a second schema language, several thousand lines of
  DSL and verifier, and two places an agent must edit for one change.
- **Diff-generated migrations (`drizzle-kit generate`).** It asks interactively about renames, which an
  agent cannot answer, and diff-generated DDL knows nothing about expand/contract.

## Every table declares its access policy

`tables.ts` is a mapped type over `keyof DB`. A table without a policy, or a policy that names a column
the table does not have, does not compile. A new migration that adds a table therefore breaks the build
until the table has a policy.

```ts
import { defineTables } from '@fabrika/db'
import type { DB } from './schema.generated'

export const tables = defineTables<DB>()({
	notes: {
		scope: { dimension: 'workspace', column: 'workspace_id' },
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.delete',
		},
		insert: ['title', 'body'], // id, the scope column and created_by are stamped by the layer
		update: ['title', 'body'], // the scope column can never appear here
		version: 'version',
	},
	note_comments: {
		scope: { dimension: 'workspace', column: 'workspace_id' }, // plus a composite FK to notes
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.write',
		},
		insert: ['note_id', 'body'],
		update: ['body'],
	},
	bookmarks: {
		scope: { owner: 'created_by', bypass: 'bookmarks.admin' }, // "my rows"; bypass sees everyone's
		actions: {
			read: 'bookmarks.use',
			insert: 'bookmarks.use',
			update: 'bookmarks.use',
			delete: 'bookmarks.use',
		},
		insert: ['url', 'title'],
		update: ['title'],
	},
	countries: {
		scope: { none: 'public reference data' },
		actions: { read: 'catalog.read' },
		insert: [],
		update: [],
	},
})
```

Scope modes:

| Mode                    | Rows reachable                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| `{ dimension, column }` | rows whose `column` is in `auth.scopedTo(action, dimension)`                      |
| `{ owner: column }`     | rows whose `column` equals `auth.principal.id`; optional `bypass` action sees all |
| `{ global: true }`      | all rows, when the caller holds `action` with no scope                            |
| `{ none: 'reason' }`    | all rows, for any caller allowed to run the endpoint                              |

- **The action is fixed per operation in the table policy**, not passed per call. A design that lets the
  call site name the action lets an agent update a row with `notes.read`.
- `{ owner }` covers the most common pattern in a small application ("my bookmarks"), which IAM scope
  dimensions do not express.
- The table policies are static data, so `fabrika app access` copies them into
  `fabrika.access.json`. A table that moves to a looser mode (for example `dimension` → `none`) is a
  **widening** and needs approval like a looser endpoint.

## The handle a handler gets

The framework builds `ctx.db` from the verified `AuthContext` and from the **actions the endpoint
declared**. A handler never sees an unscoped Kysely instance.

```ts
const notes = ctx.db.table('notes')

await notes.list(
	{ after: input.after, limit: 50 },
	(q) => q.select(['id', 'title']),
)
// scopedTo('notes.read', 'workspace'): null → no filter · [] → [] without a query · values → workspace_id = ANY($1)
// always: ORDER BY id (UUIDv7 keyset), limit capped at 200

await notes.getOrThrow(input.id)
// NotFoundError when the row is missing OR out of scope — never 403, so ids cannot be probed

await notes.insert({
	workspace_id: input.workspace,
	title: input.title,
	body: input.body,
})
// can('notes.write', { type: 'workspace', value }) or ForbiddenError
// copies ONLY the declared insert columns at runtime; id = uuidv7(); created_by = auth.principal.id

await notes.update(input.id, { title: input.title }, {
	expectVersion: input.version,
})
// UPDATE … SET title, version = version + 1 WHERE id AND scope AND version
// 0 rows → one follow-up read → NotFoundError (404) or ConflictError (409)

await notes.remove(input.id)

await ctx.db.query(
	'notes',
	(q) =>
		q.innerJoin('note_comments', 'note_comments.note_id', 'notes.id').select([
			'notes.id',
			'note_comments.body',
		]),
)
// read-only; the scope applies to the base table; the composite FK keeps children in the same scope

await ctx.db.transaction(async (tx) => {/* tx is the same scoped handle */})
```

Rules the layer enforces:

- **Declared actions only.** An operation whose table action is not among the endpoint's declared
  actions throws a configuration error (and is a type error where the types can carry it). The access
  manifest is therefore complete: no handler exercises an action the manifest does not show.
- **Column allowlists at runtime.** TypeScript's excess-property check applies only to object literals,
  so spreading `parsed.data` would pass extra keys silently. The layer copies only the declared columns.
- **The scope column comes from the request only on insert,** and only after `can()` on its value. It is
  never updatable.
- **Children share the parent's scope** through a composite foreign key
  `(workspace_id, note_id) REFERENCES notes (workspace_id, id)`. The database, not the code, then
  guarantees that a comment and its note are in the same workspace.

### The escape hatch

```ts
database.unscoped('nightly purge of soft-deleted rows') // raw Kysely<DB>
```

- Allowed by lint only in `src/db/**` and `src/jobs/**`, never in a handler.
- Every call site carries a reason and is counted; a ratchet keeps the count from growing without a
  visible change.
- `sql.raw(` is refused outside the same paths.

Bulk writes, upserts and reports go through this hatch with an explicit `can()` check. That is a reviewed
exception, not a guarantee.

### Row-level security

Not in v1. Postgres RLS with `set_config(…, true)` per transaction would be a backstop for joins and for
the escape hatch, but every request becomes a transaction, a separate migrator role is needed, and in a
cheap namespace all applications share one Postgres credential, so RLS cannot separate them. A possible
phase 2 generates policies from `tables.ts`.

## Migrations

**Runner.** Reuse the [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md) runner in
`@fabrika/platform-node`, not Kysely's `Migrator`. Kysely's migrator records names without checksums,
uses one fixed advisory-lock id for every user, and throws `corrupted migrations` when the database is
ahead of the code — which is exactly the state after a rollback on Zerops, where `run.initCommands`
re-runs the old release's migrate step. The ADR-0017 runner already tolerates a database ahead of the
code. It needs:

- a `checksum` column; a changed applied file refuses to start;
- `*.notx.sql`: one idempotent statement outside a transaction, the ledger row written after it;
- `SET lock_timeout` and `statement_timeout`, so a blocked `ALTER` fails the deploy instead of stalling
  the live old version.

**Identity.** Each application gets its own Postgres schema `app_<id>`, its own ledger
`app_<id>.fabrika_migrations (bundle, filename, checksum, applied_at)` with bundle `app`, and an advisory
lock key derived from `fabrika-db:<appId>`. Cheap namespaces share one Postgres credential across
applications (`deployment-namespaces.md`), so without a schema per application two applications that
both create `notes` collide — the failure ADR-0017 fixed between IAM and Control.

**File names** are `YYYYMMDDHHMMSS_slug.sql`, written by `fabrika db new <slug>`. Timestamps avoid
collisions between parallel agent worktrees.

**Zerops wiring.**

```ts
// src/migrate.ts, run by run.initCommands; db/ is in deployFiles
import { migrate } from '@fabrika/db/migrate'
await migrate({
	url: readDatabaseUrl(),
	appId: 'notes',
	directory: 'db/migrations',
})
```

The URL must use the session-preserving port, not the transaction pooler, because the advisory lock is
session-level.

**Expand only.** On both providers the previous release keeps serving while the migration runs, and a
rollback starts old code on the new schema. Every migration must therefore work with the previous
release's code. A drop, rename or type change ships in a later release than the one that stopped using
the column.

**Destructive-change protection,** run by `fabrika app build` (so it also runs without CI):

1. [`squawk`](https://squawkhq.com/docs/rules) with a Fabrika configuration (`ban-drop-column`,
   `renaming-column`, `changing-column-type`, `adding-required-field`,
   `require-concurrent-index-creation`, `require-timeout-settings`).
2. A `squawk-ignore` must sit next to `-- fabrika:contract <which release stopped using it>`.
3. A merged migration that changed or was deleted is refused.
4. Optionally, contract migrations are listed in the static manifest and Control requires an approval
   for a run that applies one, alongside the access-widening approval.

## Drift checks

| When         | Check                                                                           | Catches                                                                    |
| ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Compile time | `tables.ts` is a mapped type over `keyof DB`                                    | a table without a policy                                                   |
| Build        | `fabrika db migrate --fresh` into a throwaway Postgres, then `codegen --verify` | types that were not regenerated                                            |
| Startup      | `database.assertMigrated()` before `Bun.serve`                                  | a missing or changed migration; extra ledger rows (a rollback) are allowed |
| Operator     | `fabrika db verify --url …`                                                     | manual hotfix drift in a live database                                     |

## Testing

- `@fabrika/db/testing`:
  - `testDatabase({ appId, tables, directory })` creates a random schema and applies the application's
    migrations through the real runner. It skips with the standard message when
    `FABRIKA_TEST_POSTGRES_URL` is unset. `FABRIKA_TEST_POSTGRES_REQUIRED=1` turns the skip into a
    failure, because a green run with skips proves nothing.
  - `db.rollback(fn)` runs a test inside a transaction and rolls it back.
  - `testAuth(entries)` builds an `AuthContext` with `@fabrika/auth-core`'s `permits` and
    `scopedValues`, so test semantics equal production.
- **A generated isolation test per table.** For every scoped table, `fabrika db test-scaffold` writes a
  test: a caller scoped to `w1` gets 404 on get, update and delete of a `w2` row, an empty list, and 403
  on insert into `w2`. For an `owner` table, the same with two principals.

## What the agent is told

The builder catalog gets a `technologies/fabrika-db.md` entry (slot `db-access`, requires `postgres`,
added to the `zerops-app` stack):

1. Schema change: `fabrika db new <slug>`. Never edit a merged migration.
2. Migrate locally, then `fabrika db codegen`; commit `schema.generated.ts`; never hand-edit it.
3. Every new table goes into `tables.ts` with a scope, actions and column allowlists. Child tables carry
   the scope column and a composite foreign key.
4. Handlers use only `ctx.db.table()` and `ctx.db.query()`. Never `unscoped()` in a handler. Never
   `scope: { none }` without asking the human.
5. Expand, switch, then contract in a later release.
6. Keep the generated isolation tests green; never delete one.

`technologies/postgres.md` points to `@fabrika/db` and forbids raw `Bun.SQL` in handlers.
`examples/zerops-app` moves to the new package, so agents copy the right pattern.

## Risks

- **Kysely typing over a generic table parameter is known to be weak.** `ctx.db.table(name)` must be
  spiked without casts before the API is committed. Inside the layer, predicates are built with
  `sql.ref()`.
- **Carrying the endpoint's declared actions into the type of `ctx.db`** may be too expensive for the
  type checker. The runtime check is the floor; the type check is a bonus.
- **The scoped `query()` protects only the base table.** Joins are safe only where composite foreign keys
  exist. RLS would be the backstop.
- **Cloudflare applications get no recommended path** in v1. Revisit when a production Cloudflare
  application needs one; Drizzle's first-class D1 support then becomes a serious option.
- **Codegen needs a running Postgres** at build time — the same dependency the tests already have.

## Open questions

- Is `{ global: true }` checked with `can(action)` and no scope, and does that mean "holds the action
  globally" in `@fabrika/auth-core`'s semantics? Verify before relying on it.
- Should `{ none }` tables be read-only by construction (no insert/update/delete actions allowed)?
- Soft delete (`deleted_at` with partial unique indexes) as an opt-in policy field, or left to the
  application?
- Should contract migrations require Control approval in v1, or only lint?
