# Application architecture

Where the code of a Fabrika application goes, and what each part may import and call. Every application, the
examples and the template follow this layout. `fabrika-check` reads it: a break of platform integrity is a
**refusal**, which fails the check; a step out of the structure is a **hint**, which it prints and does not fail on.
The serving API itself (`ctx`, access forms, the generated tests) is in
[`application-runtime.md`](application-runtime.md).

## The layers

An application is six layers in a fixed order. Each layer imports only the layers before it:

1. **Vocabulary** (`src/vocabulary.ts`): the authorization vocabulary — app, dimensions, actions, roles. It imports
   nothing of the application.
2. **Tables** (`src/db/tables.ts`): the table scopes, typed by the vocabulary and the generated columns.
3. **Kit** (`src/app-kit.ts`): `defineApp(vocabulary, tables)`, typed by the vocabulary, the database and the
   policies. Every group is built with it.
4. **Groups** (`src/<slice>/endpoints.ts`): `app.group(…)` with a `.handle(…)` body beside each procedure.
5. **Contract** (`fabrika.contract.ts`): `app.contract((c) => …)`, the mounts and sections that compose the groups.
6. **Composition entry** (`src/app.ts`): `serve(contract, { database, deps })`. The generated entrypoint and
   `fabrika job run` load it.

Nothing imports `typeof contract` to type a table or a group. The order is what keeps the types acyclic.

## The directory tree

A CRM with two slices, `companies` and `deals`:

```text
crm/
  package.json
  tsconfig.json
  bun.lock
  zerops.yaml                                   the build base and the SPA build commands (Zerops); the platform writes the rest
  build-web.ts                                  the SPA build: web/index.html through @fabrika/check/bun-plugin
  fabrika.config.ts                             the provider config: services, the proxy table, the IAM schema
  fabrika.contract.ts                           app.contract((c) => …): composes the slices' groups
  AGENTS.md                                     the rendered agent skill
  db/
    migrations/
      20261011120000_crm.sql                    plain SQL; declared database code is a deviation
  fabrika/
    entry.generated.ts                          written by the build; not committed
  src/
    vocabulary.ts                               defineVocabulary({ app, dimensions, actions, roles })
    app-kit.ts                                  defineApp(vocabulary, tables): the kit
    schemas.ts                                  shared zod schemas (literal): the shell and the SPA import them
    shared/
      greeting.ts                               pure functions the SPA and the slices both run: zod/v4 only
    app.ts                                      serve(contract, { database, deps })
    db/
      tables.ts                                 defineTables(vocabulary, columns)({ … })
      schema.generated.ts                       fabrika db codegen
      __tests__/
        companies.policy-isolation.test.ts      generated; committed, never edited
        deals.policy-isolation.test.ts          generated
    companies/
      endpoints.ts                              app.group(…) with .handle(…) bodies
      queries.ts                                reusable data access over the handle a handler passes in
    deals/
      endpoints.ts
      logic.ts                                  business rules: plain TypeScript
      queries.ts
      __tests__/
        logic.test.ts                           authored: the rules, without a database
        reopen.test.ts                          authored: a handler, on a test database
    __tests__/
      endpoint-access.test.ts                   generated
      endpoint-access.fixtures.ts               authored: inputs the scaffold cannot sample, seeds for preconditions
  web/
    index.html
    main.ts                                     the SPA: createClient(contract, 'api')
    view.ts
```

## A slice

A **slice** is a directory `src/<slice>/` that owns one part of the domain. Every directory under `src/` is a slice
except `src/db/`, `src/schemas/`, `src/shared/` and `src/__tests__/`. A slice has up to three modules, each optional:

