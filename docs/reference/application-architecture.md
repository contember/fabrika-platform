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
  zerops.yaml                                   the build base only (Zerops); the platform writes the run section
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
      endpoint-access.fixtures.ts               authored: the inputs the scaffold cannot sample
  web/
    index.html
    main.ts                                     the SPA: createClient(contract, 'api')
    view.ts
```

## A slice

A **slice** is a directory `src/<slice>/` that owns one part of the domain. Every directory under `src/` is a slice
except `src/db/`, `src/schemas/` and `src/__tests__/`. A slice has up to three modules, each optional:

| Module                     | Holds                                                                                                     | Reaches data               |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/<slice>/endpoints.ts` | the slice's group: procedures, each with its `.handle(…)`; its jobs, webhooks, link and export procedures | through `ctx`              |
| `src/<slice>/logic.ts`     | business rules: pure functions over plain values; no `ctx`, no data, no I/O                               | no                         |
| `src/<slice>/queries.ts`   | reusable data access: functions over the handle a handler passes in                                       | only through its parameter |

Another module in a slice (`src/deals/format.ts`) is plain code of that slice. It does not reach data and holds no
handler. A slice that outgrows one `endpoints.ts` becomes two slices.

## What each file holds

| File                         | Holds                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`          | `export const vocabulary = defineVocabulary({ app, dimensions, actions, roles })`. A literal.                                                |
| `src/db/tables.ts`           | `export const tables = defineTables(vocabulary, columns)({ <table>: { scope, actions, insert, update } })`. A literal.                       |
| `src/db/schema.generated.ts` | the `DB` interfaces and `columns`, written by `fabrika db codegen`. Never edited.                                                            |
| `src/app-kit.ts`             | `export const app = defineApp(vocabulary, tables)`, and the handle types `queries.ts` modules take.                                          |
| `src/schemas.ts`             | the zod schemas of inputs and outputs, in the checker's literal subset. `src/schemas/<name>.ts` once it grows.                               |
| `src/<slice>/endpoints.ts`   | `export const <slice> = app.group({ callers }, (r) => ({ … }))`, each procedure followed by `.handle(…)`.                                    |
| `src/<slice>/logic.ts`       | `export const canReopen = (stage: Stage): boolean => …`                                                                                      |
| `src/<slice>/queries.ts`     | `export const pipelineOf = (sql: AppSql, orgId: string) => …`                                                                                |
| `fabrika.contract.ts`        | `export const contract = app.contract((c) => ({ api: c.rpc('/api', { companies, deals }), … }))`: mounts, `jobs`, `files`, `imports`, `csp`. |
| `src/app.ts`                 | `export default serve(contract, { database: scoped(tables), deps })`. Nothing else.                                                          |
| `fabrika.config.ts`          | the provider's `defineApp(…)`: services, `compileContract(contract, tables)`, the proxy table, the schema.                                   |
| `db/migrations/*.sql`        | `YYYYMMDDHHMMSS_slug.sql`, plain SQL, applied in file order.                                                                                 |
| `web/**`                     | the SPA.                                                                                                                                     |

A slice in code:

```ts
// src/deals/logic.ts
import type { DEAL_STAGES } from '../schemas'

type Stage = (typeof DEAL_STAGES)[number]

export const canReopen = (stage: Stage): boolean =>
	stage === 'won' || stage === 'lost'
```

```ts
// src/deals/queries.ts
import type { AppSql } from '../app-kit'
import { PipelineRow } from '../schemas'

export const pipelineOf = (sql: AppSql, orgId: string) =>
	sql(
		PipelineRow,
	)`select d.stage, count(*)::int as deals from deals d join companies c on c.id = d.company_id
		where c.org_id = ${orgId} group by d.stage`
```

```ts
// src/deals/endpoints.ts
import { ConflictError } from '@fabrika/app'
import { app } from '../app-kit'
import { OrgInput, Pipeline, ReopenDeal, Saved } from '../schemas'
import { canReopen } from './logic'
import { pipelineOf } from './queries'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	reopen: r.mutation({
		input: ReopenDeal,
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const deal = await ctx.db.target.getForUpdate()
			if (!canReopen(deal.stage)) {
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
			rows: await pipelineOf(ctx.sql, ctx.target.id),
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
	site: c.spa('/', { callers: ['human'] }),
	health: c.health('/healthz'),
}))
```

## Imports

Rows are the importing module. "Checker" names what `fabrika-check` reports for a forbidden import. A type-only
import (`import type`) is erased and is free everywhere, except of a generated test.

| Module                             | May import                                                                                        | Must not import                                                                       | Checker                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/vocabulary.ts`                | `@fabrika/app/contract`                                                                           | any module of the application                                                         | `literal` (refusal): the contract graph is a literal |
| `src/db/tables.ts`                 | `@fabrika/db/tables`, `src/vocabulary.ts`, `src/db/schema.generated.ts`                           | the kit, a slice, the contract                                                        | `literal` (refusal)                                  |
| `src/app-kit.ts`                   | `@fabrika/app/contract`, `src/vocabulary.ts`, `src/db/tables.ts`                                  | a slice, the contract                                                                 | —                                                    |
| `src/schemas.ts`                   | `zod/v4`, another schemas module                                                                  | anything else                                                                         | `literal` (refusal)                                  |
| `src/<slice>/endpoints.ts`         | the kit, the schemas, its own `logic.ts` and `queries.ts`, any slice's `logic.ts`, `@fabrika/app` | another slice's `queries.ts`                                                          | `cross-slice-queries` (hint)                         |
| `src/<slice>/logic.ts`             | the schemas, any slice's `logic.ts`, plain libraries, `@fabrika/app` (its errors)                 | `@fabrika/db`, a `queries.ts`, `src/db/`                                              | `logic-data-access` (hint)                           |
|                                    |                                                                                                   | any other `@fabrika/*` module                                                         | `layer-import` (refusal)                             |
| `src/<slice>/queries.ts`           | the kit's types, the schemas, its own `logic.ts`, `@fabrika/app`, `@fabrika/db`                   | another slice's `queries.ts`                                                          | `cross-slice-queries` (hint)                         |
|                                    |                                                                                                   | any other `@fabrika/*` module                                                         | `layer-import` (refusal)                             |
| `fabrika.contract.ts`              | the kit, the slices' `endpoints.ts`, the schemas                                                  | —                                                                                     | —                                                    |
| `src/app.ts`                       | `@fabrika/app/implement` (`serve`), `@fabrika/db` (`scoped`), the contract, `src/db/tables.ts`    | —                                                                                     | —                                                    |
| `web/**`                           | `@fabrika/app/client`, `fabrika.contract.ts`, the schemas, other `web/` modules, browser packages | any other application module, any other `@fabrika/*` module, `bun`, `bun:*`, `node:*` | `spa-server-import` (refusal)                        |
| a test (`*.test.ts`, `__tests__/`) | anything, the test kits included                                                                  | a generated test                                                                      | `generated-test-import` (refusal)                    |
| any module but a test              | —                                                                                                 | `@fabrika/app/testing`, `@fabrika/db/testing`, a test module                          | `test-only-import` (refusal)                         |
| any module                         | —                                                                                                 | a generated test                                                                      | `generated-test-import` (refusal)                    |

The import maps of `package.json` (`imports`) and `tsconfig.json` (`paths`) are followed: a mapped specifier is
judged by the file or package it lands on.

## What each part may call

- **A handler** (`.handle(…)` in `src/<slice>/endpoints.ts`) is the only code with `ctx`. It reaches data through
  `ctx.db` (the paved road, bound to the capability its access form minted: `ctx.db.target`, `ctx.db.within`,
  `ctx.db.reference`), calls the slice's logic with plain values, and passes `ctx.db.*` or `ctx.sql` to a function of
  `queries.ts`. It throws `ConflictError`, `NotFoundError` and `BadRequestError` from `@fabrika/app`. Data work comes
  first, external calls after: IAM, object storage and connector effects do not roll back with the invocation.
- **Off-road reach is declared on the procedure** in the shell, and the runtime builds the handle only there:

  | Declaration                                | Gives the handler                                |
  | ------------------------------------------ | ------------------------------------------------ |
  | `sql: 'read' \| 'write'`                   | `ctx.sql`; a query or export takes only `'read'` |
  | `unscoped: { <table>: 'read' \| 'write' }` | `ctx.db.unscoped.<table>`, in that mode          |
  | `connect: ['<connector>']`                 | `ctx.connect.<connector>`                        |
  | `issues: '<mount>'`                        | `ctx.links.issue`                                |

- **Logic** (`logic.ts`) is pure: values in, values out. It does not see `ctx`, a handle or a row it did not get as an
  argument. Its tests need no database.
- **A query function** (`queries.ts`) takes the handle as a parameter (`ctx.db.target`, `ctx.db.within.<table>`,
  `ctx.sql`) and returns parsed values (`fromRow`). It decides no authorization: the capability already bounds the
  handle. It is called from its own slice's handlers.
- **A job** is a `c.cron` procedure with its `.handle(…)` in the `endpoints.ts` of the slice whose data it works on;
  the contract's `jobs` section names it. An attempt retries, so its writes are idempotent.
- **A webhook** is declared and handled the same way; it keys idempotency on `ctx.delivery.key`.
- **A link mount's procedures** and **an export's procedures** (the owner's side of a connector) carry their
  `.handle(…)` in the owning slice's `endpoints.ts`; the contract mounts them with `c.link` and `c.export`.
- **A connector import** is declared in the contract's `imports`; a procedure that calls it declares `connect`, and
  its handler calls `ctx.connect.<connector>`.
- **A file collection** is `c.files` in the contract's `files` section. Its endpoints are generated; it has no handler.
- **`src/app.ts`** composes and does nothing else: no route, no middleware, no handler.
- **The SPA** builds its client with `createClient(contract, 'api')` from `@fabrika/app/client`. Its bundle is built
  through `@fabrika/check/bun-plugin`, which loads `fabrika.contract.ts` without its handlers. It imports
  `src/schemas.ts` for shared constants and schemas, and never a slice.

## Tests and fixtures

- **Generated tests** — `src/db/__tests__/<table>.policy-isolation.test.ts` and
  `src/__tests__/endpoint-access.test.ts` — are what `fabrika db test-scaffold` writes. They are committed and never
  edited (`generated-test-hash`), and no module imports one (`generated-test-import`).
- **Authored inputs** for the endpoint access tests are `src/__tests__/endpoint-access.fixtures.ts`, read statically.
- **Authored tests** live beside what they test: `src/<slice>/__tests__/*.test.ts` or `src/<slice>/*.test.ts`. A
  logic test calls the functions. A handler test boots the application through `testKit` from
  `@fabrika/app/testing` and calls it through the typed client.
- **The test kits** (`@fabrika/app/testing`, `@fabrika/db/testing`) and helper modules under `__tests__/` are imported
  only by test files.

## What the checker reports

| Rule                    | Severity | Reports                                                                                                                                                                                                                                    |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spa-server-import`     | refusal  | a module under `web/` (not a test) that loads an application module other than `fabrika.contract.ts`, `src/schemas.ts`, `src/schemas/**` and `web/**`, a `@fabrika/*` module other than `@fabrika/app/client`, or `bun`, `bun:*`, `node:*` |
| `layer-import`          | refusal  | `src/<slice>/logic.ts` or `queries.ts` that loads a `@fabrika/*` module other than `@fabrika/app` and `@fabrika/db` (the test kits are `test-only-import`'s)                                                                               |
| `generated-test-import` | refusal  | any module, a test included, that imports or re-exports a generated test, type-only too                                                                                                                                                    |
| `logic-data-access`     | hint     | `logic.ts` that loads `@fabrika/db`, a `queries.ts` or a module of `src/db/`, or uses `ctx.db` or `ctx.sql`                                                                                                                                |
| `cross-slice-queries`   | hint     | a module of one slice that loads another slice's `queries.ts`                                                                                                                                                                              |
| `handler-location`      | hint     | `.handle(…)` on a `query`, `mutation`, `cron`, `webhook` or `export` procedure outside `src/<slice>/endpoints.ts`                                                                                                                          |
| `data-access-location`  | hint     | `ctx.db` or `ctx.sql` outside `src/<slice>/endpoints.ts` and `queries.ts` (`logic.ts` reports `logic-data-access`)                                                                                                                         |

- Hints do not apply to test files or the generated entrypoint.
- A hint is syntactic: destructuring `ctx`, or passing a handle into a helper module, escapes it. The runtime binds
  every handle to its invocation; the hints only keep the structure readable.
- Hints are checker output only. They are not part of the contract, the approval snapshot or its digest, so a hint
  costs no approval.
- `fabrika-check` prints the refusals, then the hints under their own heading, then a count on stderr. It exits 0
  when only hints remain. There is no suppression syntax for either.
- Every other rule of the checker is a refusal; [`packages/check/CLAUDE.md`](../../packages/check/CLAUDE.md) lists them.
