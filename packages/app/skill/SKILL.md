---
name: fabrika-app
version: 0.9.0-cloudflare.1
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
| `src/schemas.ts`           | the `zod/v4` schemas several slices, or a slice and the SPA, share                       |
| `src/shared/*.ts`          | pure functions the SPA and the slices both run; they import only `zod/v4` and each other |
| `src/<slice>/endpoints.ts` | `app.group(…)`, a `.handle(…)` beside each endpoint, and the slice's jobs and webhooks   |
| `src/<slice>/logic.ts`     | business rules as pure functions: no `ctx`, no data access                               |
| `src/<slice>/queries.ts`   | data access that the slice's handlers share, over a handle they pass in                  |
| `fabrika.contract.ts`      | `app.contract((c) => ({ api: c.rpc('/api', { … }), … }))`: mounts the groups             |
| `src/app.ts`               | `export default serve(contract, { database: scoped(tables) })` and nothing else          |
| `web/`                     | the SPA: React over `@fabrika/app/react` and `@fabrika/ui`, never a server module        |

## The paved road

```ts src/tasks/endpoints.ts
import { BadRequestError, ConflictError, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, Cursor, Saved, TaskStatus, Versioned } from '../schemas'
import { canClose } from './logic'

const Task = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	title: z.string(),
	status: TaskStatus,
	assignee: z.nullable(z.string()),
	assigneeLabel: z.nullable(z.string()),
	dueOn: z.nullable(z.iso.date()),
	overdue: z.boolean(),
	version: z.int(),
})
const TaskPage = z.strictObject({
	items: z.array(Task),
	next: z.nullable(z.string()),
})
const ListTasks = z.strictObject({
	projectId: z.uuid(),
	status: TaskStatus.optional(),
	title: z.string().min(1).max(200).optional(),
	after: Cursor.optional(),
})
const MyTasks = z.strictObject({ after: Cursor.optional() })
const NewTask = z.strictObject({
	projectId: z.uuid(),
	title: z.string().min(1).max(200),
	dueOn: z.iso.date().optional(),
})
const EditTask = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.string().min(1).max(200),
	dueOn: z.nullable(z.iso.date()),
})
const AssignTask = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	assignee: z.nullable(z.string().max(100)),
})

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListTasks,
		output: TaskPage,
		access: { action: 'tasks.read', in: 'project', from: 'projectId' },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.tasks.list({
				where: [
					...(input.status === undefined
						? []
						: [['status', '=', input.status] as const]),
					...(input.title === undefined
						? []
						: [['title', 'ilike', `%${input.title}%`] as const]),
				],
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
		access: { action: 'tasks.read', over: 'project' },
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
		.handle(async ({ input, ctx }) => {
			const member = input.assignee === null
				? null
				: await ctx.members.get(input.assignee)
			if (input.assignee !== null && (member === null || member.disabled)) {
				throw new BadRequestError('the assignee is not a member of the org')
			}
			return ctx.db.target.update({
				assignee: member?.principalId ?? null,
				assignee_label: member?.label ?? null,
			}, { expectVersion: input.expectVersion })
		}),
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
  (`ctx.db.within.<table>`), named by the nearest dimension of the rows' chain (tasks lie in a project).
  `ctx.target.value` is the id; there is no `.id`.
- A row reaches an output through `fromRow(Schema, row)` (snake_case to camelCase), a list's page through
  `fromPage(Schema, page)`, or comes typed from `ctx.sql(Schema)`. Never return a raw row for a camelCase output.
- On a versioned table `insert` and `update` answer `Saved` (`{ id, version }`), and `update` and `remove` take
  `{ expectVersion }` (a stale one is 409). `remove` answers nothing, so its endpoint answers `{ id }`. A table without
  `version` answers `{ id }` and takes no version. `update` takes the columns it changes, at least one.
- A precondition reads with `getForUpdate()` and throws `ConflictError`; the rule (`canClose`) is a pure function
  of `logic.ts`. For a business error throw `ConflictError` (409), `NotFoundError` (404) or `BadRequestError` (400) of
  `@fabrika/app`. Any thrown value with a numeric `httpStatus` below 500, a `type` and a `message` answers that status
  (the framework's other errors are such values); any other throw is a 500.
- One action per endpoint. A column that another action writes gets its own write action and its own endpoint
  (`assign` above). Never check a second action inside a handler: split the endpoint. An operation that reads one
  object and writes another (a copy from one deal to another) declares both under
  `access: { capabilities: { <name>: <form>, … } }` (`references/endpoint.md`).
- Never take a user, owner or tenant id from the input, nor the caller's own address. The scope comes from the access
  form; `ctx.principal.id` is the caller, and `ctx.principal.email` its address. A person someone picks (`assign` above) is checked with `ctx.members.get(id)`, which answers `null` for
  anyone outside the org, and its label comes from that answer, never from the input.

## The SPA

The SPA is React: `FabrikaProvider` over `createClient(contract, 'api')`, `useQuery`, `useInfiniteQuery` and
`useMutation` of `@fabrika/app/react` for every call (typed by the contract, one `FabrikaError` union for every
refusal), and the screens built from `@fabrika/ui` (`AppShell`, `PageHeader`, `DataTable`, `Form` and `Field`,
`Dialog`, …) with its router and theme. Never write DOM helpers, a router, a cache or a component kit of your own.
`useCaller()` and `<Can>` show or hide a control by what the token grants; they are information for the page, never
the access check. `references/spa.md` shows the stack.

## Off the road: declare it

| What the handler needs         | Declare on the endpoint                                 | It gets                                            |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| a join, a report, a bulk write | `sql: 'read'` (or `'write'`)                            | `` ctx.sql(Row)`…` ``, scoped with `ctx.sql.scope` |
| rows outside its capability    | `unscoped: { <table>: 'read' }`                         | `ctx.db.unscoped.<table>`                          |
| another application's export   | `connect: ['<import>']`                                 | `ctx.connect.<import>`                             |
| a share link                   | `issues: '<link mount>'`                                | `ctx.links.issue`                                  |
| e-mail (a cron job only)       | `mailer: 'installation'`                                | `ctx.mail.send`                                    |
| a file from a public procedure | `file('<kind>')` input, `admission` with `bytesPerHour` | a reference the handler writes into a file column  |
| an outside HTTPS API           | `egress: ['https://api.example.com']`                   | `fetch` to exactly those origins                   |
| any public website (a job)     | `egress: 'public'`                                      | `fetch` to public hosts, never the installation    |
| a signed link (unsubscribe)    | `signs: ['<purpose>']`                                  | `ctx.tokens.sign`                                  |
| a webhook binding              | `binds: '<webhook>'`                                    | `ctx.webhooks('<webhook>').bind` and `.unbind`     |
| a job run after the commit     | `kicks: ['<job>']`                                      | `ctx.kick('<job>')`                                |
| a trigger, function or view    | its migration                                           | —                                                  |

Scope every scoped table a raw statement reads with `${ctx.sql.scope(<capability>, '<table>', '<alias>')}`, a conjunct
of its WHERE or JOIN … ON (`where (<filter>) and ${…}`): `ctx.target` for `on` and `in`, `ctx.within` for `over`, a
job's minted `Ref` or `Within` with `tx.sql.scope`. It binds the capability's whole predicate, chain included, as the
handles apply it, and on an `update` or `delete` target it needs that operation's action; a reference table needs
none. A deviation is fine: declare it, and do not contort the code to avoid it. The approver sees every declaration
marked "needs closer review". Do not hide reach in a helper; the runtime builds `ctx.sql` and `ctx.db.unscoped` only
where they are declared. A query or an export declares only `'read'`.

Which promise the types, the checker, boot, the runtime or the approver keeps, and which declaration lifts each:
[who enforces each guarantee](https://github.com/contember/fabrika-platform/blob/main/docs/reference/application-runtime.md#who-enforces-each-guarantee).

## Rules

- Data work first, external calls after. The invocation's one transaction rolls back on a throw; IAM, object storage
  and connector calls do not. An endpoint the generated tests cover calls no outside service (a provider's API): it
  records an outbox row, and a job makes the call (`references/jobs.md`).
- An endpoint never sends e-mail; it has no `ctx.mail`. It records an outbox row, declares `kicks: ['<job>']` and calls `ctx.kick('<job>')`, which
  starts that job once its transaction committed. The job declares `mailer` and sends with `ctx.mail`, under a key
  derived from the row, and sends again only where `ctx.mail.mayRetry(error)` allows it (`references/jobs.md`).
- No `as` (except `as const`), `any`, `@ts-ignore`, `@ts-expect-error`, `process.env` or `Bun.env`.
- Never log an error object, a request, headers or the environment.
- Never edit a generated file (`src/db/schema.generated.ts`, the generated tests, `fabrika/entry.generated.ts`,
  `fabrika/migrations.generated.ts`, `fabrika/connect/`) or a committed migration. Regenerate the file; write a new migration.

## Ask the human first

- A 401, a 403 or a failing generated test: never loosen the contract, a role, a policy or a test to pass. Tell the
  human which action or role the caller lacks.
- When the task does not already ask for it, before you add a role, a grant, an action, a declared deviation, an
  anonymous endpoint (a public procedure, its file field, a webhook, a link), an export or an import, or a job, or before you drop or rename a
  column: say in one sentence what it lets someone do, and wait for a yes. A data repair goes to the operator, not
  into a job.
- A file refused as protected: stop and ask. Do not move the change elsewhere.

## The loop

Run from the application's root (setup: `references/app-setup.md`). The application you are handed is green: a tsc or
checker run before you have written anything proves nothing.

1. Write the slice and its tests. A schema change first adds a migration and runs `migrate` and `codegen`; a
   handler-only change needs neither.
2. Run `test-scaffold` when an endpoint, its access or a table policy changed.
3. Run `bun test --isolate` until it passes. Bun strips the types and runs the tests without checking them, so this is
   the cheap loop.
4. Then run `tsc` and `fabrika-check` once each, in that order, at the end. The checker reads the tests too (a cast, a
   skipped or assertion-free test, a generated test's hash).
5. After a finding, fix it and re-run only what that fix needs: the step that found it and any later one. A checker fix
   re-runs `tsc` only when it changed a type (a removed cast does), and the tests only when it changed what code does.

```bash
bunx fabrika db new <slug>                                  # a new migration file
export FABRIKA_APP_ID=tasks FABRIKA_APP_DATABASE_URL="$FABRIKA_TEST_POSTGRES_URL"
bunx fabrika db migrate && bunx fabrika db codegen          # writes src/db/schema.generated.ts
bunx fabrika db test-scaffold                               # writes the generated tests; commit them
bun test --isolate                                          # until it passes; needs FABRIKA_TEST_POSTGRES_URL; a skip proves nothing
bunx tsc --noEmit                                           # once, at the end
bunx fabrika-check .                                        # once, after tsc; refusals fail; hints print below them
```

**On Cloudflare** (`fabrika.config.ts` imports `defineApp` from `@fabrika/provider-cloudflare`) the application runs in
one Durable Object over SQLite. Its `db/migrations/*.sql` are SQLite (`references/table-and-migration.md`), and the
object applies them when it boots, so there is no `migrate` and no command needs a database URL or `FABRIKA_APP_ID`.
The tests run on `@fabrika/db/testing-sqlite` (`references/tests.md`), in memory, and never skip. A handler holds the
object's transaction, so its `limits.timeoutMs` is at most 25 s. No `sql` (`ctx.sql`) and no `scan: true`: the
checker, the deploy and the boot refuse both. The deploy serves each SPA mount's built `dir` itself; declare no
`assets` on the Worker (`references/app-setup.md`).

The object runs one transaction at a time, so every `await` in a handler that may write holds the whole environment:
IAM, R2, a `fetch`, a `ctx.connect` call, a binding. One 2 s call caps the environment at half a request a second. A
query holds no transaction: each of its statements runs on its own, so two of its reads may see different committed
states. Inside a
mutation keep I/O to the framework's own: IAM, and the file it writes. A slow outside call goes into a row, the
mutation calls `ctx.kick('<job>')`, and the job makes the call outside `ctx.transaction` (`references/jobs.md`). The
checker hints on a mutation that declares `egress` or `connect` (`cloudflare-held-call`), and refuses
`DEFAULT CURRENT_TIMESTAMP` in a migration (`cloudflare-current-timestamp`).

```bash
bunx fabrika db new <slug>                                  # a new SQLite migration file
bunx fabrika db codegen                                     # applies the migrations in memory; writes src/db/schema.generated.ts
bunx fabrika db test-scaffold                               # the generated tests, on @fabrika/db/testing-sqlite
bun test --isolate                                          # no database URL; then tsc and fabrika-check as above
```

A generated file changes only through its command (`codegen`, `test-scaffold`); running it is the loop, not an edit.
Format and lint only the files you wrote, with the repository's own tools: in the fabrika-platform repository
`bunx dprint fmt <files>` and `bunx biome lint <files>`, never `biome check` (its formatter fights dprint), and never a
generated file. An application outside that repository has neither configuration: use the formatter its own
repository configures, or none, and never add a configuration unasked; tsc and `fabrika-check` are its gates. `FABRIKA_APP_ID` is lowercase letters, digits and `-`. An applied file is immutable: while you still
change an uncommitted migration, migrate into a fresh schema with another `FABRIKA_APP_ID`. Read a refusal's
"allowed form" and use it; fix hints too. `references/errors.md` explains the findings and the type errors.

## Previewing the screens

`bunx fabrika app dev` serves the application on a loopback port through its test kit, filled by `dev/seed.ts`
through the endpoints. Pick a persona at `/__fabrika/dev`; the toolbar on every page switches it and lists the mail IAM
and the application's jobs sent. Write the seed and use it as `references/dev.md` says; it never replaces a test.

## References

Read the one you need before you write that part. Together they are one application to copy from: `app-setup.md`
(`package.json`, `tsconfig.json`, the contract, `fabrika.config.ts`, the SPA's build), `spa.md` (the hooks, forms and
their errors, the caller, the components, routing, theming, screen tests), `table-and-migration.md`, `endpoint.md`
(access forms, several capabilities, which `over`, the caller's scopes, handles, lists and aggregates, `fromRow`,
`ctx.sql`, audited CSV downloads, `admission` and `limits`, the HTTP shape and `redirect()`, signed tokens, `egress`,
`ctx.url`, a mount's `compatibility`, another origin, members and labels), `tests.md` (generated tests, seeds, `testKit`, a reused scope, a caller's label, confirming a file ran),
`errors.md` (checker findings, type errors, runtime answers), `dev.md` (the seed and the preview), `jobs.md` (which dimension `ctx.within` names, the UTC
day, queue tables and `claim`, e-mail through `ctx.mail` with attachments and unsubscribe, the outbox and `kicks`),
`files.md` and `webhooks-links-connectors.md`, all under `references/`. Two are applications of their own:
`start.md`, a new application before its first table (its first test, adding the first table, installing and updating
this skill), and `public-intake.md`, a public page, public procedures, a job that claims their rows, issues links and
e-mails them, a link holder's files, HR's review with its history.

## Not built yet

- On Cloudflare, where the application runs in one Durable Object over its SQLite and its `db/migrations/*.sql` are
  SQLite, `sql` (`ctx.sql`) and a file kind with `scan: true` are refused. Everything else on the road runs there.
- Jobs are cron only and app-wide: no `ctx.jobs.enqueue`, no job per scope. A `ctx.kick` starts a run of its job; it
  carries nothing, and the job finds its work in a queue table with `claim`. A list write is off the road (`sql`).
- A read across tables (a join, a filter over a related table, an aggregate over several) is off the road (`sql`).
- An MCP workspace has no shell, so `codegen` and `test-scaffold` cannot run there. Tell the human; never write a
  generated file by hand.