| Module                     | Holds                                                                                                     | Reaches data               |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/<slice>/endpoints.ts` | the slice's group: procedures, each with its `.handle(…)`; its jobs, webhooks, link and export procedures | through `ctx`              |
| `src/<slice>/logic.ts`     | business rules: pure functions over plain values; no `ctx`, no data, no I/O                               | no                         |
| `src/<slice>/queries.ts`   | reusable data access: functions over the handle a handler passes in                                       | only through its parameter |

Another module in a slice (`src/deals/format.ts`) is plain code of that slice. It does not reach data and holds no
handler. A slice that outgrows one `endpoints.ts` becomes two slices.

## What each file holds

| File                         | Holds                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`          | `export const vocabulary = defineVocabulary({ app, dimensions, actions, roles })`. A literal.                                                                                          |
| `src/db/tables.ts`           | `export const tables = defineTables(vocabulary, columns)({ <table>: { scope, actions, insert, update } })`. A literal.                                                                 |
| `src/db/schema.generated.ts` | the `DB` interfaces and `columns`, written by `fabrika db codegen`. Never edited.                                                                                                      |
| `src/app-kit.ts`             | `export const app = defineApp(vocabulary, tables)`.                                                                                                                                    |
| `src/schemas.ts`             | the zod schemas several slices, or a slice and the SPA, share, in the checker's literal subset; a slice keeps its own in its `endpoints.ts`. `src/schemas/<name>.ts` once it grows.    |
| `src/shared/*.ts`            | pure code the SPA and the slices both run (a template fill, a label): functions over plain values, which load only `zod/v4` and other modules of `src/shared/`. Not read as a literal. |
| `src/<slice>/endpoints.ts`   | `export const <slice> = app.group({ callers }, (r) => ({ … }))`, each procedure followed by `.handle(…)`.                                                                              |
| `src/<slice>/logic.ts`       | `export const canReopen = (stage: string): boolean => …`                                                                                                                               |
| `src/<slice>/queries.ts`     | `export const lockedStage = async (deal: DbHandle<typeof app, 'on', 'deal', 'deals.write', 'mutation'>) => …`                                                                          |
| `fabrika.contract.ts`        | `export const contract = app.contract((c) => ({ api: c.rpc('/api', { companies, deals }), … }))`: mounts, `jobs`, `files`, `imports`, `csp`.                                           |
| `src/app.ts`                 | `export default serve(contract, { database: scoped(tables), deps })`. Nothing else.                                                                                                    |
| `fabrika.config.ts`          | the provider's `defineApp(…)`: services, `compileContract(contract, tables)`, the proxy table, the schema.                                                                             |
| `db/migrations/*.sql`        | `YYYYMMDDHHMMSS_slug.sql`, plain SQL, applied in file order.                                                                                                                           |
| `web/**`                     | the SPA.                                                                                                                                                                               |

A slice in code:

```ts
// src/deals/logic.ts
export const canReopen = (stage: string): boolean =>
	stage === 'won' || stage === 'lost'
```

A query function types its handle parameter with the kit's `DbHandle` (`@fabrika/app/contract`): the same handle
the handler's `ctx.db` holds for that access form, dimension, action and kind. `DbHandle<typeof app, 'over', D, A>`
is `ctx.db.within`, `ReferenceHandle<typeof app>` is `ctx.db.reference`, and `SqlHandle<typeof app, 'read' | 'write'>` is
`ctx.sql`, whose `scope(capability, table)` checks the table against the app's own tables:

```ts
// src/deals/queries.ts
import type { DbHandle } from '@fabrika/app/contract'
import type { app } from '../app-kit'

export const lockedStage = async (
	deal: DbHandle<typeof app, 'on', 'deal', 'deals.write', 'mutation'>,
): Promise<string> => (await deal.getForUpdate()).stage
```

```ts
// src/deals/endpoints.ts
import { ConflictError } from '@fabrika/app'
import { app } from '../app-kit'
import { OrgInput, Pipeline, PipelineRow, ReopenDeal, Saved } from '../schemas'
import { canReopen } from './logic'
import { lockedStage } from './queries'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	reopen: r.mutation({
		input: ReopenDeal,
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			if (!canReopen(await lockedStage(ctx.db.target))) {
				throw new ConflictError('only a won or lost deal reopens')
			}
			return ctx.db.target.update({ stage: 'proposal' }, {
				expectVersion: input.expectVersion,
			})
		}),
	pipeline: r.query({
		input: OrgInput,
		output: Pipeline,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			rows: await ctx.sql(PipelineRow)`
				select d.stage, count(*)::int as deals
				from deals d
				where ${ctx.sql.scope(ctx.target, 'deals', 'd')}
				group by d.stage`,
		})),
}))
```

