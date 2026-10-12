---
name: fabrika-app
version: 0.0.4
description: >
  How to write and change a Fabrika application: src/vocabulary.ts, db/migrations/, src/db/tables.ts, the
  slices' endpoints.ts with their handlers, fabrika.contract.ts, jobs, files, webhooks, share links, connectors
  and the generated tests. Use whenever the repository has a fabrika.contract.ts, or the task adds an endpoint,
  a table, a migration, an action or a role.
---

# Fabrika application rules

The contract is the whole surface of the application: who may call what. The proxy admits only the calls it allows,
and the data layer scopes every row to the capability that the endpoint's access form minted. Write on the paved road
below. When it does not reach far enough, declare the step off it. A declared step is allowed, and the approver sees it.

## The files, in import order

| File                       | Holds                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`        | `defineVocabulary({ app, dimensions, actions, roles })`: written once, typed everywhere  |
| `db/migrations/*.sql`      | plain SQL, one new file per change (`bunx fabrika db new <slug>`)                        |
| `src/db/tables.ts`         | `defineTables(vocabulary, columns)({ … })`: the scope and the actions of each table      |
| `src/app-kit.ts`           | `export const app = defineApp(vocabulary, tables)`                                       |
| `src/schemas.ts`           | the `zod/v4` inputs and outputs that the shell and the SPA share                         |
| `src/<slice>/endpoints.ts` | `app.group(…)`, a `.handle(…)` beside each endpoint, and the slice's jobs and webhooks   |
| `src/<slice>/logic.ts`     | business rules as pure functions: no `ctx`, no data access                               |
| `src/<slice>/queries.ts`   | data access that the slice's handlers share, over a handle they pass in                  |
| `fabrika.contract.ts`      | `app.contract((c) => ({ api: c.rpc('/api', { … }), … }))`: mounts the groups             |
| `src/app.ts`               | `export default serve(contract, { database: scoped(tables) })` and nothing else          |
| `web/`                     | the SPA: `createClient(contract, 'api')` of `@fabrika/app/client`, never a server module |

## The paved road

```ts src/tasks/endpoints.ts
import { ConflictError, fromRow } from '@fabrika/app'
import { app } from '../app-kit'
import {
	AssignTask,
	ById,
	EditTask,
	ListTasks,
	MyTasks,
	NewTask,
	Saved,
	Task,
	TaskPage,
	Versioned,
} from '../schemas'
import { canClose } from './logic'

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListTasks,
		output: TaskPage,
		access: { action: 'tasks.read', in: 'project', from: 'projectId' },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.tasks.list({
				where: input.status === undefined ? [] : [['status', '=', input.status]],
				orderBy: [['title', 'asc']],
				after: input.after,
			})
			return {
				items: page.items.map((row) => fromRow(Task, row)),
				next: page.next,
			}
		}),
	mine: r.query({
		input: MyTasks,
		output: TaskPage,
		access: { action: 'tasks.read', over: 'org' },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.within.tasks.list({
				where: [['assignee', '=', ctx.principal.id], ['status', '<>', 'done']],
				orderBy: [['due_on', 'asc']],
				after: input.after,
			})
			return {
				items: page.items.map((row) => fromRow(Task, row)),
				next: page.next,
			}
		}),
	get: r.query({
		input: ById,
		output: Task,
		access: { action: 'tasks.read', on: 'task', from: 'id' },
	})
		.handle(async ({ ctx }) => fromRow(Task, await ctx.db.target.get())),
	create: r.mutation({
		input: NewTask,
		output: Saved,
		access: { action: 'tasks.write', in: 'project', from: 'projectId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.tasks.insert({
				title: input.title,
				due_on: input.dueOn ?? null,
			})
		),
	edit: r.mutation({
		input: EditTask,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.update({ title: input.title, due_on: input.dueOn }, {
				expectVersion: input.expectVersion,
			})
		),
	assign: r.mutation({
		input: AssignTask,
		output: Saved,
		access: { action: 'tasks.assign', on: 'task', from: 'id' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.update({ assignee: input.assignee }, {
				expectVersion: input.expectVersion,
			})
		),
	start: r.mutation({
		input: Versioned,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.update({ status: 'doing' }, {
				expectVersion: input.expectVersion,
			})
		),
	close: r.mutation({
		input: Versioned,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const task = await ctx.db.target.getForUpdate()
			if (!canClose(task.status)) {
				throw new ConflictError('only a task in progress closes')
			}
			return ctx.db.target.update({ status: 'done' }, {
				expectVersion: input.expectVersion,
			})
		}),
}))
```

- The access form gives the handler its data: `on` one object by id (`ctx.db.target` is its row; another scope's is
  404), `in` a container (`ctx.db.target.<table>.list` and `.insert`), `over` lists across the caller's scopes
  (`ctx.db.within.<table>`). `ctx.target.value` is the id; there is no `.id`.
- A row reaches an output through `fromRow(Schema, row)` (snake_case to camelCase), or comes typed from
  `ctx.sql(Schema)`. Never return a raw row for a camelCase output.
- On a versioned table `insert` and `update` answer `Saved` (`{ id, version }`), and `update` and `remove` take
  `{ expectVersion }` (a stale one is 409). `remove` answers nothing, so its endpoint answers `{ id }`. A table without
  `version` answers `{ id }` and takes no version. `update` takes the columns it changes, at least one.
- A precondition reads with `getForUpdate()` and throws `ConflictError`; the rule (`canClose`) is a pure function
  of `logic.ts`. For a business error throw `ConflictError` (409), `NotFoundError` (404) or `BadRequestError` (400) of
  `@fabrika/app`. Any thrown value with a numeric `httpStatus` below 500, a `type` and a `message` answers that status
  (the framework's other errors are such values); any other throw is a 500.
- One action per endpoint. A column that another action writes gets its own write action and its own endpoint
  (`assign` above). Never check a second action inside a handler: split the endpoint.
- Never take a user, owner or tenant id from the input. The scope comes from the access form; `ctx.principal.id` is
  the caller.

## Off the road: declare it

| What the handler needs         | Declare on the endpoint         | It gets                                            |
| ------------------------------ | ------------------------------- | -------------------------------------------------- |
| a join, a report, a bulk write | `sql: 'read'` (or `'write'`)    | `` ctx.sql(Row)`…` ``, scoped with `ctx.sql.scope` |
| rows outside its capability    | `unscoped: { <table>: 'read' }` | `ctx.db.unscoped.<table>`                          |
| another application's export   | `connect: ['<import>']`         | `ctx.connect.<import>`                             |
| a share link                   | `issues: '<link mount>'`        | `ctx.links.issue`                                  |
| a trigger, function or view    | its migration                   | —                                                  |

Scope every scoped table a raw statement reads with `${ctx.sql.scope(<capability>, '<table>', '<alias>')}`, a conjunct
of its WHERE or JOIN … ON (`where (<filter>) and ${…}`): `ctx.target` for `on` and `in`, `ctx.within` for `over`, a
job's minted `Ref` or `Within` with `tx.sql.scope`. It binds the capability's whole predicate, chain included, as the
handles apply it; a reference table needs none. A deviation is fine: declare it, and do not contort the code to
avoid it. The approver sees every declaration marked
"needs closer review". Do not hide reach in a helper; the runtime builds `ctx.sql` and `ctx.db.unscoped` only where
they are declared. A query or an export declares only `'read'`.

## Rules

- Data work first, external calls after. The invocation's one transaction rolls back on a throw; IAM, object storage
  and connector calls do not.
- No `as` (except `as const`), `any`, `@ts-ignore`, `@ts-expect-error`, `process.env` or `Bun.env`.
- Never log an error object, a request, headers or the environment.
- Never edit a generated file (`src/db/schema.generated.ts`, the generated tests, `fabrika/entry.generated.ts`,
  `fabrika/connect/`) or a committed migration. Regenerate the file; write a new migration.

## Ask the human first

- A 401, a 403 or a failing generated test: never loosen the contract, a role, a policy or a test to pass. Tell the
  human which action or role the caller lacks.
- When the task does not already ask for it, before you add a role, a grant, an action, a declared deviation, an
  anonymous endpoint (`c.form`, a webhook, a link), an export or an import, or a job, or before you drop or rename a
  column: say in one sentence what it lets someone do, and wait for a yes. A data repair goes to the operator, not
  into a job.
- A file refused as protected: stop and ask. Do not move the change elsewhere.

## The loop

Run from the application's root after every change (setup: `references/app-setup.md`):

```bash
bunx fabrika db new <slug>                                  # a new migration file
export FABRIKA_APP_ID=tasks FABRIKA_APP_DATABASE_URL="$FABRIKA_TEST_POSTGRES_URL"
bunx fabrika db migrate && bunx fabrika db codegen          # writes src/db/schema.generated.ts
bunx fabrika db test-scaffold                               # writes the generated tests; commit them
bunx tsc --noEmit
bunx fabrika-check .                                        # refusals fail; hints print below them
bun test --isolate                                          # needs FABRIKA_TEST_POSTGRES_URL; a skip proves nothing
```

`FABRIKA_APP_ID` is lowercase letters, digits and `-`. An applied file is immutable: while you still change an
uncommitted migration, migrate into a fresh schema with another `FABRIKA_APP_ID`. Read a refusal's "allowed form" and
use it; fix hints too. `references/errors.md` explains the findings and the type errors.

## References

Read the one you need before you write that part. Together they are one application to copy from:
`app-setup.md` (`package.json`, `tsconfig.json`, the contract, `fabrika.config.ts`, the SPA), `table-and-migration.md`,
`endpoint.md` (access forms, handles, lists, `fromRow`, `ctx.sql`, members), `tests.md` (generated tests, seeds,
`testKit`), `errors.md` (checker findings, type errors, runtime answers), `jobs.md`, `files.md` and
`webhooks-links-connectors.md`, all under `references/`.

## Not built yet

- The data layer runs on Bun and Postgres only (Zerops). On Cloudflare an application has no tables, jobs or files.
- An application with share links, `creates` or member management fails its generated endpoint tests: the test kit
  stands in for IAM's member directory only. Ask the human before you add one.
- Jobs are cron only and app-wide: no `ctx.jobs.enqueue`, no job per scope. A list write is off the road (`sql`).
- An MCP workspace has no shell, so `codegen` and `test-scaffold` cannot run there. Tell the human; never write a
  generated file by hand.