```ts
// fabrika.contract.ts
import { app } from './src/app-kit'
import { companies } from './src/companies/endpoints'
import { deals } from './src/deals/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { companies, deals }),
	site: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
}))
```

## Imports

Rows are the importing module. "Checker" names what `fabrika-check` reports for a forbidden import. A type-only
import (`import type`) is erased and is free everywhere, except of a generated test.

| Module                             | May import                                                                                                                      | Must not import                                                                            | Checker                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `src/vocabulary.ts`                | `@fabrika/app/contract`                                                                                                         | any module of the application                                                              | `literal` (refusal): the contract graph is a literal |
| `src/db/tables.ts`                 | `@fabrika/db/tables`, `src/vocabulary.ts`, `src/db/schema.generated.ts`                                                         | the kit, a slice, the contract                                                             | `literal` (refusal)                                  |
| `src/app-kit.ts`                   | `@fabrika/app/contract`, `src/vocabulary.ts`, `src/db/tables.ts`                                                                | a slice, the contract                                                                      | —                                                    |
| `src/schemas.ts`                   | `zod/v4`, another schemas module                                                                                                | anything else                                                                              | `literal` (refusal)                                  |
| `src/shared/**`                    | `zod/v4`, other modules under `src/shared/`                                                                                     | anything else, at runtime                                                                  | `shared-import` (refusal)                            |
| `src/<slice>/endpoints.ts`         | the kit, the schemas, `src/shared/`, its own `logic.ts` and `queries.ts`, any slice's `logic.ts`, `@fabrika/app`                | another slice's `queries.ts`                                                               | `cross-slice-queries` (hint)                         |
| `src/<slice>/logic.ts`             | the schemas, `src/shared/`, any slice's `logic.ts`, plain libraries, `@fabrika/app` (its errors)                                | `@fabrika/db`, a `queries.ts`, `src/db/`                                                   | `logic-data-access` (hint)                           |
|                                    |                                                                                                                                 | any other `@fabrika/*` module                                                              | `layer-import` (refusal)                             |
| `src/<slice>/queries.ts`           | the generated row types, the kit's type (`import type { app }`), the schemas, its own `logic.ts`, `@fabrika/app`, `@fabrika/db` | another slice's `queries.ts`                                                               | `cross-slice-queries` (hint)                         |
|                                    |                                                                                                                                 | any other `@fabrika/*` module                                                              | `layer-import` (refusal)                             |
| `fabrika.contract.ts`              | the kit, the slices' `endpoints.ts`, the schemas                                                                                | —                                                                                          | —                                                    |
| `src/app.ts`                       | `@fabrika/app/implement` (`serve`), `@fabrika/db` (`scoped`), the contract, `src/db/tables.ts`                                  | —                                                                                          | —                                                    |
| `web/**`                           | `@fabrika/app/client`, `fabrika.contract.ts`, the schemas, `src/shared/`, other `web/` modules, browser packages                | any other application module, any other `@fabrika/*` module, Bun and Node builtins         | `spa-server-import` (refusal)                        |
| a test (`*.test.ts`, `__tests__/`) | anything, the test kits included                                                                                                | a generated test                                                                           | `generated-test-import` (refusal)                    |
| any module but a test              | —                                                                                                                               | `@fabrika/app/testing`, `@fabrika/app/react/testing`, `@fabrika/db/testing`, a test module | `test-only-import` (refusal)                         |
| any module                         | —                                                                                                                               | a generated test                                                                           | `generated-test-import` (refusal)                    |

An import is judged by the file or package Bun loads for it:

- A Bun or Node builtin (`fs`, `node:http`) is the builtin, whatever a mapping says.
- Otherwise a mapped specifier resolves through `compilerOptions.paths` of the importing module's nearest
  `tsconfig.json` (or `jsconfig.json`), with its local `extends`: the first target that exists. When none exists,
  `imports` of its nearest `package.json` applies, and then the package itself. Targets are relative to the file that
  declares them (`baseUrl` when set). The exact key wins over a pattern; of two patterns, the longer prefix before
  `*`, then the longer key (`#x/*.ts` before `#x/*`).
- `layer-import` follows the local modules that `logic.ts` and `queries.ts` load at runtime (imports, re-exports,
  `export *`, a literal `import()`), so a helper module or a barrel carries their restriction.
- `spa-server-import` follows the schema modules the SPA loads, since nothing else checks their imports; a module
  under `src/shared/` is checked on its own (`shared-import`).
  `fabrika.contract.ts` is not followed: the SPA bundle loads it without its handlers.

## What each part may call

- **A handler** (`.handle(…)` in `src/<slice>/endpoints.ts`) is the only code with `ctx`. It reaches data through
  `ctx.db` (the paved road, bound to the capability its access form minted: `ctx.db.target`, `ctx.db.within`,
  `ctx.db.reference`), calls the slice's logic with plain values, and passes `ctx.db.*` or `ctx.sql` to a function of
  `queries.ts`. It throws `ConflictError`, `NotFoundError` and `BadRequestError` from `@fabrika/app`. Data work comes
  first, external calls after: IAM, object storage and connector effects do not roll back with the invocation.
- **Off-road reach is declared on the procedure** in the shell, and the runtime builds the handle only there:

  | Declaration                                | Gives the handler                                   |
  | ------------------------------------------ | --------------------------------------------------- |
  | `sql: 'read' \| 'write'`                   | `ctx.sql`; a query or export takes only `'read'`    |
  | `unscoped: { <table>: 'read' \| 'write' }` | `ctx.db.unscoped.<table>`, in that mode             |
  | `connect: ['<connector>']`                 | `ctx.connect.<connector>`                           |
  | `issues: '<mount>'`                        | `ctx.links.issue` and `revoke`; also on a job       |
  | `binds: '<webhook>'`                       | `ctx.webhooks('<webhook>').bind` and `unbind`       |
  | `signs: ['<purpose>']`                     | `ctx.tokens.sign`; also on a job and a webhook      |
  | `kicks: ['<job>']`                         | `ctx.kick`; also on a webhook and a job             |
  | `egress: ['https://<host>']`               | `fetch` to those origins; also on a job, webhook    |
  | `egress: 'public'`                         | `fetch` to public hosts; a cron job only (ADR-0070) |

- **Logic** (`logic.ts`) is pure: values in, values out. It does not see `ctx`, a handle or a row it did not get as an
  argument. Its tests need no database.
- **A query function** (`queries.ts`) takes the handle as a parameter (`ctx.db.target`, `ctx.db.within.<table>`,
  `ctx.sql`), typed by `DbHandle`, `SqlHandle` or by the methods it calls, and returns plain values. It decides no authorization: the capability
  already bounds the handle. It is called from its own slice's handlers.
- **A job** is an `app.cron` declaration with its `.handle(…)` in the `endpoints.ts` of the slice whose data it works
  on; the contract's `jobs` section names it. An attempt retries, so its writes are idempotent. A queue table's rows
  are claimed by a job (`claim`).
- **A webhook** is declared and handled the same way; it keys idempotency on `ctx.delivery.key` or writes with
  `insert(…, { onConflict })`.
- **A public procedure** is a procedure of a group like any other, with `access: { public: true }` and its `actions`;
  a group of public procedures only is `app.group({}, …)`. Its slice holds its handler and the table it inserts into.
- **A link mount's procedures** and **an export's procedures** (the owner's side of a connector) carry their
  `.handle(…)` in the owning slice's `endpoints.ts`; the contract mounts them with `c.link` and `c.export`.
- **A connector import** is declared in the contract's `imports`; a procedure that calls it declares `connect`, and
  its handler calls `ctx.connect.<connector>`.
- **A file kind** is `c.files` in the contract's `files` section; it has no endpoint and no handler. A file lives in a
  table's file column (`files: { <column>: '<kind>' }` in `src/db/tables.ts`), and its upload, list and download are
  procedures of the slice that owns that table.
- **`src/app.ts`** composes and does nothing else: no route, no middleware, no handler.
- **The SPA** builds its client with `createClient(contract, 'api')` from `@fabrika/app/client`. Its bundle is built
  through `@fabrika/check/bun-plugin`, which loads `fabrika.contract.ts` without its handlers. It imports
  `src/schemas.ts` for shared constants and schemas, `src/shared/` for shared functions, and never a slice.
- **Shared code** (`src/shared/`) is what the SPA and the server must compute alike: one function, not two copies
  that drift. It loads `zod/v4` and other shared modules only, so it holds no data access, no framework call and no
  slice. It runs under the server-module rules (no global object, no environment read), so it is pure in both places.

## Tests and fixtures

- **Generated tests** — `src/db/__tests__/<table>.policy-isolation.test.ts` and
  `src/__tests__/endpoint-access.test.ts` — are what `fabrika db test-scaffold` writes. They are committed and never
  edited (`generated-test-hash`), and no module imports one (`generated-test-import`).
- **Authored inputs and seeds** for the endpoint access tests are `src/__tests__/endpoint-access.fixtures.ts`, read
  statically: `fixtures` for an input the scaffold cannot sample, `seeds` for the row state a precondition needs
  (`export const seeds = { 'api.deals.reopen': { stage: 'won' } }`). A generated test is never edited to pass.
- **Authored tests** live beside what they test: `src/<slice>/__tests__/*.test.ts` or `src/<slice>/*.test.ts`. A
  logic test calls the functions. A handler test boots the application through `testKit` from
  `@fabrika/app/testing` and calls it through the typed client; `kit.runJob(name)` runs a cron job.
- **The test kits** (`@fabrika/app/testing`, `@fabrika/db/testing`) and helper modules under `__tests__/` are imported
  only by test files.

## What the checker reports

| Rule                    | Severity | Reports                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spa-server-import`     | refusal  | a module under `web/` (not a test) that loads, also through a schema module, an application module other than `fabrika.contract.ts`, `src/schemas.ts`, `src/schemas/**`, `src/shared/**` and `web/**`, a `@fabrika/*` module other than `@fabrika/app/client`, or a Bun or Node builtin (`fs`, `fs/promises`, `node:path`, `bun:sqlite`) |
| `layer-import`          | refusal  | `src/<slice>/logic.ts` or `queries.ts` that loads, also through a local module, a `@fabrika/*` module other than `@fabrika/app` and `@fabrika/db` (the test kits are `test-only-import`'s)                                                                                                                                               |
| `shared-import`         | refusal  | a module under `src/shared/` (not a test) that loads at runtime anything but `zod/v4` and other modules under `src/shared/`: a slice, `src/db/`, `@fabrika/db`, a builtin                                                                                                                                                                |
| `generated-test-import` | refusal  | any module, a test included, that imports or re-exports a generated test, type-only too                                                                                                                                                                                                                                                  |
| `logic-data-access`     | hint     | `logic.ts` that loads `@fabrika/db`, a `queries.ts` or a module of `src/db/`, or uses `ctx.db` or `ctx.sql`                                                                                                                                                                                                                              |
| `cross-slice-queries`   | hint     | a module of one slice that loads another slice's `queries.ts`                                                                                                                                                                                                                                                                            |
| `handler-location`      | hint     | `.handle(…)` on a `query`, `mutation`, `cron`, `webhook` or `export` procedure outside `src/<slice>/endpoints.ts`                                                                                                                                                                                                                        |
| `data-access-location`  | hint     | `ctx.db` or `ctx.sql` outside `src/<slice>/endpoints.ts` and `queries.ts` (`logic.ts` reports `logic-data-access`)                                                                                                                                                                                                                       |

- Hints do not apply to test files or the generated entrypoint.
- A hint is syntactic: destructuring `ctx`, or passing a handle into a helper module, escapes it. The runtime binds
  every handle to its invocation; the hints only keep the structure readable.
- Hints are checker output only. They are not part of the contract, the approval snapshot or its digest, so a hint
  costs no approval.
- `fabrika-check` prints the refusals, then the hints under their own heading, then a count on stderr. It exits 0
  when only hints remain. There is no suppression syntax for either.
- Every other rule of the checker is a refusal; [`packages/check/CLAUDE.md`](../../packages/check/CLAUDE.md) lists them.
