<!-- Generated from skill/ of @fabrika/app 0.0.4. Change those files, not this one. -->

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
| `src/<slice>/endpoints.ts` | `app.group(…)`, a `.handle(…)` beside each endpoint, and the slice's jobs and webhooks   |
| `src/<slice>/logic.ts`     | business rules as pure functions: no `ctx`, no data access                               |
| `src/<slice>/queries.ts`   | data access that the slice's handlers share, over a handle they pass in                  |
| `fabrika.contract.ts`      | `app.contract((c) => ({ api: c.rpc('/api', { … }), … }))`: mounts the groups             |
| `src/app.ts`               | `export default serve(contract, { database: scoped(tables) })` and nothing else          |
| `web/`                     | the SPA: `createClient(contract, 'api')` of `@fabrika/app/client`, never a server module |

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
  (`assign` above). Never check a second action inside a handler: split the endpoint.
- Never take a user, owner or tenant id from the input, nor the caller's own address. The scope comes from the access
  form; `ctx.principal.id` is the caller, and `ctx.principal.email` its address. A person someone picks (`assign` above) is checked with `ctx.members.get(id)`, which answers `null` for
  anyone outside the org, and its label comes from that answer, never from the input.

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

A generated file changes only through its command (`codegen`, `test-scaffold`); running it is the loop, not an edit.
Format and lint only the files you wrote, with the repository's own tools: in the fabrika-platform repository
`bunx dprint fmt <files>` and `bunx biome lint <files>`, never `biome check` (its formatter fights dprint), and never a
generated file. An application outside that repository has neither configuration: use the formatter its own
repository configures, or none, and never add a configuration unasked; tsc and `fabrika-check` are its gates. `FABRIKA_APP_ID` is lowercase letters, digits and `-`. An applied file is immutable: while you still
change an uncommitted migration, migrate into a fresh schema with another `FABRIKA_APP_ID`. Read a refusal's
"allowed form" and use it; fix hints too. `references/errors.md` explains the findings and the type errors.

## References

Read the one you need before you write that part. Together they are one application to copy from: `app-setup.md`
(`package.json`, `tsconfig.json`, the contract, `fabrika.config.ts`, the SPA), `table-and-migration.md`, `endpoint.md`
(access forms, which `over`, the caller's scopes, handles, lists and aggregates, `fromRow`, `ctx.sql`, audited CSV
downloads, members and labels), `tests.md` (generated tests, seeds, `testKit`, a reused scope, a caller's label, confirming a file ran),
`errors.md` (checker findings, type errors, runtime answers), `jobs.md` (which dimension `ctx.within` names, the UTC
day), `files.md` and `webhooks-links-connectors.md`, all under `references/`. Two are applications of their own:
`start.md`, a new application before its first table (its first test, adding the first table, installing and updating
this skill), and `public-intake.md`, a public page, a form, a job that issues links and e-mails them, a link holder's
files, HR's review with its history.

## Not built yet

- The data layer runs on Bun and Postgres only (Zerops). On Cloudflare an application has no tables, jobs or files.
- Jobs are cron only and app-wide: no `ctx.jobs.enqueue`, no job per scope. A list write is off the road (`sql`).
- An MCP workspace has no shell, so `codegen` and `test-scaffold` cannot run there. Tell the human; never write a
  generated file by hand.

---

# references/app-setup.md — the repository of an application

An application is the root of its own repository: Zerops reads `zerops.yaml` there. In the fabrika-platform
repository an example is a workspace under `examples/<name>/`, laid out the same way. This file shows an application
with tables and an SPA; a new one starts without either (`references/start.md`), and each part below that belongs to
the SPA is added with it.

## Packages and compiler

```json package.json
{
	"name": "tasks",
	"private": true,
	"type": "module",
	"scripts": {
		"build:manifest": "fabrika app build --env=prod",
		"build:web": "bun build-web.ts",
		"typecheck": "tsc --noEmit",
		"test": "bun test --isolate"
	},
	"dependencies": {
		"@fabrika/app": "^0.0.4",
		"@fabrika/db": "^0.0.4",
		"@fabrika/provider-zerops": "^0.0.4",
		"@fabrika/proxy-core": "^0.0.4",
		"@sentry/browser": "10.69.0",
		"kysely": "0.29.6",
		"zod": "^3.25.76"
	},
	"devDependencies": {
		"@fabrika/check": "^0.0.4",
		"@fabrika/cli": "^0.0.4",
		"@fabrika/platform": "^0.0.4",
		"@types/bun": "latest",
		"typescript": "^5.9.3"
	}
}
```

- The name is not under `@fabrika/*` (that scope is the platform's), and every `@fabrika/*` version is a registry
  range, never `workspace:*`. The checker refuses both (`package-replacement`). Inside the fabrika-platform repository
  Bun still links the workspace copies.
- `build:web` builds the SPA: add it, `build-web.ts`, `web/`, the contract's `site` mount and the `bun run build:web`
  line of `zerops.yaml` when the application gets an SPA, and not before.
- `kysely` is there for the generated schema's types. `@sentry/browser` reports the SPA's errors to Operations, from
  the DSN and release the framework serves at `<prefix>/__fabrika-config.json`.
- After you create a new workspace in a monorepo, run `bun install` at the repository root. Until then every
  `@fabrika/*` import fails and tsc reports a cascade of implicit `any`s that are not your bugs.

```json tsconfig.json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"lib": ["ES2022", "DOM", "DOM.Iterable"],
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"noPropertyAccessFromIndexSignature": true,
		"forceConsistentCasingInFileNames": true,
		"skipLibCheck": true,
		"isolatedModules": true,
		"noEmit": true,
		"types": ["@types/bun"]
	},
	"include": ["src/**/*", "web/**/*", "*.ts"]
}
```

The tsconfig stands alone: no `extends` of a file outside the application. `lib` is ES2022, so `toSorted` and other
newer methods are not there.

## The composition

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables)
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { priorities } from './src/priorities/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
	}),
	site: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

export default serve(contract, { database: scoped(tables) })
```

- Mounts: `c.rpc(prefix, groups)` once per prefix, `c.spa(prefix, { dir, access })`, `c.health('/healthz')` (required
  on Zerops), `c.form(path, { input, appendTo, then? })` (an anonymous form that appends one row and runs no handler), a
  webhook, a link mount. An SPA's `access` is `{ member: true }`, `{ action, over }`, or `{ public: true }` for a page
  anyone opens without signing in (a landing page, a public form): the approver sees it as "for anyone". A public SPA
  at `/` answers every `GET` no more specific endpoint serves; give a member SPA its own prefix (`/app`). Sections:
  `files`, `jobs`, `exports`, `csp` (`connectSrc`, `imgSrc`, `frameAncestors`, `scriptSrc`, `frameSrc`: exact
  `https://` origins, each with a `purpose`, at most 16 each). No path under `/__fabrika`.
- A public form's abuse control, all optional on `c.form`: `rate: { perClient, perForm }` (per minute, shared by
  every instance; 10 and 100 by default; 429 past either), `honeypot: '<field>'` (a `z.optional(z.string())` input
  field the page hides; a filled one gets the same answer and writes nothing) and
  `challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }`. A challenge needs the input field
  `challengeToken: z.string()`, which the page fills from the Turnstile widget rendered with `action` set to the
  form's mount name; the framework verifies it on the server (a failed token 400, an unreachable provider 503, no
  row either way) and adds Turnstile's origin to the CSP. `secret` names an application variable the human sets,
  never the value; without it the application does not boot. Neither field reaches the inbox, so neither is a
  column. On Zerops every visitor still shares one client address (the balancer), so `perClient` acts as a second
  per-form limit: raise it, and use the challenge. `references/public-intake.md` builds a whole public intake on it.
- `then: '<job>'` on `c.form` names a cron job of the same contract (`jobs`), which each accepted submission kicks
  once its row committed: a run starts within seconds, under the job's own key, and the answer stays the same constant
  and never waits for it. Kicks coalesce on the job's lease (at most one run and one pending, however many visitors
  submit), so the job still drains its inbox in batches under its own budgets. Keep its schedule: it is the recovery
  path for a kicked run that died. A kick carries nothing; the job reads its inbox. `kit.runJob` first waits for the
  kicked runs.
- `src/app.ts` composes and does nothing else. A dependency built from the application's own variables is
  `defineDeps(build)`, passed as `serve(contract, { database, deps })` and read in a handler with `get()`. Never read
  `process.env`. `build` runs at every boot, the generated tests' too, which pass no variable: read a variable when
  the dependency is used, and fail there (`src/mail.ts` in `references/public-intake.md`).

## The deploy surface (Zerops)

```ts fabrika.config.ts
import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

const compiled = compileContract(contract, tables)

const services = (): ZeropsServiceSpec[] => [
	{
		hostname: 'tasksdb',
		type: 'postgresql:single@18',
		profile: 'oltp-hobby',
		priority: 100,
	},
	{
		hostname: 'tasksapi',
		type: 'alpine/bun@1.3',
		priority: 10,
		enableSubdomainAccess: false,
		minContainers: 1,
		maxContainers: 2,
	},
]

export default defineApp({
	id: contract.vocabulary.app,
	schema: schemaFromContract(compiled),
	target: {
		platform: 'zerops',
		services,
		contract: compiled,
		proxy: { upstream: 'tasksapi:3000', ...contractProxyTable(compiled) },
		deployService: 'tasksapi',
		zeropsSetup: 'tasksapi',
	},
})
```

```yaml
# zerops.yaml: write only build.base, build.os and the SPA's buildCommands; the platform generates the rest.
# Without an SPA, the build holds only base: the platform installs the packages itself.
zerops:
  - setup: tasksapi
    build:
      base: alpine/bun@1.3
      buildCommands:
        - bun install --frozen-lockfile
        - bun run build:web
```

The platform's build runs the tests, writes the entrypoint, runs `fabrika-check` and the type check. Its start script
runs `fabrika db migrate`, `fabrika db codegen --verify` and `fabrika db test-isolation` before the server: the
application is not ready until every generated test passes. It writes every `FABRIKA_*` variable; never set one.

## The SPA (added when the application has one)

```ts web/main.ts
import { createClient, RpcError } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'

const api = createClient(contract, 'api')

export const showMine = async (list: HTMLElement): Promise<void> => {
	try {
		const page = await api.tasks.mine({})
		list.replaceChildren(
			...page.items.map((task) =>
				Object.assign(document.createElement('li'), { textContent: task.title })
			),
		)
	} catch (error) {
		list.textContent = error instanceof RpcError
			? `Failed: ${error.type}`
			: 'Failed'
	}
}
```

```html web/index.html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<title>Tasks</title>
		<script type="module" src="./start.ts"></script>
	</head>
	<body>
		<ul id="mine"></ul>
	</body>
</html>
```

```ts web/start.ts
import { showMine } from './main'

const list = document.getElementById('mine')
if (list !== null) void showMine(list)
```

```ts build-web.ts
import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

const built = await Bun.build({
	entrypoints: [join(import.meta.dir, 'web', 'index.html')],
	outdir: join(import.meta.dir, 'dist', 'web'),
	target: 'browser',
	plugins: [shellSlicePlugin({ root: import.meta.dir })],
})
if (!built.success) {
	for (const log of built.logs) console.error(String(log))
	process.exit(1)
}
```

- The SPA imports `@fabrika/app/client`, `fabrika.contract.ts`, `src/schemas.ts` and its own modules; never a slice,
  `src/db/` or a Bun or Node module. The plugin loads the contract without its handlers.
- Set text with `textContent`, never `innerHTML`. Same-origin calls carry the session cookie.
- **Who is signed in.** Every member SPA serves `<prefix>/__fabrika-me.json` to the person it admitted:
  `{ label, email, actions: { app, scopes } }`, read by `parsePageCaller` (`@fabrika/app/client`). `app` lists the
  actions held as a global grant, `scopes` each value with its own (`{ type, value, actions }`); a pattern grant is
  listed as the contract's actions it covers. It comes from the token and asks IAM nothing. Use it to greet the person
  and to show or hide a control, never as the check: every endpoint decides again, so a hidden button is no
  protection. A public SPA answers it 401, because its pages arrive without a token, signed in or not.

```ts web/caller.ts
import { parsePageCaller } from '@fabrika/app/client'

/** Who the page's person is, and whether they hold `action` app-wide. */
export const signedIn = async (action: string) => {
	const response = await fetch('/__fabrika-me.json')
	if (!response.ok) return null
	const caller = parsePageCaller(await response.json())
	return { email: caller.email, holds: caller.actions.app.includes(action) }
}
```

## Ignored files

`.gitignore`: `node_modules/`, `fabrika.manifest.json`, `/fabrika/entry.generated.ts`, `/dist/`.

---

# references/endpoint.md — endpoints, their handles and raw SQL

An endpoint is declared and handled in one place: `r.query({ input, output, access, … }).handle(async ({ input,
ctx }) => …)` inside `app.group({ callers }, (r) => ({ … }))` of a slice's `endpoints.ts`. The kit types the handler by
its endpoint: a field the output does not declare, a handle the access form does not give and a write in a query are
type errors at their line.

## Schemas

```ts src/schemas.ts
import { z } from 'zod/v4'

export const TaskStatus = z.enum(['open', 'doing', 'done'])
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const ById = z.strictObject({ id: z.uuid() })
export const Versioned = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
})
export const Cursor = z.string().max(500)
export const OrgInput = z.strictObject({ orgId: z.string().min(1).max(100) })
```

- `z` comes from `zod/v4`. Objects are `z.strictObject`, never `z.object`. No `transform`, `refine`, `pipe`,
  `preprocess`, `passthrough`, `lazy` or `custom`: the shell is read without running it.
- `src/schemas.ts` holds what several slices, or a slice and the SPA, share, as literal consts only. A slice declares
  its own schemas in its `endpoints.ts` (`Task`, `NewTask` in `SKILL.md`), and may declare other consts there too.
- `z.iso.datetime()` takes UTC (`…Z`) only; `z.iso.date()` is `YYYY-MM-DD`.
- Optional or nullable: on a create, a field the caller may leave out is `.optional()`, never a required
  `z.nullable(…)`, and the handler writes `?? null` (`NewTask.dueOn`). On an edit, a field the caller must send is required (`EditTask.title`), one the caller may
  clear is `z.nullable(…)` (`EditTask.dueOn`), and a patch that sends only what changed takes `.optional()` fields: an
  update that sets no column writes nothing and answers the row's current `{ id, version }`. The generated cases send
  no optional field and `null` for a nullable one (`references/tests.md`).
- A query that needs no input declares none: `r.query({ output, access })`, and the SPA calls it with no argument,
  `api.members.orgs()`.

## The access forms and their handles

| Access                                         | Use it for                        | `ctx.db` (query)                                            | adds in a mutation                                                                          |
| ---------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{ action, on: 'task', from: 'id' }`           | one object by id; 404 otherwise   | `target.get()`; a child table's `list`, `get`               | `getForUpdate()`, `update(v, { expectVersion })`, `remove({ expectVersion })`; child writes |
| `{ action, in: 'project', from: 'projectId' }` | a container; 403 when not held    | `target.get()` (the container's row); `target.<table>.list` | `target.<table>.insert(v)`                                                                  |
| `{ action, over: 'org' }`                      | a list across the caller's scopes | `within.<table>.list`, `.count`, `.aggregate`               | — (a list write: `sql` or `unscoped`)                                                       |
| `{ action, creates: 'org' }`                   | a new top-level scope from IAM    | —                                                           | `created.<table>.insert(v)`                                                                 |
| `{ action, app: true }`                        | data of the whole application     | `app.<table>.list`, `.get(id)`; every row of a scoped table | `app.<table>.insert(v)`, `.update(id, v, …)`, `.remove(id, …)` of an application table      |
| `{ member: true }`                             | any member, no application data   | nothing                                                     | nothing                                                                                     |

- Every endpoint also has `ctx.db.reference.<table>` (reference tables), `ctx.principal`
  (`{ kind: 'user', id, label, email }` for a `human` caller) and `ctx.requestId`.
- `ctx.principal.email` is the mailbox IAM recorded for the person, lower-cased, from the token: the address to mail,
  not a proof that the person controls it. Mail "send it to me"
  there and take no recipient from the input (`references/public-intake.md`). A `machine` caller
  (`{ kind: 'service', id, label }`) has no address. `label` is for display: the address as the person spelled it.
- `ctx.principal.label` is a `string`, never `null`: the label IAM holds for the person (the one its directory
  shows), or the id when the token carries none. When the caller owns what it writes (the creator of a deal, the
  assignee of a task nobody was picked for), store `ctx.principal.id` and `ctx.principal.label`, never a
  `ctx.members.get(ctx.principal.id)` lookup: it adds a directory read the approver sees. A picked person is
  `ctx.members.get` (Members below).
- `ctx.target` is the capability (a `Ref`); its id is `ctx.target.value`. `ctx.within` is the `over` capability.
- Two writes with the same `expectVersion` (two tabs, a double click) give one 200 and one 409, also when they arrive
  together: the second one finds the version moved.
- A delete is the exception: of two deletes of one row with the same `expectVersion`, the second finds the row gone and
  answers 404, not 409. So does any write that loses to a delete. A test of the race expects `[200, 404]`.
- A capability reads its own target, whatever its action: `tasks.assign` reads the task it assigns. A column with
  its own read action is left out for every other action.
- Never use `{ member: true }` for application data. `callers` is `['human']`, `['machine']` or both; every group of
  one mount names the same callers.

### Data of the whole application: `app: true`

A code list an administrator edits, operational counts, the log of an export of every record: data that belongs to no
dimension value takes `access: { action, app: true }`.

- The proxy admits it only for a caller who holds the action as a global grant (a role granted without a scope); a
  grant in any one scope is 403. So declare it only where every caller is application-wide; a list a scoped member
  also uses stays `over`.
- `ctx.db.app` holds every application table (`scope: { app: '<why>' }`, `references/table-and-migration.md`), with
  each operation's own action, and every scoped table whose read action is the endpoint's action: `list`, `count` and
  `aggregate` over all its rows, as `over` reads them for a global holder. `ctx.app` is the capability.
- An audited export of every record is one `app` mutation: it lists the records through `ctx.db.app.<table>` and
  inserts its log row into an application table whose insert action is the export's action
  (`references/public-intake.md`). It needs no `sql` and no `unscoped`.
- An `app` endpoint has no `ctx.target`, `ctx.within`, `ctx.members` or `ctx.links`. A link procedure and an export
  keep their own forms.
- The approver sees it as "app-wide: a global grant", and a change of an endpoint to or from `app: true` widens.

### The methods of each handle

| Handle                                                 | Methods                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target` (the object of `on`, the container of `in`)   | `get()`; under `on`, in a mutation, `getForUpdate()`, `update(values, { expectVersion })`, `remove({ expectVersion })`                                                                          |
| `target.<child table>` (`on`)                          | `list(options)`, `get(id)`; in a mutation `insert(values)`, `update(id, values, { expectVersion })`, `remove(id, { expectVersion })`; no `getForUpdate`                                         |
| `target.<table>` (`in`), `created.<table>` (`creates`) | `list(options)` of a contained table; in a mutation `insert(values)`                                                                                                                            |
| `within.<table>` (`over`)                              | `list(options)`, `count({ where })`, `aggregate(spec)`                                                                                                                                          |
| `reference.<table>`                                    | `list(options)`, `count({ where })`: no `get`; look a row up by its key with `where` (`priorities.get` below)                                                                                   |
| `app.<table>` (`app: true`), an application table      | `list(options)`, `count({ where })`, `aggregate(spec)`, `get(id)`; in a mutation `getForUpdate(id)`, `insert(values)`, `update(id, values, { expectVersion })`, `remove(id, { expectVersion })` |
| `app.<table>` (`app: true`), a scoped table            | `list(options)`, `count({ where })`, `aggregate(spec)`                                                                                                                                          |
| `unscoped.<table>` (declared)                          | `list`, `count`, `aggregate`, `get(id)` (not of a reference table or an inbox, which have no key); with `'write'` also `insert`, `update`, `remove`                                             |

`{ expectVersion }` is taken only on a table with `version`.

### Which dimension `over` names

`over` names the nearest dimension of the listed rows' chain: the dimension the table's rows lie in (tasks lie in a
project: `over: 'project'`; projects lie in an org: `over: 'org'`), a child table's parent (`task_comments`:
`over: 'task'`), or a top-level table's own dimension. The caller's grants on that dimension and on every dimension
containing it count; a grant held only below it does not.

- A farther dimension reaches fewer rows: `over: 'org'` on tasks ignores a grant held on one project, which answers
  403. With roles granted only in the org, both list the same rows today, so the difference shows only later.
- The dimension is part of the endpoint's requirement, and the approver's diff shows any change of a requirement as a
  widening. Choose it by this rule when you write the endpoint; do not change it to pass a test.
- `ctx.db.within` reaches every table whose chain holds the dimension, so `over: 'org'` also types tasks two levels
  down. The rule still names `project` for a list of tasks.

### The caller's scopes: `ctx.within.values`

`ctx.within.values` is the list of values of the `over` dimension in which the caller holds the action, or `'all'`
for a global grant (an operator's or an auditor's role granted without a scope), which cannot be listed.
`ctx.within.containers` holds the grants on dimensions above it. `orgs` below answers "the orgs I work in", for a
picker of the org a new project goes into; an `'all'` caller types the org instead.

## Lists

- `list({ where, orderBy, limit, after })` answers `{ items, next }`: a keyset page of at most `limit` rows (50 by
  default, 500 at most). Pass `next` back as `after`; it is `null` on the last page.
- `where` is AND of `[column, operator, value]`: `=`, `<>`, `<`, `<=`, `>`, `>=`, `in` and `not in` (a list),
  `like`, `ilike`, `not like`, `not ilike`, `contains`. Optional filters are conditional spreads, each tuple
  `as const` (`list` in `SKILL.md`): `...(input.status === undefined ? [] : [['status', '=', input.status] as const])`.
  There is no `is null` and no OR: write that in `ctx.sql`.
- `orderBy` is `[[column, 'asc' | 'desc']]`; the key is added last as the tiebreak.
- `count({ where })` answers a number. `aggregate({ groupBy, count, sum, min, max })` takes lists of column names
  and answers one row per group: the `groupBy` columns, `count` as a string (Postgres `bigint`), and `sum_<column>`,
  `min_<column>`, `max_<column>` per listed column. Over a `deals` table, `{ groupBy: ['stage'], count: true, sum:
  ['value'] }` answers `{ stage, count, sum_value }` per stage.
  `sum_<column>` is typed `string | number | null` for every column: at runtime text for an integer or `numeric`
  column, a number for a floating-point one. It is `null` when no row of the group has a value: over no rows (no
  `groupBy`), or a nullable column that is null in every row of the group. `min_`/`max_` are `null` the same way. A
  caller whose capability reaches no value gets no row at all (`[]`).
- Convert a sum with a checked conversion, never a bare `Number(…)`: past 2^53 − 1 a number rounds silently.
  `exactInteger` in `logic.ts` below takes what the type gives without `null` and refuses instead; a missing sum is
  a total of zero (`exactInteger(row.sum_value ?? 0)`). A count is far from that limit, so `Number(…)` is fine
  there. Or keep the sum a string in the output (`z.string().regex(/^-?[0-9]+$/)`).

## Business rules: `logic.ts`

```ts src/tasks/logic.ts
export const canClose = (status: 'open' | 'doing' | 'done'): boolean =>
	status === 'doing'

/** An aggregate's sum, text or a number; one past 2^53 - 1 is refused, never rounded. */
export const exactInteger = (sum: string | number): number => {
	const value = Number(sum)
	if (!Number.isSafeInteger(value)) {
		throw new RangeError('the total is beyond the safe integer range')
	}
	return value
}
```

`logic.ts` takes and answers plain values: no `ctx`, no handle, no row it was not given. Test it without a database.

## A slice of its own

```ts src/projects/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Cursor, Saved } from '../schemas'

const Project = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	version: z.int(),
})
const ProjectPage = z.strictObject({
	items: z.array(Project),
	next: z.nullable(z.string()),
})
const ByOrg = z.strictObject({
	orgId: z.string().min(1).max(100),
	after: Cursor.optional(),
})
const NewProject = z.strictObject({
	orgId: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
})

export const projects = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ByOrg,
		output: ProjectPage,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Project,
				await ctx.db.target.projects.list({
					orderBy: [['name', 'asc']],
					after: input.after,
				}),
			)
		),
	create: r.mutation({
		input: NewProject,
		output: Saved,
		access: { action: 'tasks.write', in: 'org', from: 'orgId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.projects.insert({ name: input.name })
		),
}))
```

A child table is reached through its parent's `on` endpoint. A table without `version` answers `{ id }`:

```ts src/comments/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Cursor } from '../schemas'

const Comment = z.strictObject({
	id: z.uuid(),
	body: z.string(),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const CommentPage = z.strictObject({
	items: z.array(Comment),
	next: z.nullable(z.string()),
})
const ByTask = z.strictObject({ taskId: z.uuid(), after: Cursor.optional() })
const NewComment = z.strictObject({
	taskId: z.uuid(),
	body: z.string().min(1).max(2000),
})
const Added = z.strictObject({ id: z.uuid() })

export const comments = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ByTask,
		output: CommentPage,
		access: { action: 'tasks.read', on: 'task', from: 'taskId' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Comment,
				await ctx.db.target.task_comments.list({
					orderBy: [['created_at', 'asc']],
					after: input.after,
				}),
			)
		),
	add: r.mutation({
		input: NewComment,
		output: Added,
		access: { action: 'tasks.write', on: 'task', from: 'taskId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.task_comments.insert({ body: input.body })
		),
}))
```

A reference table belongs to no scope, so a `{ member: true }` endpoint reads it. It has no `get`: look a row up by its
key with a `where`:

```ts src/priorities/endpoints.ts
import { fromPage, fromRow, NotFoundError } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Priority = z.strictObject({ code: z.string(), label: z.string() })
const PriorityPage = z.strictObject({
	items: z.array(Priority),
	next: z.nullable(z.string()),
})
const ByCode = z.strictObject({ code: z.string().min(1).max(20) })

export const priorities = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: PriorityPage, access: { member: true } })
		.handle(async ({ ctx }) =>
			fromPage(
				Priority,
				await ctx.db.reference.priorities.list({ orderBy: [['rank', 'asc']] }),
			)
		),
	get: r.query({ input: ByCode, output: Priority, access: { member: true } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.reference.priorities.list({
				where: [['code', '=', input.code]],
				limit: 1,
			})
			const row = page.items[0]
			if (row === undefined) throw new NotFoundError('no such priority')
			return fromRow(Priority, row)
		}),
}))
```

Mount every group in `fabrika.contract.ts`:
`api: c.rpc('/api', { projects, tasks, comments, reports, members, priorities })`. A procedure is served at
`POST /api/<group>.<endpoint>`, and answers `{ result: <output> }` (`references/errors.md`).

## Rows and outputs

- `fromRow(Schema, row)` turns snake_case columns into the schema's camelCase fields, a `Date` into ISO text, drops a
  column the schema does not declare, and parses the rest. `fromPage(Schema, page)` does it for every row of a
  `list` answer and keeps its `next`: the whole handler of a list is `fromPage(Item, await ….list({ … }))`.
- `RowOf<typeof tables, '<table>'>` (`@fabrika/db/tables`) is the row a table's read action reads, for a function that
  takes one: `const toTask = (row: RowOf<typeof tables, 'tasks'>) => fromRow(Task, row)`.

## Shared data access: `queries.ts`

A function of the slice's `queries.ts` takes the handle as a parameter typed with `DbHandle` and returns plain values.
It decides no authorization: the capability already bounds the handle.

```ts src/reports/queries.ts
import type { DbHandle } from '@fabrika/app/contract'
import type { app } from '../app-kit'

export const statusCounts = async (
	within: DbHandle<typeof app, 'over', 'project', 'tasks.read'>,
) => {
	const rows = await within.tasks.aggregate({ groupBy: ['status'], count: true })
	const count = (status: 'open' | 'doing' | 'done') =>
		Number(rows.find((row) => row.status === status)?.count ?? 0)
	return { open: count('open'), doing: count('doing'), done: count('done') }
}
```

`DbHandle<typeof app, 'on' | 'in', '<dimension>', '<action>', 'mutation'>` is `ctx.db.target` of that form;
`DbHandle<typeof app, 'over', …>` is `ctx.db.within`.

## Raw SQL: `sql: 'read'`

Raw SQL is legitimate for a join, a report, an `OR` or `IS NULL` filter, or a bulk write. Declare it on the endpoint;
`ctx.sql` exists only there.

```ts src/reports/endpoints.ts
import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { TaskStatus } from '../schemas'
import { statusCounts } from './queries'

const Workload = z.strictObject({
	orgId: z.string().min(1).max(100),
	status: TaskStatus.optional(),
})
const ByProject = z.strictObject({ projectId: z.uuid() })
const WorkloadRow = z.strictObject({
	assignee: z.nullable(z.string()),
	open: z.int(),
	overdue: z.int(),
})
const WorkloadReport = z.strictObject({ rows: z.array(WorkloadRow) })
const Counts = z.strictObject({ open: z.int(), doing: z.int(), done: z.int() })
const TaskExportRow = z.strictObject({
	title: z.string(),
	status: TaskStatus,
	assignee: z.nullable(z.string()),
	dueOn: z.nullable(z.string()),
})
const TaskExport = attachment({
	format: 'csv',
	filename: 'tasks.csv',
	row: TaskExportRow,
	maxBytes: 5_000_000,
})

export const reports = app.group({ callers: ['human'] }, (r) => ({
	workload: r.query({
		input: Workload,
		output: WorkloadReport,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
		sql: 'read',
	})
		.handle(async ({ input, ctx }) => {
			const status = input.status ?? null
			const rows = await ctx.sql(WorkloadRow)`
				select t.assignee,
					count(*) filter (where t.status <> 'done')::int as open,
					count(*) filter (where t.status <> 'done' and t.due_on < current_date)::int as overdue
				from tasks t
				where ${ctx.sql.scope(ctx.target, 'tasks', 't')}
					and (${status}::text is null or t.status::text = ${status})
				group by t.assignee
				order by t.assignee`
			return { rows }
		}),
	counts: r.query({
		output: Counts,
		access: { action: 'tasks.read', over: 'project' },
	})
		.handle(({ ctx }) => statusCounts(ctx.db.within)),
	exportProject: r.mutation({
		input: ByProject,
		output: TaskExport,
		access: { action: 'tasks.read', in: 'project', from: 'projectId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const rows = await ctx.sql(TaskExportRow)`
				select t.title, t.status, t.assignee, t.due_on::text as due_on
				from tasks t
				where ${ctx.sql.scope(ctx.target, 'tasks', 't')}
				order by t.title
				limit 10000`
			await ctx.db.target.project_exports.insert({ row_count: rows.length })
			return rows
		}),
}))
```

- Every `${…}` of a value is a bound parameter, never SQL text. The one exception is `${ctx.sql.scope(…)}`: it is SQL
  (the predicate) around its own bound values, and it may have no value at all (`(true)`, `(false)`). Put no
  interpolation inside quotes, a quoted name, a dollar body or a comment: the tag refuses it.
- **Scope every scoped table the statement reads with `${ctx.sql.scope(capability, '<table>', '<alias>')}`.**
  `ctx.sql` has no scope predicate of its own. The fragment is the capability's whole predicate on that table: for a
  `Ref` the object's column and every link of its chain, so a project moved to another org is out; for a `Within` its
  values, each container grant on its own column, every row for a global grant and none for an empty one. The
  capability is the access form's: `ctx.target` for `on` and `in`, `ctx.within` for `over`; a job passes the `Ref` or
  `Within` it minted to `tx.sql.scope`. A table the capability does not reach is refused. A reference table is shared
  by every scope and needs no fragment. A form's inbox needs none either; read it from a site that holds the inbox's
  `read` action (the intake job of `references/public-intake.md`).
- **A fragment is a conjunct.** It stands alone, joined by AND, at the top level of a WHERE or JOIN … ON clause whose
  top level holds no OR: `where (<the whole filter>) and ${…}`, `join projects p on p.id = t.project_id and ${…}`.
  The tag refuses `where a or ${…}`, `where a or b and ${…}`, `not ${…}`, a fragment in parentheses or outside such a
  clause. Never scope by hand with `ctx.target.value` alone: it drops the chain. The generated tests check that an `in`
  endpoint with `sql` leaks nothing of another scope.
- Rows are parsed like `fromRow` (snake_case to camelCase), then by the schema. Postgres sends `bigint` and `numeric`
  as text: cast a count (`count(*)::int`), and a sum to the type its output declares (`::int` for an integer sum that
  fits, `::float8` for a fractional one), or keep it a string. A sum over no rows is `null`: `coalesce(sum(…), 0)`.
- An optional filter is `(${value}::text is null or <column> = ${value})`.
- One statement: `select`, `with`, `values`, plus `insert`, `update` and `delete` on a `'write'` site (a mutation, a
  job or a webhook). Refused before anything is sent: DDL, `SET`, `COPY`, transaction control, another schema, any
  `fabrika_*` or `pg_*` name, and calls outside the reviewed built-ins. A function your migrations declare is refused
  too: call it from a view. These name rules are defense in depth; the runtime role (DML only) is the boundary.
- A query runs in a read-only transaction; a mutation's `ctx.sql` runs in the same transaction as its handles.

## A file download: `attachment`

`output: attachment({ format: 'csv', filename, row, maxBytes, maxRows? })` (`@fabrika/app/contract`) makes the endpoint
answer a file: the handler returns the rows (an array of `row`), and the framework writes the CSV. `exportProject`
above is one.

- `row` is a `z.strictObject` of scalar fields (string, number, boolean, enum, literal; nullable or optional); its
  field names are the header line, in their order. `filename` is fixed (`[A-Za-z0-9._-]`, ending in `.csv`).
- The framework writes RFC 4180 CSV in UTF-8 with a byte order mark, and puts `'` before every text cell a spreadsheet
  would run as a formula (one that starts with `=`, `+`, `-`, `@`, a tab or a line break, also after spaces). Never
  write CSV by hand.
- `maxBytes` (at most 16 MiB) and `maxRows` (10 000 unless declared, at most 100 000) bound the file; a cell holds at
  most 32 767 characters. Past a limit the call fails with a 500 and sends no file. Bound the rows in the query too.
- **An audited export is a mutation** that writes its log row through `ctx.db` and returns the rows: `exportProject`
  inserts a `project_exports` row (who, when, how many rows) in the invocation's one transaction. The file is encoded
  before the transaction commits, so a file over its limit keeps no log row, and no file leaves without its row. The
  log table lies in the scope the export reads (a child of `projects`), so the export's own capability writes it. An
  export of every record is an `app` mutation that writes an application table instead (`app: true` above).
- A mutation may declare `sql: 'read'`: its statements only read, and its handles still write.
- The SPA calls `download(api.reports.exportProject, { projectId })` from `@fabrika/app/client`: it saves the file and
  answers it as a `File`. `api.reports.exportProject` is not a function. A refusal is an `RpcError`.
- An export (`app.export`) answers JSON only; an `attachment()` is for an RPC or a link procedure.

## Rows outside the capability: `unscoped`

`unscoped: { tasks: 'read' }` gives `ctx.db.unscoped.tasks` with no scope predicate (every org), still guarded and in
the invocation's transaction. `'write'` (a mutation, a job, a webhook) also inserts, updates and removes; an insert
then names the chain columns itself. Use it for an operator's cross-scope view, never to dodge a capability the caller
should hold. The generated tests skip the other-scope leak case for such an endpoint.

## Members

`ctx.members` of an endpoint `on` or `in` a dimension reads the members of the nearest dimension, its own or one
containing it, that declares `members`: a task endpoint reads its org's. A dimension with no such container has none.

- Every such endpoint: `ctx.members.get(principalId)` answers `{ principalId, label, disabled }` when that principal
  is a member of the value the object lies in, and `null` otherwise (another org's member, an unknown id). IAM checks
  the endpoint's own action on the org itself, so `tasks.assign` validates the person it assigns without a second
  action; a caller who holds the action only on a project is refused (403). Use it for every picked person: store
  `member.principalId` and `member.label`, never a label from the input.
- `disabled` is a person an operator disabled in IAM: still a member, but unable to sign in. Refuse to assign one
  (`assign` in `SKILL.md`), and leave them out of a picker.
- The approver sees each endpoint that reads a directory ("looks up one member of `org`"): a new one widens.
- With the directory's `members.list` action (`tasks.read` here) also `ctx.members.list()`, answering
  `{ principalId, label, roles, disabled }` per member, for an assignee picker. IAM checks that action on the org
  itself too.
- `label` is `null` unless the caller also holds `members.manage` there, or the dimension opts in with
  `directory: 'labels'`, which widens like any other access change: then every endpoint below it reads labels too.
- Under `directory: 'labels'` IAM answers every member's label, so `label` is a `string` in `get` and `list()` of every
  endpoint below it (an IAM answer without one is a 500). Elsewhere it is `string | null`: store it in a nullable column
  or output, never with `!` or a cast.
- With the dimension's own `members.manage` action: `list(ref)`, `assign(ref, { email } | { principalId }, role)` and
  `revoke(ref, …)`, one change per request.
- A partner company's people: a role with `external: true` whose `assignableBy` names an app-wide staff role.
  `assign(ref, { email }, 'partner', { label: company.name, message })` mails the invitation with the company's name
  (≤ 200 characters, one line) and a note (≤ 1000 characters); a new address chooses its password from the mail and
  lands in the application. `{ resend: true }` sends an open invitation again with a new link and 7 days;
  `revoke(ref, { invitationId })` cancels one; `revoke(ref, { principalId })` removes a person, whose access ends
  within the 300 s token lifetime. An address the organization names is refused (409 `internal_mailbox`). A company's
  deactivation is the application's own flag: check it where the endpoint loads the company row.
- Name a picked person's field by its role (`assignee`, `newOwner`), not `ownerId` or `userId`: the checker reads
  those as the caller's own identity (`client-identity`).

```ts src/members/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { OrgInput } from '../schemas'

const Member = z.strictObject({
	principalId: z.string(),
	label: z.nullable(z.string()),
})
const Members = z.strictObject({ items: z.array(Member) })
const MyOrgs = z.strictObject({ all: z.boolean(), orgs: z.array(z.string()) })
const Invite = z.strictObject({
	orgId: z.string().min(1).max(100),
	email: z.email(),
	role: z.enum(['owner', 'member']),
})
const Invited = z.strictObject({ invitationId: z.string() })
const Remove = z.strictObject({
	orgId: z.string().min(1).max(100),
	principalId: z.string(),
})
const Removed = z.strictObject({ ok: z.boolean() })

export const members = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: OrgInput,
		output: Members,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
	})
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list())
				.filter((member) => !member.disabled)
				.map((member) => ({
					principalId: member.principalId,
					label: member.label,
				})),
		})),
	orgs: r.query({
		output: MyOrgs,
		access: { action: 'tasks.read', over: 'org' },
	})
		.handle(({ ctx }) =>
			ctx.within.values === 'all'
				? { all: true, orgs: [] }
				: { all: false, orgs: [...ctx.within.values].sort() }
		),
	invite: r.mutation({
		input: Invite,
		output: Invited,
		access: { action: 'members.manage', in: 'org', from: 'orgId' },
	})
		.handle(async ({ input, ctx }) => {
			const result = await ctx.members.assign(
				ctx.target,
				{ email: input.email },
				input.role,
			)
			return {
				invitationId: 'invited' in result
					? result.invited.invitationId
					: result.assigned.principalId,
			}
		}),
	remove: r.mutation({
		input: Remove,
		output: Removed,
		access: { action: 'members.manage', in: 'org', from: 'orgId' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.members.revoke(ctx.target, { principalId: input.principalId })
			return { ok: true }
		}),
}))
```

IAM answers the directory. A lookup only reads, so it may come before the write that needs its answer (`assign` in
`SKILL.md`); do every other data work first.

---

# references/errors.md — what the checker, the compiler and the runtime tell you

## The checker: refusals and hints

`bunx fabrika-check .` prints one finding per line, `<file>:<line>:<col> <rule> <what> (allowed form: <fix>)`.
Refusals come first and fail the check; hints follow under their own heading and do not. Fix both: a hint is the
architecture, and a refusal's allowed form is the one fix that passes. There is no suppression syntax.

The refusals agents meet most, and their fix:

| Rule                  | Means                                                                                                                                                            | Fix                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `literal`             | the shell (contract, vocabulary, tables, groups, schemas) holds a computed value or call                                                                         | literal objects, `z.*` calls and imported literal consts; move logic into `.handle(…)` |
| `contract`            | the contract does not compile (a reserved role, an unknown action, a wrong field)                                                                                | the message names the field                                                            |
| `package-replacement` | `package.json` names the app under `@fabrika/*`, or a dependency is `workspace:*`                                                                                | another name; a registry range such as `^0.0.4`                                        |
| `generated-test-hash` | a generated test is missing, edited or stale                                                                                                                     | `bunx fabrika db test-scaffold`, and commit what it writes                             |
| `endpoint-fixture`    | an endpoint's input cannot be sampled, a fixture or seed names no endpoint, or a member, invitation or link field no endpoint that reads, cancels or revokes one | a literal in `src/__tests__/endpoint-access.fixtures.ts` (`references/tests.md`)       |
| `raw-sql`             | a driver's `sql` (imported from `bun`, Kysely, `postgres`)                                                                                                       | the handles, or `sql: 'read'` and `ctx.sql`                                            |
| `forbidden-import`    | a driver, an S3 client, `jose`, `node:http`, `child_process`                                                                                                     | the handles, a file collection, a connector                                            |
| `forbidden-global`    | `Bun.sql`, `Bun.serve`, `Bun.spawn`; `globalThis`, `window`, `self`, `global` or `Bun` in a server module                                                        | the handles; state lives in a table, not in a global; `crypto.randomUUID()` for an id  |
| `env-read`            | `process.env`, `Bun.env`                                                                                                                                         | `defineDeps(build)`, which receives the application's variables                        |
| `client-identity`     | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId`                                                                                       | the access form's `from`, `ctx.principal.id`, or `createdBy` in the policy             |
| `type-assertion`      | `as T` (other than `as const`), `<T>x`                                                                                                                           | fix the type; `fromRow` parses a row into a schema's type                              |
| `sensitive-log`       | a log of an error object, a request, headers or the environment                                                                                                  | log a short fixed message                                                              |
| `migration-name`      | a migration not named `YYYYMMDDHHMMSS_slug.sql` (UTC)                                                                                                            | `bunx fabrika db new <slug>`                                                           |
| `test-only-import`    | `@fabrika/app/testing` or `@fabrika/db/testing` outside a test file                                                                                              | import them only from `*.test.ts` or `__tests__/`                                      |
| `spa-server-import`   | the SPA loads a server module                                                                                                                                    | the SPA imports `@fabrika/app/client`, the contract and `src/schemas.ts` only          |
| `skipped-test`        | `.skip`, `.only`, `.todo`                                                                                                                                        | run the test                                                                           |

The hints:

| Hint                   | Means                                                         | Fix                                                         |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `handler-location`     | a `.handle(…)` outside a slice's `endpoints.ts`               | move the endpoint into `src/<slice>/endpoints.ts`           |
| `data-access-location` | `ctx.db` or `ctx.sql` outside `endpoints.ts` and `queries.ts` | pass the handle into a function of the slice's `queries.ts` |
| `logic-data-access`    | `logic.ts` reaches data                                       | keep `logic.ts` pure; pass it plain values                  |
| `cross-slice-queries`  | a slice loads another slice's `queries.ts`                    | move the function, or call that slice's endpoint            |
| `sql-undeclared`       | `ctx.sql` in a handler whose endpoint declares no `sql`       | add `sql: 'read'` (or `'write'`) to that endpoint           |

The first run may report only the contract's refusals: the generated-test findings appear once the contract compiles.

## Type errors

A kit error lands on the line of the mistake, in one or two lines that name the fix. Read the last line first.

| The compiler says                                                               | Fix                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `add .handle(…) to tasks.get: every endpoint takes its handler beside it`       | add the handler; when the handler exists, fix the error inside it first |
| `the handler returns version, which the output does not declare`                | return only the output's fields                                         |
| `… where the output is camelCase: map it with fromRow(Schema, row)`             | `fromRow(Schema, row)`                                                  |
| `update on tasks needs the action 'tasks.write', and this endpoint holds '…'`   | the endpoint's action, a column write action, or a separate endpoint    |
| `getForUpdate locks the row, so it runs only in a mutation`                     | `r.mutation`                                                            |
| `update acts on one object: declare access with on`                             | access `on`, not `in` or `over`                                         |
| `tasks is not under in: 'org' (it lies in project): declare …`                  | the access form the message names                                       |
| `ctx.sql needs a declaration: add sql: 'read' …`                                | declare `sql` on the endpoint                                           |
| `tasks is outside this site's scope: declare unscoped: { tasks: 'read' } on it` | declare it, or use the capability's handles                             |
| `a job writes inside ctx.transaction((tx) => …): use tx.db there`               | move the write into the transaction                                     |
| `listing the members of org needs the action '…'; get(principalId) checks one`  | `ctx.members.get(id)`, or an endpoint of the directory's `members.list` |
| `neither task nor a dimension containing it declares members`                   | declare `members` on the dimension whose people the endpoint picks      |
| `'member.label' is possibly 'null'`                                             | a nullable column or output; only `directory: 'labels'` makes it text   |
| `admin is a role IAM defines itself for every application (reserved: admin)`    | another role name                                                       |
| `Property 'id' does not exist on type 'Ref<…>'`                                 | `ctx.target.value`                                                      |
| `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`         | the column has its own read action, which this capability lacks         |
| `Type 'Date' is not assignable to type 'string'` on a `date` column             | a `YYYY-MM-DD` string                                                   |
| `Cannot find module '@fabrika/…'` and implicit `any`s everywhere                | `bun install` (at the repository root in a monorepo)                    |

## Runtime answers

A procedure, a form, a webhook and a file collection answer JSON in an envelope: a 200 is `{ result: <output> }` (a
procedure's output, a form's `{ received: true }`, a file list's `{ items, next }`), any other status
`{ error: { type, message } }`. The typed client unwraps it; a plain `fetch` (a form, a test) reads `result`. A health
check (`{ status: 'ok' }`) and the SPA's browser configuration answer without one.

| Answer | Comes from                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | the input does not match its schema; `BadRequestError`                                                                                                                                                                                   |
| 401    | no valid credential. In a test, the caller is missing                                                                                                                                                                                    |
| 403    | the caller lacks the action, or for `in` the scope: a missing grant, never a bug to code around; `ctx.members.list()` below the org for a caller without the list action on the org itself; a path no endpoint declares                  |
| 404    | `on`: the object does not exist or is not the caller's, also when a concurrent delete removed it first; `NotFoundError`                                                                                                                  |
| 409    | a stale `expectVersion`; `ConflictError`; a lost `getForUpdate` race                                                                                                                                                                     |
| 500    | a throw without a numeric `httpStatus` below 500, a `type` and a `message`, a refused statement, a call of `ctx.sql` the endpoint does not declare (`undeclared_reach`), a `ctx.sql` row the schema refuses (`count(*)` without `::int`) |
| 503    | IAM cannot be asked, or the member directory has no transport                                                                                                                                                                            |

An undeclared path is 403 at the proxy, also for a signed-in caller who holds every action: the proxy serves only the
contract's endpoints, picks the most specific one, and never falls through to a broader one. A test that asks for a
route you did not declare (an edit that does not exist) expects 403, not 404. An unknown procedure that reaches the
application under an RPC prefix is 404, but the proxy stops it first.

A connector call is not an HTTP answer: it resolves to an outcome (`references/webhooks-links-connectors.md`), and the
handler decides what to answer. Any thrown value with a numeric `httpStatus` below 500, a `type` and a `message` (an
`HttpError` of `@fabrika/app`, such as `ForbiddenError`, or a plain object of those fields) answers its own status
with its message; throw the three business errors for the application's own refusals.

A 500 answers a fixed message; the server log has one line, `fabrika: <endpoint>: <code>: <reason>: <text>`, with a
fixed failure code and, for a framework refusal, its reason and the reason's fixed text (`sql_read_only`,
`undeclared_reach`, `unknown_column` …), never a value or your error's message. With an Operations DSN the same 500
is a `RequestFailed` issue in Operations. A `DatabaseError` carries
only the SQLSTATE: `23505` is a unique violation, `23503` a foreign key, `23502` a null in a `NOT NULL` column.

---

# references/files.md — file collections

A file collection attaches uploaded files to the rows of one table that owns a dimension. It is a section of the
contract with generated endpoints: no handler, no storage client, no URL of your own.

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { priorities } from './src/priorities/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
	}),
	files: {
		attachments: c.files({
			owner: 'tasks',
			read: 'tasks.read',
			write: 'tasks.write',
			delete: 'tasks.write',
			maxBytes: 5242880,
			types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
			maxPerOwner: 20,
		}),
	},
	health: c.health('/healthz'),
}))
```

The collection serves, for signed-in people only:

| Endpoint                                     | Access                      | Does                                                                    |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `POST /api/files.attachments.upload/:taskId` | `write` on the task         | the body is the file, `?name=` its name; answers `{ result: { id } }`   |
| `GET /api/files.attachments/:fileId`         | `read` on the file's task   | streams the file                                                        |
| `POST /api/files.attachments.list`           | `read` on the task          | body `{ owner, limit?, after? }`; answers `{ result: { items, next } }` |
| `POST /api/files.attachments.remove`         | `delete` on the file's task | body `{ id }`                                                           |

A file reaches what its task reaches, now: a moved task moves its files. The list answers the task's files oldest
first, each `{ id, name, type, size, status, createdAt }`, at most `limit` (1–100, default 50) after the id `after`.

## Malware scan

`scan: true` on a collection holds every upload `quarantined` until ClamAV answers clean; on Zerops the platform
installs ClamAV and runs the scan job. The download answers 409 `quarantined` until then and 404 once the file is
`rejected`; the list shows each file's `status`, so show it rather than a broken link. In a test, the scan runs with
`kit.runJob(FILE_SCAN_JOB)` and a `scanner` passed to `testKit` (`references/tests.md`); the generated tests pass their
own seeded files.

- A scanning collection admits at most 100 MiB per file (`maxBytes`) and not `application/gzip`; an empty upload is
  400 `empty`.
- A ZIP or Office document must start with the ZIP header. Any other file that holds a ZIP signature anywhere is
  rejected, even a rare harmless PDF or image; that is the fail-closed cost.
- A table written by the `fileTableSql` below can already hold the scan states: turning `scan` on needs no migration.
  Only a table created by an earlier two-state `fileTableSql` (its check names `'pending', 'live'` alone) needs
  `fileScanSql('<name>')` of `@fabrika/db` in a new migration, and `fabrika-check` names it. On a current table that
  migration fails: it adds the constraint, columns and index again.
- ClamAV holds about 1 GB of signatures in memory. On Zerops the deploy service must declare
  `verticalAutoscaling: { minRam: 2 }` (GB), or the build refuses the application. Zerops ignores a changed `verticalAutoscaling` of an existing service on a re-import:
  raise an existing service's RAM through Zerops itself.

```text
// the deploy service in the services of fabrika.config.ts
{
	hostname: 'tasksapi',
	type: 'alpine/bun@1.3',
	priority: 10,
	enableSubdomainAccess: false,
	minContainers: 1,
	maxContainers: 2,
	verticalAutoscaling: { minRam: 2 },
}
```

## Its table

Each collection has a table `fabrika_files_<name>`, created by an application migration. Write exactly the DDL that
`fileTableSql` of `@fabrika/db` returns. `key` and each `chain` entry are `{ column, type }`, with `type` `'uuid'` or
`'text'` as the owner table declares the column, the nearest container first:

```bash
bun -e "import { fileTableSql } from '@fabrika/db'; console.log(fileTableSql('attachments', { table: 'tasks', key: { column: 'id', type: 'uuid' }, chain: [{ column: 'project_id', type: 'uuid' }, { column: 'org_id', type: 'text' }] }))"
```

```sql db/migrations/20261012100000_attachments.sql
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	project_id UUID,
	org_id TEXT,
	status TEXT NOT NULL CONSTRAINT fabrika_files_attachments_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TIMESTAMPTZ,
	FOREIGN KEY (owner_id, project_id, org_id) REFERENCES tasks (id, project_id, org_id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
CREATE INDEX fabrika_files_attachments_scan ON fabrika_files_attachments (scan_after) WHERE status = 'quarantined';
```

- The owner table needs `UNIQUE (<key>, <chain columns>)`; `tasks` has `UNIQUE (id, project_id, org_id)`.
- Codegen leaves the table out, and no policy names it: only the framework reads it.
- The name is lowercase snake_case, at most 39 characters.
- `link: true` serves a link mount's holders, for the mount's own object: `POST <prefix>/api/files.<name>.upload`,
  `POST <prefix>/api/files.<name>.list` (no `owner`) and `GET <prefix>/api/files.<name>/:fileId` under every link mount bound to the owner's dimension, which must grant the
  collection's `write` and `read`. The owner is the link's object, never a parameter.

## Storage

On Zerops, declare one `object-storage` service in `fabrika.config.ts`; the platform writes `FABRIKA_APP_STORAGE_*`
from it. Never read those variables, build a storage URL or import an S3 client.

```text
// in the services of fabrika.config.ts
{ hostname: 'tasksfiles', type: 'object-storage', objectStorageSize: 1, priority: 50 }
```

A test that boots an application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to
`testKit`.

---

# references/jobs.md — cron jobs

Background work is a cron job: `app.cron(schedule, { actions, scope: 'app' })` with its `.handle(…)` in the
`endpoints.ts` of the slice whose data it works on, mounted under `jobs` in the contract. There are no timers, loops,
`setInterval` or self-scheduled work, and no `ctx.jobs.enqueue`: work for later is a row that the next run picks up.

```ts src/overdue/endpoints.ts
import { app } from '../app-kit'
import { isOverdue } from './logic'

/** Marks every open task past its due day, hourly; each is re-read under its lock, so a concurrent change is skipped. */
export const markOverdue = app.cron('15 * * * *', {
	actions: ['tasks.read', 'tasks.write'],
	scope: 'app',
	timeout: '10m',
	retries: 2,
})
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const tasks = ctx.db.over(ctx.within('tasks.read', 'project')).tasks
		let after: string | undefined
		do {
			const page = await tasks.list({
				where: [
					['overdue', '=', false],
					['status', '<>', 'done'],
					['due_on', '<', today],
				],
				limit: 100,
				after,
			})
			for (const task of page.items) {
				const ref = await ctx.ref('tasks.write', 'task', task.id)
				await ctx.transaction(async (tx) => {
					const locked = await tx.db.on(ref).getForUpdate()
					if (isOverdue(locked, today)) {
						await tx.db.on(ref).update({ overdue: true }, {
							expectVersion: locked.version,
						})
					}
				})
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
```

The list's filter and the decision under the lock are one rule, a pure function of `logic.ts`. A task someone closed,
postponed or cleared the due day of between the list and the lock is left alone:

```ts src/overdue/logic.ts
/** An open task not yet marked, whose due day (`YYYY-MM-DD`) is before `today`. */
export const isOverdue = (
	task: {
		readonly status: 'open' | 'doing' | 'done'
		readonly overdue: boolean
		readonly due_on: string | null
	},
	today: string,
): boolean =>
	task.status !== 'done' && !task.overdue && task.due_on !== null
	&& task.due_on < today
```

```ts src/overdue/__tests__/logic.test.ts
import { expect, test } from 'bun:test'
import { isOverdue } from '../logic'

test('a task is overdue only while open, unmarked and due before today', () => {
	const task = { status: 'open', overdue: false, due_on: '2026-10-01' } as const
	expect(isOverdue(task, '2026-10-12')).toBe(true)
	expect(isOverdue({ ...task, due_on: '2026-10-12' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, due_on: '2099-01-01' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, due_on: null }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, status: 'done' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, overdue: true }, '2026-10-12')).toBe(false)
})
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { markOverdue } from './src/overdue/endpoints'
import { priorities } from './src/priorities/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
	}),
	jobs: { markOverdue },
	health: c.health('/healthz'),
}))
```

- The schedule is five cron fields, UTC. `scope: 'app'` is the only scope: a job reaches every value.
- A job holds exactly its `actions`. `ctx.within(action, dimension)` is a `Within` of every value;
  `ctx.ref(action, dimension, id)` locates one object (404 when it is gone). Bind them with `ctx.db.over(within)`,
  `ctx.db.in(ref)` and `ctx.db.on(ref)`.
- `ctx.within` names the dimension an endpoint's `over` would: the nearest of the rows' chain (tasks lie in a
  project: `'project'`; `references/endpoint.md`). A job holds every value, so a farther one reaches the same rows;
  the rule keeps a job's capability the same as the list endpoint's. `ctx.ref` names the row's own dimension (`'task'`).
- "Today" is the UTC day (`new Date().toISOString().slice(0, 10)`), so a task turns overdue at the first run after its
  due day ends in UTC, hours off an org's own midnight. When the product needs the org's day, ask the human: the
  zone is a new column (an IANA name). The decision under the lock then takes the org's day, computed in `logic.ts`
  with `new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now)`, and the list filters with the UTC day plus
  one, since no zone is a day further ahead.
- **Reads run outside the transaction; every write runs inside `ctx.transaction((tx) => …)`**, through `tx.db`, fenced
  by the attempt's lease. A write outside it is a type error that names `tx.db`.
- An attempt that fails or outlives `timeout` (default 15 minutes) is retried up to `retries` times, so every write is
  idempotent. **Re-read each row under its lock before you write it:** `tx.db.on(ref).getForUpdate()` inside the
  transaction, decide again on what it answers with the list's whole filter (`isOverdue`), and write with its
  `version`. The listed row is already old: someone
  may have closed the task since, and writing with the listed version fails the whole attempt with a 409.
- Paging over a filter the job's own writes change is safe: `after` is a keyset cursor on the key, so a row that
  leaves the filter (`overdue` is now true) moves no other row to an earlier page.
- A bulk write declares `sql: 'write'` on the job and runs `tx.sql` inside the transaction:

  ``ctx.transaction((tx) => tx.sql(Marked)`update tasks set overdue = true, version = version + 1 where (…) and ${tx.sql.scope(within, 'tasks')} returning id`)``

  `within` is the `Within` the job minted (`ctx.within('tasks.write', 'project')`). The version bump is yours to write.
- `bun test --isolate` runs a job with `kit.runJob('markOverdue')` (`references/tests.md`). The platform runs
  `fabrika job run <name>` from the crontab it generates; never write a crontab or read `FABRIKA_JOB_*`.
- A job cannot create scopes or manage members, and has no `ctx.members`: a job holds no object chain. It issues share
  links only when it declares `issues: '<link mount>'` and its actions hold the mount's `issuedBy` and every grant:
  `ctx.links.issue(await ctx.ref('<issuedBy>', '<dimension>', id), { mount, days })`, and `ctx.links.revoke(id)` for
  a link it issued. It is a widening for closer review. `references/public-intake.md` is the whole recipe: a form's
  inbox, the record, the link and its e-mail, each step recorded before the next.
- `ctx.signal` aborts when the attempt ends (its timeout, a lost lease). Call `ctx.signal.throwIfAborted()` before
  each external effect and pass the signal to `fetch`, so a stale attempt starts nothing after its replacement.

---

# references/public-intake.md — the public intake recipe

A visitor who has no account submits a form on a public page, confirms the e-mail address through a link, attaches
files, and asks for a new link when the first one is lost. HR reviews the records, an HR lead edits the code list of
open positions, HR exports every candidate with an audit row, and a member checks the mail setup with a test e-mail to
their own address. This file is an application of its own (`intake`);
its `package.json`, `tsconfig.json` and `src/app-kit.ts` are those of `app-setup.md`.

Every piece lets in someone who is not signed in, so ask the human before you build it, and say what each one lets the
visitor do. The visitor never reaches a handler without a credential:

1. **A public page** (`c.spa('/', { access: { public: true } })`) holds the form. It reads no data.
2. **A form** appends one row to its inbox table and answers `{ result: { received: true } }`, for a new and a known
   address alike. It runs no handler: a handler would give every anonymous request a transaction, and a different
   answer for a known address would tell a stranger who registered.
3. **A cron job** drains the inbox, creates the record, issues a link bound to it (`issues`), and sends the e-mail.
   Each form kicks it (`then: 'intake'`), so it runs within seconds of a submission; its schedule is the recovery.
4. **A link mount** serves the visitor's own record: `verify` and the record's files, under the link's key.
5. **A second form** asks for a new link. The job revokes the old one and sends a new one, within a budget per address.

## The vocabulary, the migrations and the policies

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'intake',
	dimensions: { candidate: {} },
	actions: {
		'candidates.read': 'Read candidate records and their files',
		'candidates.review': 'Move a candidate through the review',
		'candidates.verify': "Confirm a candidate's e-mail address",
		'candidates.attach': 'Attach files to a candidate record',
		'candidates.invite': "Issue a candidate's portal link",
		'candidates.process': 'Register candidates and send their links',
		'positions.read': 'Read the open positions',
		'positions.manage': 'Edit the open positions',
		'exports.read': 'Read the log of candidate exports',
	},
	roles: {
		hr: { grants: ['candidates.read', 'candidates.review', 'positions.read'] },
		hr_lead: { grants: ['positions.read', 'positions.manage', 'exports.read'] },
	},
})
```

- `candidate` is a top-level dimension with no members: a candidate is a record, not a scope people are invited to.
- `hr` and `hr_lead` have no `member`, so an administrator grants them in IAM, usually without a scope (a global
  grant). The code list and the export of every candidate need that grant: they are data of the whole application.
- The link's holder and the job get their actions from the link mount and the job's `actions`, not from a role.

```sql db/migrations/20261013090000_intake.sql
CREATE TYPE candidate_status AS ENUM ('new', 'screening', 'interview', 'hired', 'rejected');
CREATE TYPE link_state AS ENUM ('due', 'issued', 'sent');

-- The link delivery is the intake job's own state: each step is recorded here before the next effect starts.
CREATE TABLE candidates (
	id UUID PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status candidate_status NOT NULL DEFAULT 'new',
	verified_at TIMESTAMPTZ,
	link_state link_state NOT NULL DEFAULT 'due',
	link_id TEXT,
	revoke_link_id TEXT,
	sends INTEGER NOT NULL DEFAULT 0,
	window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);

-- The review's history: one row per decision, written in the decision's own transaction.
CREATE TABLE candidate_events (
	id UUID PRIMARY KEY,
	candidate_id UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
	status candidate_status NOT NULL,
	note TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX candidate_events_candidate ON candidate_events (candidate_id);

-- The forms' inboxes: a column per input field, of its name, except the honeypot and the challenge token. A form
-- writes its input fields only, so received_at keeps the time of the submission.
CREATE TABLE registrations (
	email TEXT NOT NULL,
	full_name TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE resend_requests (
	email TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090050_application_data.sql
-- Data of the whole application: the code list an HR lead edits, and the log of every export of all candidates.
CREATE TABLE positions (
	id UUID PRIMARY KEY,
	title TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL
);
CREATE TABLE candidate_exports (
	id UUID PRIMARY KEY,
	row_count INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```sql db/migrations/20261013090100_attachments.sql
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	status TEXT NOT NULL CONSTRAINT fabrika_files_attachments_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TIMESTAMPTZ,
	FOREIGN KEY (owner_id) REFERENCES candidates (id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
CREATE INDEX fabrika_files_attachments_scan ON fabrika_files_attachments (scan_after) WHERE status = 'quarantined';
```

The file table is `fileTableSql('attachments', { table: 'candidates', key: { column: 'id', type: 'uuid' }, chain: [] })`
(`references/files.md`): a top-level owner has no chain.

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate' },
		actions: {
			read: 'candidates.read',
			insert: 'candidates.process',
			update: 'candidates.verify',
		},
		insert: ['email', 'name'],
		update: ['verified_at'],
		version: 'version',
		createdBy: 'created_by',
		columns: {
			status: { write: 'candidates.review' },
			link_state: { read: 'candidates.process' },
			link_id: { read: 'candidates.process' },
			revoke_link_id: { read: 'candidates.process' },
			sends: { read: 'candidates.process' },
			window_started_at: { read: 'candidates.process' },
		},
	},
	candidate_events: {
		scope: { child: 'candidates' },
		actions: { read: 'candidates.read', insert: 'candidates.review' },
		insert: ['status', 'note'],
		createdBy: 'created_by',
	},
	registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
	resend_requests: { scope: { inbox: 'resend', read: 'candidates.process' } },
	positions: {
		scope: { app: 'the open positions an HR lead edits' },
		actions: {
			read: 'positions.read',
			insert: 'positions.manage',
			update: 'positions.manage',
		},
		insert: ['title'],
		update: ['title', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	candidate_exports: {
		scope: { app: 'the log of every export of all candidates' },
		actions: { read: 'exports.read', insert: 'candidates.read' },
		insert: ['row_count'],
		createdBy: 'created_by',
	},
})
```

- `{ inbox: '<form>', read }` is a form's table: only that form appends to it, and only a site that holds `read` and
  declares the reach reads it. No site writes it: `unscoped: { registrations: 'write' }` is refused.
- `{ app: '<why>' }` is an application table: its rows belong to no candidate. Only an endpoint declared
  `access: { action, app: true }` reaches it, through `ctx.db.app`, with the action the operation names. A position is
  deactivated, never deleted, so the table has no delete action. `candidate_exports` is appended with the export's own
  action, `candidates.read`, and read with `exports.read`.
- The form writes each input field to the column of the same name: `full_name`, never `fullName`. tsc refuses another
  name at the form's `appendTo`, and the checker refuses it too. A `ctx.sql` row still reads it as `fullName`.
- The form writes nothing else, so an inbox records the time of a submission only in a `DEFAULT now()` column
  (`received_at`). The job's own `now()` is later: seconds after a kick, up to a minute when the schedule recovers it.
- The delivery columns are read only with `candidates.process`, so neither HR nor the link's holder sees them.

## The contract

```ts src/schemas.ts
import { z } from 'zod/v4'

export const CandidateStatus = z.enum([
	'new',
	'screening',
	'interview',
	'hired',
	'rejected',
])
export const Register = z.strictObject({
	email: z.email().max(200),
	full_name: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
})
export const Resend = z.strictObject({ email: z.email().max(200) })
export const Me = z.strictObject({
	name: z.string(),
	email: z.string(),
	verified: z.boolean(),
})
export const Verified = z.strictObject({ verifiedAt: z.iso.datetime() })
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { candidates } from './src/candidates/endpoints'
import { intake } from './src/intake/endpoints'
import { portal } from './src/portal/endpoints'
import { positions } from './src/positions/endpoints'
import { Register, Resend } from './src/schemas'
import { settings } from './src/settings/endpoints'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	register: c.form('/register', {
		input: Register,
		appendTo: 'registrations',
		maxBytes: 4096,
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		then: 'intake',
	}),
	resend: c.form('/resend', {
		input: Resend,
		appendTo: 'resend_requests',
		maxBytes: 1024,
		then: 'intake',
	}),
	portal,
	api: c.rpc('/api', { candidates, positions, settings }),
	hr: c.spa('/hr', {
		dir: 'dist/hr',
		access: { action: 'candidates.read', over: 'candidate' },
	}),
	files: {
		attachments: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.review',
			maxBytes: 10485760,
			types: ['application/pdf'],
			maxPerOwner: 5,
			link: true,
			scan: true,
		}),
	},
	jobs: { intake },
	health: c.health('/healthz'),
}))
```

- **The public page.** `access: { public: true }` serves the SPA to anyone, without a token, and takes no other key.
  At `/` it answers every `GET` that no more specific endpoint serves, so the HR SPA (`/hr`) and the link's SPA (`/p`)
  keep their own. The approver sees it as "for anyone, without signing in". Put nothing on it that only members may
  read: the page calls no procedure.
- **The form's abuse control.** `honeypot` names an optional string field the page hides: a filled one gets the same
  answer and writes no row. `challenge` makes the framework verify the Turnstile token in `challengeToken` before it
  writes the row (a failed token 400, an unreachable provider 503, no row either way) and adds Turnstile's origin to
  the CSP. `TURNSTILE_SECRET` is an application variable the human sets; without it the application does not boot.
  `rate: { perClient, perForm }` (per minute, 10 and 100 by default) answers 429 past either limit.
- **Zerops shares one client address.** Until the platform reads the visitor's address behind the Zerops balancer,
  every visitor counts as one client there, so `perClient` acts as a second per-form limit: set it to the form's
  expected peak, never lower it to stop a flood. The challenge is the defense that does not depend on the address.
- **Counting clicks** on a public page has no primitive. The pattern is an anonymous form without a challenge whose
  inbox gets one row per click, posted with `fetch(…, { keepalive: true })`. Know both limits before you offer it:
  anyone can inflate the counts (the rate limits bound only how fast), and nothing drains the inbox but a job you
  write. Ask the human first; usually the application should not count clicks.
- **Other origins** the pages load (an image host, an API the browser calls) go in the contract's `csp` section:
  `csp: { scriptSrc: [{ origin: 'https://…', purpose: '…' }] }`, beside `connectSrc`, `imgSrc`, `frameSrc` and
  `frameAncestors`: exact `https://` origins, at most 16 each. Each new origin is a widening the approver sees.
- **Scanned files.** A visitor's upload waits `quarantined` until ClamAV answers clean (`references/files.md`): its
  download answers 409 until then. On Zerops the deploy service needs `verticalAutoscaling: { minRam: 2 }`.
- **The kick.** `then: 'intake'` makes each accepted submission start a run of the job within seconds, once its row
  committed, under the job's own key. The visitor's answer is the same constant and never waits for the run. Kicks
  coalesce on the job's lease (at most one run and one pending, however many visitors submit), so a flood adds no
  work: the run still drains the inbox in batches of 50, within each address's budget. A kick carries nothing; the
  job reads its inbox.

## The job: inbox → record → link → e-mail

```ts src/mail.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Mailer {
	/** Sends the link to `to`; throws when the provider refuses, and gives up once `signal` aborts. */
	sendLink(to: string, url: string, signal: AbortSignal): Promise<void>
	/** Sends a fixed test message to `to`, the same way. */
	sendTest(to: string, signal: AbortSignal): Promise<void>
}

interface Message {
	readonly to: string
	readonly subject: string
	readonly text: string
}

/** Read when a mail is sent: the generated tests boot the application without its variables. */
const variable = (env: Readonly<Record<string, unknown>>, name: string) => {
	const value = env[name]
	if (typeof value !== 'string' || value === '') {
		throw new Error(`the application variable ${name} is not set`)
	}
	return value
}

export const mailer = defineDeps((env): Mailer => {
	const send = async (message: Message, signal: AbortSignal) => {
		const response = await fetch(variable(env, 'MAIL_API_URL'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${variable(env, 'MAIL_API_KEY')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(message),
			signal,
		})
		if (!response.ok) {
			throw new Error(`the mail provider answered ${response.status}`)
		}
	}
	return {
		sendLink: (to, url, signal) =>
			send({
				to,
				subject: 'Confirm your address',
				text: `Open ${
					variable(env, 'INTAKE_ORIGIN')
				}${url} to confirm your address.`,
			}, signal),
		sendTest: (to, signal) =>
			send({
				to,
				subject: 'A test e-mail from the intake',
				text: 'The intake can send you e-mail.',
			}, signal),
	}
})
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { mailer } from './mail'

export default serve(contract, { database: scoped(tables), deps: mailer })
```

```ts src/intake/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Registration = z.strictObject({ email: z.string(), fullName: z.string() })
const Ask = z.strictObject({ email: z.string() })
const Id = z.strictObject({ id: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued', 'sent']),
	linkId: z.nullable(z.string()),
	revokeLinkId: z.nullable(z.string()),
})

/** A link lives a week; an address gets at most three e-mails a day, failed deliveries included. */
const LINK_DAYS = 7
const SENDS_PER_DAY = 3

export const intake = app.cron('* * * * *', {
	actions: [
		'candidates.process',
		'candidates.invite',
		'candidates.read',
		'candidates.verify',
		'candidates.attach',
	],
	scope: 'app',
	retries: 0,
	sql: 'write',
	issues: 'portal',
})
	.handle(async ({ ctx }) => {
		const mail = mailer.get()
		// A registration becomes a candidate once; the form told the visitor nothing either way.
		await ctx.transaction(async (tx) => {
			const rows = await tx.sql(Registration)`
				delete from registrations returning email, full_name`
			for (const row of rows) {
				await tx.sql(Id)`
					insert into candidates (id, email, name, created_by, version)
					values (${crypto.randomUUID()}, ${row.email}, ${row.fullName}, ${ctx.principal.id}, 1)
					on conflict (email) do nothing
					returning id`
			}
		})
		// A resend supersedes the sent link of an unverified candidate while its budget has an e-mail left.
		await ctx.transaction(async (tx) => {
			for (
				const ask of await tx.sql(Ask)`delete from resend_requests returning email`
			) {
				await tx.sql(Id)`
					update candidates
					set link_state = 'due', revoke_link_id = link_id, link_id = null
					where email = ${ask.email} and verified_at is null and link_state = 'sent'
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			}
		})
		// Only a row whose budget has an e-mail left: spent rows would fill the batch and starve the rest.
		const due = await ctx.transaction((tx) =>
			tx.sql(Due)`
				select id, email, link_state, link_id, revoke_link_id
				from candidates
				where link_state <> 'sent'
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				order by id limit 50`
		)
		for (const candidate of due) {
			// The e-mail is charged before any effect; without one left, the row waits as it is.
			const reserved = await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set
						sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
						window_started_at = case when window_started_at < now() - interval '1 day'
							then now() else window_started_at end
					where id = ${candidate.id}
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			)
			if (reserved.length === 0) continue
			// A link issued but not known to be e-mailed, or one a resend superseded, ends first.
			const superseded = candidate.linkState === 'issued'
				? candidate.linkId
				: candidate.revokeLinkId
			if (superseded !== null) {
				ctx.signal.throwIfAborted()
				await ctx.links.revoke(superseded)
				await ctx.transaction((tx) =>
					tx.sql(Id)`
						update candidates set link_state = 'due', link_id = null, revoke_link_id = null
						where id = ${candidate.id} returning id`
				)
			}
			ctx.signal.throwIfAborted()
			const ref = await ctx.ref('candidates.invite', 'candidate', candidate.id)
			const link = await ctx.links.issue(ref, { mount: 'portal', days: LINK_DAYS })
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'issued', link_id = ${link.id}
					where id = ${candidate.id} returning id`
			)
			ctx.signal.throwIfAborted()
			await mail.sendLink(candidate.email, link.url, ctx.signal)
			await ctx.transaction((tx) =>
				tx.sql(Id)`
					update candidates set link_state = 'sent'
					where id = ${candidate.id} and link_id = ${link.id} returning id`
			)
		}
	})
```

The job keeps three invariants. Keep them when you change it:

- **The budget is charged first.** Each delivery reserves one e-mail of the address's daily budget, in its own
  transaction, before any effect. A delivery that fails after the e-mail left is still counted, so a provider that
  times out cannot make the job mail one address without end. Only a row with an e-mail left is selected for the batch
  of 50, so spent rows never crowd out the others; the reservation checks the budget again in its own transaction.
- **Each step is recorded before the next effect.** Revoke a superseded link, then record it; issue, then record the
  link's id (`issued`); send, then record `sent`. A run that stops anywhere (a crash, a refused e-mail, IAM down) is
  finished by the next run its budget allows: an `issued` row's link is revoked and replaced, so exactly one live link
  was e-mailed. The e-mail is at least once. The link's key is never stored: only the job saw it.
- **An effect starts only while the attempt is live.** `ctx.signal.throwIfAborted()` runs before each IAM call and the
  e-mail, and the e-mail takes `ctx.signal`. The runner aborts a timed-out attempt before the next one starts, so no
  effect of a stale attempt follows the next one's. `ctx.links` itself refuses to call IAM for an ended attempt.

More on the job:

- **`issues: 'portal'`** gives the job `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` for the
  links it issued. Its `actions` must hold the mount's `issuedBy` and every grant of the mount, or the contract is
  refused: IAM lets an issuer delegate only what it holds. The link is bound to one candidate (the `Ref`), and the
  approver sees the job's `issues` marked "needs closer review".
- **`sql: 'write'`** is the declared reach into the inboxes: `delete … returning` takes each row exactly once. A job is
  app-wide, so its statements need no scope fragment (`tx.sql.scope` of its `Within` is every row).
- **The latency.** The forms' kick starts a run within seconds of a submission, so the e-mail leaves seconds later,
  while the address has an e-mail of its daily budget left; a spent one waits until a day after the window's first
  e-mail. Keep the schedule (`* * * * *`): it is the recovery path. A kicked run that dies (a crash, a deploy, a
  refused e-mail) leaves its rows, and the next scheduled run finishes them, within a minute. `retries: 0`: that run
  is the retry. A failed run leaves a pending kick to the schedule too.
- **A revoked link** still works until the token the proxy holds for it expires, at most 5 minutes. Revocation is the
  stop at IAM; it is not instant.
- The e-mail goes through `deps` (`src/mail.ts`), built from application variables the human sets (`INTAKE_ORIGIN`,
  `MAIL_API_URL`, `MAIL_API_KEY`). `link.url` is `/p/#<key>`: the key is in the fragment, which no server and no
  `Referer` sees.

## The visitor's link: verify once, attach files

```ts src/portal/endpoints.ts
import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

export const portal = app.link('/p', {
	spa: 'dist/portal',
	dimension: 'candidate',
	grants: ['candidates.read', 'candidates.verify', 'candidates.attach'],
	issuedBy: 'candidates.invite',
	maxDays: 7,
	procedures: (l) => ({
		me: l.query({ output: Me, access: { action: 'candidates.read' } })
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.get()
				return {
					name: row.name,
					email: row.email,
					verified: row.verified_at !== null,
				}
			}),
		verify: l.mutation({
			output: Verified,
			access: { action: 'candidates.verify' },
		})
			.handle(async ({ ctx }) => {
				const row = await ctx.db.target.getForUpdate()
				if (row.verified_at !== null) {
					return { verifiedAt: row.verified_at.toISOString() }
				}
				const now = new Date()
				await ctx.db.target.update({ verified_at: now }, {
					expectVersion: row.version,
				})
				return { verifiedAt: now.toISOString() }
			}),
	}),
})
```

- **Single use is the application's state.** `verify` sets `verified_at` once, under `getForUpdate`; a second call
  answers the same time. IAM counts no uses: the proxy honors a token it holds without asking IAM.
- A link procedure acts on the link's own object: no `from`, no id in the input. A key of another candidate reaches
  only that candidate's record, and a key whose candidate is gone answers 404.
- `link: true` on the collection serves the holder `POST /p/api/files.attachments.upload?name=<name>` (the body is the
  file), `POST /p/api/files.attachments.list` (`{ limit?, after? }`) and `GET /p/api/files.attachments/:fileId`, for
  the link's candidate only: another candidate's file id answers 404. The mount must grant the collection's `write`
  and `read`. HR reaches the same files under `/api/files.attachments…` with `candidates.read`.

```ts web/portal/main.ts
import { createClient, RpcError, shareKey } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

const key = shareKey()
const portal = key === null ? null : createClient(contract, 'portal', { key })

export const confirm = async (status: HTMLElement): Promise<void> => {
	if (portal === null) {
		status.textContent = 'This link holds no key.'
		return
	}
	try {
		const me = await portal.me()
		await portal.verify()
		status.textContent = `${me.name}, your address is confirmed.`
	} catch (error) {
		status.textContent = error instanceof RpcError
			? 'This link no longer works: ask for a new one.'
			: 'Failed'
	}
}

export const attach = async (file: File): Promise<string> => {
	if (key === null) return 'This link holds no key.'
	const response = await fetch(
		`/p/api/files.attachments.upload?name=${encodeURIComponent(file.name)}`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': file.type },
			body: file,
		},
	)
	return response.ok ? 'Received: it is being checked.' : 'Refused.'
}
```

The public page sends the form with a plain `fetch`: a form has no typed client, and its answer never depends on the
data.

```ts web/site/register.ts
export const register = async (
	form: HTMLFormElement,
	challengeToken: string,
): Promise<boolean> => {
	const data = new FormData(form)
	const field = (name: string) => {
		const value = data.get(name)
		return typeof value === 'string' ? value : ''
	}
	const response = await fetch('/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: field('email'),
			full_name: field('full_name'),
			website: field('website'),
			challengeToken,
		}),
	})
	return response.ok
}
```

- The page renders the Turnstile widget with its public site key and `action` set to the form's mount name
  (`register`), and passes the widget's token. Say "check your inbox" on success whatever the address was.
- The resend form is the same call to `/resend` with `{ email }`. It answers the same for an unknown, a verified and a
  rate-limited address; the job decides.
- Build each SPA into its `dir` (`dist/site`, `dist/portal`, `dist/hr`): one `Bun.build` per `index.html` in
  `build-web.ts`.

## HR: the list, the review and its history

```ts src/candidates/logic.ts
type Status = 'new' | 'screening' | 'interview' | 'hired' | 'rejected'

const NEXT: Readonly<Record<Status, readonly Status[]>> = {
	new: ['screening', 'rejected'],
	screening: ['interview', 'rejected'],
	interview: ['hired', 'rejected'],
	hired: [],
	rejected: [],
}

export const canMove = (from: Status, to: Status): boolean =>
	NEXT[from].includes(to)

/**
 * The stage HR sees. Two actions set the two columns it derives from: the link holder's `candidates.verify` sets
 * `verified_at`, HR's `candidates.review` sets `status`. A column has one write action, so the state is two columns.
 */
export const stageOf = (
	status: Status,
	verifiedAt: Date | null,
): Status | 'unconfirmed' => (verifiedAt === null ? 'unconfirmed' : status)
```

```ts src/candidates/endpoints.ts
import { ConflictError, fromPage, fromRow } from '@fabrika/app'
import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { CandidateStatus } from '../schemas'
import { canMove } from './logic'

const Cursor = z.string().max(500)
const Candidate = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
	verifiedAt: z.nullable(z.iso.datetime()),
	version: z.int(),
})
const CandidatePage = z.strictObject({
	items: z.array(Candidate),
	next: z.nullable(z.string()),
})
const Event = z.strictObject({
	status: CandidateStatus,
	note: z.nullable(z.string()),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const History = z.strictObject({
	items: z.array(Event),
	next: z.nullable(z.string()),
})
const ListCandidates = z.strictObject({
	status: CandidateStatus.optional(),
	after: Cursor.optional(),
})
const ById = z.strictObject({ id: z.uuid() })
const HistoryOf = z.strictObject({ id: z.uuid(), after: Cursor.optional() })
const Decide = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	status: CandidateStatus,
	note: z.nullable(z.string().max(2000)),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const ExportRow = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	status: CandidateStatus,
})
const CandidateFile = attachment({
	format: 'csv',
	filename: 'candidates.csv',
	row: ExportRow,
	maxBytes: 4194304,
})
const ExportEntry = z.strictObject({
	rowCount: z.int(),
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
})
const ExportLog = z.strictObject({
	items: z.array(ExportEntry),
	next: z.nullable(z.string()),
})
const LogPage = z.strictObject({ after: Cursor.optional() })

/** The file's row limit: a larger export is refused, never cut short. */
const MAX_EXPORT_ROWS = 10000

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListCandidates,
		output: CandidatePage,
		access: { action: 'candidates.read', over: 'candidate' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Candidate,
				await ctx.db.within.candidates.list({
					where: input.status === undefined
						? []
						: [['status', '=', input.status]],
					orderBy: [['name', 'asc']],
					after: input.after,
				}),
			)
		),
	get: r.query({
		input: ById,
		output: Candidate,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ ctx }) => fromRow(Candidate, await ctx.db.target.get())),
	history: r.query({
		input: HistoryOf,
		output: History,
		access: { action: 'candidates.read', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Event,
				await ctx.db.target.candidate_events.list({
					orderBy: [['created_at', 'asc']],
					after: input.after,
				}),
			)
		),
	decide: r.mutation({
		input: Decide,
		output: Saved,
		access: { action: 'candidates.review', on: 'candidate', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const candidate = await ctx.db.target.getForUpdate()
			if (!canMove(candidate.status, input.status)) {
				throw new ConflictError(
					`a ${candidate.status} candidate does not move to ${input.status}`,
				)
			}
			await ctx.db.target.candidate_events.insert({
				status: input.status,
				note: input.note,
			})
			return ctx.db.target.update({ status: input.status }, {
				expectVersion: input.expectVersion,
			})
		}),
	export: r.mutation({
		output: CandidateFile,
		access: { action: 'candidates.read', app: true },
	})
		.handle(async ({ ctx }) => {
			const rows: z.output<typeof ExportRow>[] = []
			let after: string | undefined
			do {
				const page = await ctx.db.app.candidates.list({
					orderBy: [['name', 'asc']],
					limit: 500,
					after,
				})
				rows.push(...page.items.map((row) => fromRow(ExportRow, row)))
				after = page.next ?? undefined
			} while (after !== undefined && rows.length <= MAX_EXPORT_ROWS)
			if (rows.length > MAX_EXPORT_ROWS) {
				throw new ConflictError(
					`more than ${MAX_EXPORT_ROWS} candidates: export a filtered list`,
				)
			}
			await ctx.db.app.candidate_exports.insert({ row_count: rows.length })
			return rows
		}),
	exports: r.query({
		input: LogPage,
		output: ExportLog,
		access: { action: 'exports.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				ExportEntry,
				await ctx.db.app.candidate_exports.list({
					orderBy: [['created_at', 'desc']],
					after: input.after,
				}),
			)
		),
}))
```

- **Application history is a table on the paved road.** `decide` writes its `candidate_events` row through the
  handle, in the invocation's one transaction: the status and its history row commit together or not at all, and
  `created_by` is the caller. There is no framework audit API; never write history from a job or after the answer.
- **An audited export of every candidate** is one `app` mutation. `ctx.db.app.candidates` lists every candidate,
  because the endpoint's action is the table's read action, and the log row goes into `candidate_exports`, whose
  insert action is that same action, in the invocation's one transaction. The file is encoded before the commit, so
  no file leaves without its row (`references/endpoint.md`). It needs no `sql` and no `unscoped`.
- **`app: true` is for data of the whole application.** The proxy admits the endpoint only for a caller who holds the
  action as a global grant: an HR member granted `candidates.read` on one candidate gets 403. `list` and `get` stay
  `over` and `on`, which serve a scoped grant too.
- `over: 'candidate'` lists every candidate a caller holds `candidates.read` on. HR holds it globally, so
  `ctx.within.values` is `'all'`.
- The generated case of `decide` sends the first status (`new`) to a record that is `new`, which `canMove` refuses
  with 409. Give it an input in `src/__tests__/endpoint-access.fixtures.ts`:

```ts src/__tests__/endpoint-access.fixtures.ts
export const fixtures = {
	'api.candidates.decide': {
		id: '00000000-0000-4000-8000-000000000000',
		expectVersion: 1,
		status: 'screening',
		note: null,
	},
}
```

## The code list an HR lead edits

```ts src/positions/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Position = z.strictObject({
	id: z.uuid(),
	title: z.string(),
	active: z.boolean(),
	version: z.int(),
})
const Positions = z.strictObject({
	items: z.array(Position),
	next: z.nullable(z.string()),
})
const Page = z.strictObject({ after: z.string().max(500).optional() })
const NewPosition = z.strictObject({ title: z.string().min(1).max(200) })
const EditPosition = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.string().min(1).max(200),
	active: z.boolean(),
})
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

export const positions = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: Page,
		output: Positions,
		access: { action: 'positions.read', app: true },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Position,
				await ctx.db.app.positions.list({
					orderBy: [['title', 'asc']],
					after: input.after,
				}),
			)
		),
	add: r.mutation({
		input: NewPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.insert({ title: input.title })
		),
	edit: r.mutation({
		input: EditPosition,
		output: Saved,
		access: { action: 'positions.manage', app: true },
	})
		.handle(({ input, ctx }) =>
			ctx.db.app.positions.update(input.id, {
				title: input.title,
				active: input.active,
			}, { expectVersion: input.expectVersion })
		),
}))
```

- `ctx.db.app.<table>` of an application table has `list`, `count` and `aggregate` with its read action, `get(id)`
  with any action it names, and in a mutation `getForUpdate(id)`, `insert(v)`, `update(id, v, { expectVersion })` and
  `remove(id, { expectVersion })` with the operation's action. Its key is generated on insert.
- The HR SPA reads the list with `positions.read`; an HR lead's page adds and edits with `positions.manage`. A
  position that is no longer open is deactivated, so a record that names it keeps its meaning.
- Only an `app` endpoint reads an application table. A code list that a link holder or a scoped endpoint must read
  is a reference table instead (`references/table-and-migration.md`), changed by a migration.

## A test e-mail to yourself

```ts src/settings/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Sent = z.strictObject({ sentTo: z.string() })

/** How long the provider may take: a request has no signal of its own. */
const SEND_TIMEOUT_MS = 10000

export const settings = app.group({ callers: ['human'] }, (r) => ({
	testMail: r.mutation({ output: Sent, access: { member: true } })
		.handle(async ({ ctx }) => {
			const to = ctx.principal.email
			await mailer.get().sendTest(to, AbortSignal.timeout(SEND_TIMEOUT_MS))
			return { sentTo: to }
		}),
}))
```

- **The address is the caller's, from the token.** `ctx.principal.email` is the mailbox IAM recorded for the person
  (lower-cased), so the input has no address field. IAM recorded it; how far it checked that the person controls it is
  its login method's (an operator may accept an IdP's unverified address). An input that named one would let any member mail any address
  past every consent the application asks for. Never take a recipient from the input for "send it to me".
- `{ member: true }` admits any member of the application and reaches no data: the endpoint mails only the caller.
  The generated tests give a `member` endpoint no case, so the test below is yours.
- The page shows the button only to someone signed in: its SPA reads `/hr/__fabrika-me.json` (`references/app-setup.md`).

## Tests

- The generated tests cover HR's endpoints, the files and the link's procedures: the endpoint access kit asks each
  link procedure as a holder of a key bound to a seeded candidate. Each `app` endpoint gets two cases: a holder of
  its action in one candidate only is 403, and a global holder reaches it. `positions` and `candidate_exports` get a
  policy probe of their actions, held globally and in one scope. An endpoint that `issues` gets the cases of any `on`
  endpoint: the generated tests' stand-in IAM issues its link (`references/tests.md`).
- Your own test of a link procedure makes the holder `kit.testCaller([{ action: 'candidates.verify', scope: { type:
  'candidate', value: id } }], { kind: 'link', link: { mount: 'portal', chain: [{ type: 'candidate', value: id }] }
  })` and calls `createClient(contract, 'portal', { fetch: kit.fetch, key: holder.key ?? '' })`.
- The job asks IAM to issue and revoke links, and the kit's own IAM answers only the credentials of its callers, not a
  job's key, so `kit.runJob('intake')` needs `testKit(app, { membership })` with an `IamMembershipRpc` of your own that
  answers `issueLink` and `revokeLink`. A test of a form passes `env: {
  TURNSTILE_SECRET: '…' }` and `challengeFetch`, a stand-in for Turnstile's answer, to `testKit`, and a fresh
  `challengeToken` with each submission: a token is single use. Test each stop of a delivery (a refused e-mail, IAM
  down, a crash after each step): the next run must leave exactly one live, e-mailed link.
- A test that submits a form kicks the job too, and the kicked run may start at once: arm a fault before the
  submission, never between it and the run. `kit.runJob('intake')` first waits for the kicked runs, then runs once.
- The e-mail provider is a stand-in too: `testKit(app, { env: { MAIL_API_URL, MAIL_API_KEY: 'test', INTAKE_ORIGIN:
  'https://intake.test' } })` points the mailer at a test URL, which `standInMail()` answers. Call its `restore()` in
  `afterEach`.
- The test e-mail goes to the caller's own address: the test sends no address and reads the recipient from the stand-in.

```ts src/__tests__/mail-stand-in.ts
import { spyOn } from 'bun:test'

/** The mail provider of a test; `env.MAIL_API_URL` points the mailer here. */
export const MAIL_API_URL = 'https://mail.test/send'

/** Answers the mail provider's URL and keeps each mail; every other request goes on to the real `fetch`. */
export const standInMail = () => {
	const sent: string[] = []
	const passOn = globalThis.fetch
	const answer = async (...args: Parameters<typeof fetch>) => {
		const request = new Request(...args)
		if (request.url !== MAIL_API_URL) return passOn(...args)
		sent.push(await request.text())
		return new Response(null, { status: 202 })
	}
	const spy = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(answer, { preconnect: passOn.preconnect }),
	)
	return { sent, restore: () => spy.mockRestore() }
}
```

```ts src/__tests__/settings.test.ts
import { createClient } from '@fabrika/app/client'
import { type IamMembershipRpc, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import app from '../app'
import { MAIL_API_URL, standInMail } from './mail-stand-in'

const postgres = await testDatabase({
	migrations: new URL('../../db/migrations/', import.meta.url),
	label: 'settings.test.ts',
})

/** This test issues no link: every membership request is refused. */
const refused = (): Promise<{ ok: false; reason: 'not_allowed' }> =>
	Promise.resolve({ ok: false, reason: 'not_allowed' })
const membership: IamMembershipRpc = {
	requestDelegation: refused,
	createScope: refused,
	assignMember: refused,
	revokeMember: refused,
	listMembers: refused,
	findMember: refused,
	issueLink: refused,
	revokeLink: refused,
}

const Mail = z.strictObject({
	to: z.string(),
	subject: z.string(),
	text: z.string(),
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, {
		database: postgres.database,
		files: new MemoryFileObjects(),
		membership,
		env: {
			MAIL_API_URL,
			MAIL_API_KEY: 'test',
			INTAKE_ORIGIN: 'https://intake.test',
			TURNSTILE_SECRET: 'test',
		},
	})
	let restore = () => {}
	afterEach(() => restore())

	describe('the test e-mail', () => {
		test("goes to the caller's own address, which the call does not name", async () => {
			const mail = standInMail()
			restore = mail.restore
			const lead = kit.testCaller([{ role: 'hr_lead' }], {
				email: 'Lead@Intake.test',
			})
			const api = createClient(contract, 'api', { fetch: kit.browser(lead) })
			expect(await api.settings.testMail()).toEqual({ sentTo: 'lead@intake.test' })
			expect(mail.sent.map((body) => Mail.parse(JSON.parse(body)).to)).toEqual([
				'lead@intake.test',
			])
		})
	})
}
```

---

# references/start.md — a new application, before its first table

A new application starts without tables: a vocabulary, a contract, one endpoint and its first test. It needs no
database, no migration and no generated schema until it stores something. This file is an application of its own; its
`package.json` and `tsconfig.json` are those of `app-setup.md`, without the `build:web` script until it has an SPA.

## The files

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'tasks.read' } },
	},
	actions: {
		'tasks.read': 'Read the tasks of an org',
		'members.manage': 'Invite and remove members',
	},
	roles: {
		owner: {
			grants: ['tasks.read', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
	},
})
```

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary)
```

```ts src/orgs/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const MyOrgs = z.strictObject({ all: z.boolean(), orgs: z.array(z.string()) })

export const orgs = app.group({ callers: ['human'] }, (r) => ({
	mine: r.query({
		output: MyOrgs,
		access: { action: 'tasks.read', over: 'org' },
	})
		.handle(({ ctx }) =>
			ctx.within.values === 'all'
				? { all: true, orgs: [] }
				: { all: false, orgs: [...ctx.within.values].sort() }
		),
}))
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { orgs } from './src/orgs/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { orgs }),
	health: c.health('/healthz'),
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'

export default serve(contract, { database: null })
```

- `defineApp(vocabulary)` declares no tables, so `serve` takes `database: null`, and only then. A handler has no
  `ctx.db`, `ctx.sql` or `unscoped` (a type error that names `defineApp(vocabulary, tables)`); it answers from the
  caller's grants (`ctx.within.values`, `ctx.principal`), the member directory, or a connector.
- Forms, jobs and file collections keep their rows in tables, so an application gets them with its first table.

```ts fabrika.config.ts
import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'

const compiled = compileContract(contract, {})

const services = (): ZeropsServiceSpec[] => [
	{
		hostname: 'tasksapi',
		type: 'alpine/bun@1.3',
		priority: 10,
		enableSubdomainAccess: false,
		minContainers: 1,
		maxContainers: 2,
	},
]

export default defineApp({
	id: contract.vocabulary.app,
	schema: schemaFromContract(compiled),
	target: {
		platform: 'zerops',
		services,
		contract: compiled,
		proxy: { upstream: 'tasksapi:3000', ...contractProxyTable(compiled) },
		deployService: 'tasksapi',
		zeropsSetup: 'tasksapi',
	},
})
```

Without a PostgreSQL service the platform runs no `fabrika db migrate`, no codegen check and no generated test at
start. `zerops.yaml` holds only `build.base` until the application has an SPA to build.

## The first test

`bunx fabrika db test-scaffold` writes nothing for this application and says so: the generated tests start with the
first table (its policy test, then the endpoint access test over its rows). `bun test` fails on an application with no test file, and the platform's
build runs it, so write the first test yourself:

```ts src/__tests__/orgs.test.ts
import { createClient } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'

const kit = testKit(app)

describe('a new application', () => {
	test('answers its health check', async () => {
		expect((await kit.fetch('/healthz')).status).toBe(200)
	})

	test('lists the orgs a member works in, and refuses a caller of none', async () => {
		const owner = kit.testCaller([
			{ role: 'owner', scope: { type: 'org', value: 'acme' } },
		])
		const api = createClient(contract, 'api', { fetch: kit.browser(owner) })
		expect(await api.orgs.mine()).toEqual({ all: false, orgs: ['acme'] })
		const stranger = kit.browser(kit.testCaller([]))
		const refused = await stranger('/api/orgs.mine', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(refused.status).toBe(403)
	})
})
```

The loop of `SKILL.md` without its database lines: `bun test --isolate` until it passes, then `bunx tsc --noEmit` and
`bunx fabrika-check .` once each.

## The first table

When the application first stores something, in this order:

1. Add the PostgreSQL service to `fabrika.config.ts` (`app-setup.md`). The platform then migrates at every start.
2. `bunx fabrika db new <slug>` and the table's SQL (`table-and-migration.md`), then `bunx fabrika db migrate` and
   `bunx fabrika db codegen`, which writes `src/db/schema.generated.ts`.
3. `src/db/tables.ts` with the table's policy, over the generated `columns`.
4. `defineApp(vocabulary, tables)` in `src/app-kit.ts`, `serve(contract, { database: scoped(tables) })` in
   `src/app.ts`, and `compileContract(contract, tables)` in `fabrika.config.ts`.
5. `bunx fabrika db test-scaffold`: it now writes the generated tests. Commit them.

## The skill itself

These rules ship in `@fabrika/app` (`node_modules/@fabrika/app/skill/`), at the version the application installed:
read them there, or install them where an agent looks for skills.

- `bunx fabrika builder init --profile zerops-app --no-daemon --no-open --agent=claude` (or `codex`, or `all`)
  writes them under `.claude/skills/fabrika-app/` (`.agents/skills/fabrika-app/` for Codex) from the application's own
  `@fabrika/app`, beside the builder's `fabrika` skill. It also creates the builder's `.fabrika/` and an empty
  `tests/`. Run `bun install` first, or it installs the builder's copy and says so.
- After you update `@fabrika/app`, run it again: it replaces the files it installed and keeps a file you edited.
- An agent that reads `AGENTS.md` gets the same text, rendered by `renderAgentsFile` of `@fabrika/app/agent-skill`:
  `bun -e "import { installedAppAgentSkill, renderAgentsFile } from '@fabrika/app/agent-skill'; const skill =
  installedAppAgentSkill('.'); if (skill) await Bun.write('AGENTS.md', renderAgentsFile(skill))"`. Regenerate it
  after each update; never edit it.

---

# references/table-and-migration.md — the vocabulary, migrations and table policies

The order is fixed: the vocabulary, then the migration, then `fabrika db migrate` and `fabrika db codegen`, then the
table policies, which take the generated `columns`.

## The vocabulary

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'tasks.read' } },
		project: { in: 'org' },
		task: { in: 'project' },
	},
	actions: {
		'tasks.read': 'Read projects, tasks and comments',
		'tasks.write': 'Create and edit projects, tasks and comments',
		'tasks.assign': 'Assign a task to a member',
		'members.manage': 'Invite and remove members',
	},
	roles: {
		owner: {
			grants: ['tasks.read', 'tasks.write', 'tasks.assign', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
		member: {
			grants: ['tasks.read', 'tasks.write'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
	},
})
```

- A **dimension** is a kind of scope value. `in` is its container: every task lies in one project, every project in
  one org. A grant on a container reaches everything inside it. A top-level dimension (`org`) is the value IAM grants
  roles in; no table needs to own it.
- An **action** is an exact name; a role lists actions and there is no `*`. Give an operation that only some roles
  may do its own action (`tasks.assign`).
- A **membership role** (`member: { scope, assignableBy }`) is granted in one value of `scope`. `assignableBy` names
  who may give it there: a membership role of the same `scope`, held in that value, or a role with no `member`, which
  IAM grants app-wide (`staff`), held globally. Holding the role is not enough: IAM also requires `members.manage` and
  every action of the role given in that value, which a global grant covers. `external: true` on
  one lets a person from outside the organization (a partner's account) hold it; IAM gives such a person no other
  role. `{ member: true }` then admits them too, so a staff-only endpoint names an action only internal roles grant.
  `ctx.members` answers each member's `affiliation`.
  `members: { manage, list }` on a dimension gives `ctx.members` to the endpoints on, in or below it: a lookup of one
  member everywhere, the list with `list`, management with `manage` (`references/endpoint.md`).
- `admin` is reserved: IAM defines it for every application. `defineVocabulary` refuses it.
- `locale: 'cs'` (or `'en'`) and `displayName: 'Tasks'` beside `app` set the language and the name IAM uses for the
  application on its sign-in, password and invitation pages and e-mails. Without `locale` IAM speaks its default
  language, `en`. Without `displayName` the sign-in and password pages and mails name no application, and an invitation
  names it by its id (`tasks@prod`). The approver sees each change.
- `mail` beside them words IAM's e-mails in the application's own way: per message (`invitation`, `enrollment`,
  `reset`) and language, a one-line `subject` and a plain `text` with `{{name}}` placeholders, for example
  `mail: { reset: { cs: { subject: 'Nové heslo do {{displayName}}', text: 'Heslo si nastavíte zde:\n{{actionUrl}}' } } }`.
  The text must hold `{{actionUrl}}`, the one-time link IAM builds, and the subject must not; IAM writes the HTML part
  itself. Every message fills
  `{{displayName}}`, `{{recipient}}`, `{{actionUrl}}` and `{{expiry}}`; an invitation also `{{inviterLabel}}`,
  `{{companyLabel}}` and `{{message}}`. Another placeholder is refused. A message or language without a template is IAM's
  own wording.
- `creator: '<role>'` on a top-level dimension lets an endpoint with `creates: '<dimension>'` make a new value and
  grant the caller that role there.

## The migration

```sql db/migrations/20261012090000_tasks.sql
-- An org is the scope IAM grants roles in; no table owns it. Every contained table repeats its container's chain and
-- references UNIQUE (id, <chain>) of its container, so a moved project moves its tasks.
CREATE TABLE projects (
	id UUID PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, org_id)
);
CREATE INDEX projects_org ON projects (org_id);

CREATE TYPE task_status AS ENUM ('open', 'doing', 'done');

CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	status task_status NOT NULL DEFAULT 'open',
	assignee TEXT,
	assignee_label TEXT,
	due_on DATE,
	overdue BOOLEAN NOT NULL DEFAULT false,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, project_id, org_id),
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE
);
CREATE INDEX tasks_project ON tasks (project_id);

CREATE TABLE task_comments (
	id UUID PRIMARY KEY,
	task_id UUID NOT NULL,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	body TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (task_id, project_id, org_id) REFERENCES tasks (id, project_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX task_comments_task ON task_comments (task_id);

CREATE TABLE project_exports (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	row_count INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX project_exports_project ON project_exports (project_id);

-- A code list: shared rows that every endpoint reads, and only a migration writes.
CREATE TABLE priorities (
	code TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	rank INTEGER NOT NULL
);
INSERT INTO priorities (code, label, rank) VALUES ('low', 'Low', 1), ('normal', 'Normal', 2), ('high', 'High', 3);
```

- `bunx fabrika db new <slug>` writes `db/migrations/<UTC YYYYMMDDHHMMSS>_<slug>.sql`. Without a shell, use that name.
- The key is `id`. A contained table has `<container>_id` and every column of its container's chain (`project_id`,
  `org_id`), `UNIQUE (id, <chain>)`, and a composite foreign key `(<container>_id, <chain>) → <container
  table> (id, <chain>)`. A child table (`task_comments`) does the same with its parent. Without the composite key the
  table policy is refused, and an `over` list cannot reach the table from an outer dimension.
- `version INTEGER NOT NULL` makes `expectVersion` and the 409 work; `created_by TEXT NOT NULL` with `createdBy` in
  the policy records the caller. The data layer generates `id` and writes `version` and `created_by`.
- A column with a fixed set of values is an `ENUM` type, not a `CHECK` on text: the generated tests fill text columns
  with markers, which a `CHECK` refuses.
- Codegen types: `date` is a `YYYY-MM-DD` string; `timestamptz` reads a `Date` and takes a `Date` or a strict ISO 8601 string with `Z` or an offset;
  `int8` and `numeric` are strings; an enum is its literal union. JSON, `bytea`, arrays and domains are refused.
- Plain SQL of the application's own schema only. Refused: another schema (`public.`, `app_…`), any `fabrika_*`
  object (except a file collection's table, `references/files.md`), `GRANT`, roles, `CREATE EXTENSION`, `COPY`,
  `SET`, transaction control, `SECURITY DEFINER`, a domain, `serial` and sequences (use `GENERATED ALWAYS AS IDENTITY`),
  a function overload, and calls outside the reviewed built-ins.
- Never edit, rename or delete a committed migration; add a new one. Change a schema by expand, switch, contract, and
  ask before you drop or rename anything.

## Database code is a declared deviation

A function, trigger, view, rule, policy or `DO` block in a migration is allowed. The migration file declares it, and
the approver sees it marked "needs closer review". Prefer a handler when the rule is the application's; use database
code when it must hold for every writer.

```sql db/migrations/20261012110000_done_clears_overdue.sql
CREATE FUNCTION tasks_done_clears_overdue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status = 'done' THEN
		NEW.overdue := false;
	END IF;
	RETURN NEW;
END
$$;

CREATE TRIGGER tasks_done_clears_overdue BEFORE UPDATE ON tasks
	FOR EACH ROW EXECUTE FUNCTION tasks_done_clears_overdue();
```

The platform runs `fabrika db codegen --verify` at every start; it fails when the schema holds database code that no
migration declares.

## The table policies

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
		createdBy: 'created_by',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: {
			read: 'tasks.read',
			insert: 'tasks.write',
			update: 'tasks.write',
			delete: 'tasks.write',
		},
		insert: ['title', 'due_on'],
		update: ['title', 'status', 'due_on', 'overdue'],
		version: 'version',
		createdBy: 'created_by',
		columns: {
			assignee: { write: 'tasks.assign' },
			assignee_label: { write: 'tasks.assign' },
		},
	},
	task_comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['body'],
		createdBy: 'created_by',
	},
	project_exports: {
		scope: { child: 'projects' },
		actions: { read: 'tasks.read', insert: 'tasks.read' },
		insert: ['row_count'],
		createdBy: 'created_by',
	},
	priorities: {
		scope: { reference: 'the priority codes; a migration changes them' },
		actions: { read: 'tasks.read' },
	},
})
```

- Every table has a policy. Its scope is one of: `{ dimension: '<d>' }` (the table owns the dimension's values),
  `{ child: '<table>' }` (rows that belong to one row of the parent), `{ app: '<why>' }` (rows of the whole
  application, such as a code list an administrator edits) or `{ reference: '<why>' }` (shared rows every endpoint
  reads and none writes; a migration changes them).
- An application table takes `actions`, `insert`, `update`, `version`, `createdBy` and `columns` like a dimension
  table, and no container. Only an `app: true` endpoint reaches it (`ctx.db.app.<table>`, `references/endpoint.md`),
  and only a caller who holds the operation's action as a global grant. Data that a link holder or a scoped member
  reads stays a reference table.
- A reference table (`priorities`) takes `actions: { read: '<action>' }` and, at most, `columns` with read actions: no
  `insert`, `update`, `version` or `createdBy`. Its rows change by a migration only. No handle writes it, and
  `unscoped: { priorities: 'write' }` is refused by tsc and the checker.
- The key (`id`), the container column (`<container>_id`), a child's column (`<parent dimension>_id`) and the chain
  are derived. State `in: { column }` or `column` only off that convention.
- `actions` maps `read`, `insert`, `update` and `delete` to vocabulary actions. `insert` and `update` list the columns
  that those actions write; nothing else is writable.
- `columns: { <column>: { read: '<action>' } }` hides a column from every capability of another action, in the data
  and in the types. `columns: { <column>: { write: '<action>' } }` lets only that action update the column (and that
  action updates nothing else); the column is then not in `update`.
- A column has one write action. A state that two actions change is two columns: in `references/public-intake.md` the
  link holder's `candidates.verify` sets `verified_at`, HR's `candidates.review` sets `status`, and `logic.ts` derives
  the stage HR sees from both (`stageOf`).
- An audit or history table is an ordinary child table that a handler writes in its own transaction:
  `project_exports` logs each export of a project's tasks, so its insert action is the export's read action
  (`references/endpoint.md`). The log of an export across every record is an application table instead
  (`references/public-intake.md`). There is no framework audit API.
- IAM already audits sign-ins (its auth log, refusals included) and every grant and revocation (its admin events
  `iam.grant.create` and `iam.grant.revoke`): do not rebuild either in the application. An operator's access to the
  database or to the provider's console is outside Fabrika.

---

# references/tests.md — generated tests, seeds and your own tests

## The generated tests

`bunx fabrika db test-scaffold` writes them from the contract and the table policies, and deletes the ones it no
longer writes. Commit them; never edit, format or import them (`generated-test-hash`).

- `src/db/__tests__/<table>.policy-isolation.test.ts`: the data layer keeps each table's rows in their scope.
- `src/__tests__/endpoint-access.test.ts`: every `on` and `in` endpoint refuses another scope's object (404 or 403);
  every `on` and `over` endpoint, and every `in` endpoint that declares `sql`, answers nothing of another scope; a
  caller with only an endpoint's write action, plus what IAM requires of it (below), reaches its own object (200). An
  `app` or `creates` endpoint refuses a holder of its action in one scope only (403) and answers a global holder.
- Their kit stands in for IAM, as `testKit` does (below): it creates a scope, assigns or invites a member and issues a
  link under IAM's rules for the caller's grants. A repeated invitation answers the open one, `resend` restarts its
  7 days, and an organization's address is refused for an external role (`internal_mailbox`). So the caller of an endpoint with the dimension's `members.manage`
  holds it on the object itself, with one role the assigned role's `assignableBy` names and the assigned role's
  actions: the membership roles the input names, or every one of the dimension when it names none. The caller of an
  endpoint that `issues` also holds the actions its link grants.

Run them after every change of the contract or the tables. The platform runs them at every start, and the
application is not ready until each passes. A failing generated test is a bug in the handler, the policy or the
fixtures, never in the test: do not loosen access to make it pass.

## Fixtures and seeds

`src/__tests__/endpoint-access.fixtures.ts` is yours, read statically (plain literals only):

```ts src/__tests__/endpoint-access.fixtures.ts
export const seeds = { 'api.tasks.close': { status: 'doing' } }
export const members = { 'api.tasks.assign': ['assignee'] }
```

- `export const fixtures = { '<endpoint id>': { … } }` is an input for an endpoint whose schema the scaffold cannot
  sample, such as a `regex` or a webhook's bind:
  `{ 'webhooks.github.bind': { scope: 'acme', account: 'installation:1' } }`. The checker names each missing one,
  and one of an endpoint that does not exist (`endpoint-fixture`). The access form's `from` field is
  replaced by the seeded scope.
- `members['<endpoint id>']` lists the input fields that name a picked person the handler checks with
  `ctx.members.get` (`assign`'s `assignee`). The generated cases send a real member of the object's org there; without
  it they send a sample, the handler answers 400, and the case fails.
- `invitations['<endpoint id>']` and `links['<endpoint id>']` list the input fields that name an invitation an endpoint
  cancels (`ctx.members.revoke(ctx.target, { invitationId })`) or a share link it revokes (`ctx.links.revoke(id)`):
  `export const invitations = { 'api.members.cancel': ['invitationId'] }`. The generated cases send one their stand-in
  IAM holds there: an invitation open in the object's value, a link of the endpoint's mount that the case's caller
  issued. Without it they send a sample, IAM answers 404, and the case fails.
- `seeds['<endpoint id>']` is the state its precondition needs, written into the row of the table that owns the
  endpoint's dimension in both scopes: `close` answers 409 for an open task, so the seed makes it `doing`. A seed
  sets neither a column that places the row nor a text column.
- The endpoint id is `<mount>.<group>.<endpoint>` (`api.tasks.close`).
- The seed of the tests fills every text column with a marker and every other required column with a sample of its
  type: an enum's first label, `1`, `false`, today. A column with a `DEFAULT` keeps it (`status` is `open`). A
  `CHECK` on a text column fails those rows: use an `ENUM` type. A required foreign key outside the containment chain
  cannot be filled: give it a default, or make it nullable and not text. The seed writes its marker into every text
  column, a nullable one too, and no row it references holds that marker.
- A generated case's input is a sample of the schema: no optional field, `null` for a nullable one, an enum's first
  value, the shortest string its bounds admit (`'x'`), the smallest number, `false`, a fixed value for a format
  (`uuid`, `email`, `iso.date`). When that input meets a precondition (`close` of an `open` task is 409), seed the
  state, or give the whole input in `fixtures`.

## Your own tests

Test the rules of `logic.ts` as plain functions. Test a handler through `testKit` and the typed client, with each
allowed call beside its refused twin:

```ts src/tasks/__tests__/tasks.test.ts
import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'tasks.test.ts',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const acme = kit.scope('org', 'acme')
	const inAcme = (role: 'owner' | 'member') =>
		kit.testCaller([{ role, scope: acme }])
	const owner = inAcme('owner')
	const member = inAcme('member')
	const ownerApi = createClient(contract, 'api', { fetch: kit.browser(owner) })
	const memberApi = createClient(contract, 'api', { fetch: kit.browser(member) })

	describe('tasks', () => {
		test('an owner assigns a task and a member may not; the assignee sees it under mine', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Launch',
			})
			const task = await memberApi.tasks.create({
				projectId: project.id,
				title: 'Write the brief',
			})
			expect(
				await statusOf(
					memberApi.tasks.assign({
						id: task.id,
						expectVersion: 1,
						assignee: member.id,
					}),
				),
			).toBe(403)
			expect(
				await ownerApi.tasks.assign({
					id: task.id,
					expectVersion: 1,
					assignee: member.id,
				}),
			).toEqual({ id: task.id, version: 2 })
			expect((await memberApi.tasks.mine({})).items.map((item) => item.id))
				.toEqual([task.id])
		})

		test('only a task in progress closes', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Ops',
			})
			const task = await memberApi.tasks.create({
				projectId: project.id,
				title: 'Rotate keys',
				dueOn: '2026-10-20',
			})
			expect(
				await statusOf(memberApi.tasks.close({ id: task.id, expectVersion: 1 })),
			).toBe(409)
			await memberApi.tasks.start({ id: task.id, expectVersion: 1 })
			expect(await memberApi.tasks.close({ id: task.id, expectVersion: 2 }))
				.toEqual({ id: task.id, version: 3 })
		})

		test("the member directory lists the org's members", async () => {
			const listed = await memberApi.members.list({ orgId: 'acme' })
			expect(listed.items.map((item) => item.principalId).sort()).toEqual(
				[owner.id, member.id].sort(),
			)
		})

		test('a member lists its orgs; a global grant lists none and says all', async () => {
			expect(await memberApi.members.orgs()).toEqual({
				all: false,
				orgs: ['acme'],
			})
			const auditor = createClient(contract, 'api', {
				fetch: kit.browser(kit.testCaller([{ action: 'tasks.read' }])),
			})
			expect(await auditor.members.orgs()).toEqual({ all: true, orgs: [] })
		})

		test('a caller of another org reaches nothing', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Secret',
			})
			const outsider = createClient(contract, 'api', {
				fetch: kit.browser(
					kit.testCaller([{
						role: 'owner',
						scope: { type: 'org', value: 'other' },
					}]),
				),
			})
			expect(
				await statusOf(
					outsider.tasks.create({ projectId: project.id, title: 'Not mine' }),
				),
			).toBe(403)
			expect((await outsider.tasks.mine({})).items).toEqual([])
		})
	})
}
```

- `testDatabase` migrates a throwaway schema; without `FABRIKA_TEST_POSTGRES_URL` it answers `null`, prints
  `<label> skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests`, and the file registers no test.
  A skip proves nothing. To confirm a file ran, run it alone (`bun test --isolate src/tasks`) and check that the pass
  count is its number of tests, or set `FABRIKA_TEST_POSTGRES_REQUIRED=1`: a missing URL then fails the file.
- `statusOf(call)` answers 200 when the call resolves and the status of the application's refusal otherwise; any other
  failure (no answer, a bug in the test) is rethrown. Import it beside `testKit`; do not write your own.
- `kit.testCaller(grants, { kind })` makes a caller: a grant is a role or an action, in one scope or global. A
  membership role is granted in one value of its scope; an action without `scope` is a global grant, for which
  `ctx.within.values` is `'all'` (`kit.testCaller([{ action: 'tasks.read' }])`). `kind: 'machine'` presents a `px_`
  key (`createClient(contract, 'api', { fetch: kit.fetch, key: caller.key })`).
- Build a scope you reuse with `kit.scope('org', 'acme')` (`acme` above). An object literal stored in a variable
  widens its `type` to `string`, which tsc refuses as a grant's `scope`; a dimension the contract lacks is a type error.
- A caller's `id` is `<kind>-<n>` and its `label` `<kind>-<n>@<app>.test`, `n` counting the kit's callers; pass
  `{ id, label }` to fix either (`kit.testCaller(grants, { label: 'Ann' })`). The label is a `string`, only a link
  holder's (`kind: 'link'`) is `null`; it is `ctx.principal.label`, and the directory's label where it shows labels.
  Assert a stored label against `caller.label` or the directory's answer (`members.list` above), never against a
  literal of the default form.
- A human's `email` is `ctx.principal.email`: `<kind>-<n>@<app>.test` unless you pass `{ email }`, which the kit
  lower-cases as IAM does (`kit.testCaller(grants, { email: 'Ann@Example.com' })` mails `ann@example.com`). A
  `machine`, `app` or `link` caller's `email` is `null`. The SPA's `<prefix>/__fabrika-me.json` answers the caller's
  label, email and actions in the kit as in production (`kit.browser(caller)('/__fabrika-me.json')`).
- `kit.browser(caller)` and `kit.fetch` serve one origin, `https://<app>.test` (`kit.origin`). Call a route by its
  path (`kit.browser(owner)('/api/tasks.get', { method: 'POST', … })`), never with another host.
- The kit stands in for IAM's membership operations. A member directory (`ctx.members.list()` and `get(id)`) answers
  from the kit's own callers: everyone `testCaller` gave a membership role in that scope, labels only where the
  dimension declares `directory: 'labels'` (or to a `members.manage` holder). To list someone, make them a caller:
  `kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'acme' } }])`. A `creates` endpoint, member
  management and share links answer under IAM's rules for the caller's grants, and a role they give or remove is live
  from the caller's next request, as in IAM: the creator of a value holds its creator role, a removed member is
  refused and no longer listed.
- `kit.acceptInvitation(invitationId)` is the invited person accepting an invitation your handler opened
  (`ctx.members.assign(ctx.target, { email }, role)`): it answers a new caller labelled by the address, holding the
  role in that scope (an `external` person for an external role). Pass a caller to make an existing person the
  member: `kit.acceptInvitation(invitationId, member)`. An invitation that is not open throws.

```ts src/members/__tests__/members.test.ts
import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'members.test.ts',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const owner = kit.testCaller([{
		role: 'owner',
		scope: kit.scope('org', 'acme'),
	}])
	const ownerApi = createClient(contract, 'api', { fetch: kit.browser(owner) })

	test('an invited person accepts and is listed; once removed, it is refused', async () => {
		const { invitationId } = await ownerApi.members.invite({
			orgId: 'acme',
			email: 'ann@example.test',
			role: 'member',
		})
		const ann = kit.acceptInvitation(invitationId)
		const annApi = createClient(contract, 'api', { fetch: kit.browser(ann) })
		expect(
			(await annApi.members.list({ orgId: 'acme' })).items.map((item) =>
				item.principalId
			),
		)
			.toContain(ann.id)
		await ownerApi.members.remove({ orgId: 'acme', principalId: ann.id })
		expect(await statusOf(annApi.members.list({ orgId: 'acme' }))).toBe(403)
	})
}
```

- `testKit(app, { membership })` replaces the stand-in with your own `IamMembershipRpc`; that kit accepts no
  invitation. `@fabrika/app/testing` exports the types of the options: `IamMembershipRpc` (`membership`),
  `ChallengeFetch` (`challengeFetch`) and `FileScanner` (`scanner`). Import them from there, beside `testKit`.
- `kit.testCaller(grants, { disabled: true })` is a person an operator disabled: the directory lists and finds them
  with `disabled: true`, so an assignment of them answers your handler's 400, and their own requests are refused (401 for
  a session, 403 for a key).
- `kit.runJob('<job>')` runs a cron job once and answers `{ status: 'succeeded', attempts }`.
- An application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to `testKit`;
  without it the application does not boot. With `scan: true`, an upload stays `quarantined` until
  `kit.runJob(FILE_SCAN_JOB)` (`@fabrika/app/implement`) runs with a `scanner` passed to `testKit`: a `FileScanner`
  stand-in, or the real ClamAV one, `clamscanScanner()` of `@fabrika/app/bun`.
- A form's challenge token is single use: a second submission with the same token answers 400 `challenge_failed`,
  also when the test's `challengeFetch` answers success. Send a fresh token with each submission
  (`crypto.randomUUID()`).
- `testKit` takes no `deps`, and a test may not start a server (`Bun.serve` is `forbidden-global`). Stand in for an
  outbound dependency through its variables: `env` points it at a test URL, and `spyOn(globalThis, 'fetch')` answers
  that URL only and passes every other request on (`src/__tests__/mail-stand-in.ts` in `references/public-intake.md`).
- `defineDeps(build)` runs at every boot, the generated tests' too, which set no application variable: read a variable
  where it is used, not in `build` (`references/public-intake.md`).
- Run with `bun test --isolate`: the generated test boots the same application, and its data layer binds once per
  process. Import the test kits from test files only (`test-only-import`).
- No `.skip`, `.only` or test without an assertion, and no `mock.module` of `bun:test` or `@fabrika/*`.

---

# references/webhooks-links-connectors.md — webhooks, share links and connectors

Each of these lets someone in who is not a signed-in member of the scope. Ask the human before you add one, and say
what it lets that caller do.

## Webhooks (GitHub)

```ts src/github/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const RepositoryEvent = z.strictObject({
	action: z.string(),
	repository: z.strictObject({ full_name: z.string().max(200) }),
})

/** A repository created in the bound GitHub account becomes a project of the org the binding is for. */
export const github = app.webhook('/hooks/github', {
	scheme: 'github-sha256',
	boundTo: 'org',
	actions: ['tasks.write'],
	input: RepositoryEvent,
})
	.handle(async ({ input, ctx }) => {
		if (input.action !== 'created') return
		await ctx.db.in(ctx.refs['tasks.write']).projects.insert({
			name: input.repository.full_name,
		})
	})
```

- Mount it by name in the contract: `github,` beside `api`. It answers `POST /hooks/github/:bindingId`.
- `boundTo` is a dimension with `members`. A holder of its `members.manage` binds an org to a GitHub account with the
  generated `POST /api/webhooks.github.bind` (`{ scope, account: 'installation:<id>' | 'repository:<id>' }`), which
  answers the secret and the URL once. The generated tests need a fixture for it (`references/tests.md`).
- The framework checks the signature, the account and the input (undeclared fields are dropped).
  `ctx.refs['<action>']` is a `Ref` of the bound org for each declared action.
- It records the delivery key (a digest of the binding and the body) before the handler runs, and answers a body it
  already ran in the last 30 days without running it again. A handler that throws commits nothing, and the key is
  forgotten, so GitHub's redelivery runs it again from nothing. A process that dies after the record and before the
  commit keeps the key and loses the delivery. So make every effect idempotent, and key an external effect after the
  data work on `ctx.delivery.key`; never rely on exactly one run.

## Share links

```ts src/sharing/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { TaskStatus } from '../schemas'

const ShareTask = z.strictObject({ id: z.uuid(), days: z.int().min(1).max(30) })
const Shared = z.strictObject({ url: z.string() })
const SharedTask = z.strictObject({ title: z.string(), status: TaskStatus })

export const sharing = app.group({ callers: ['human'] }, (r) => ({
	share: r.mutation({
		input: ShareTask,
		output: Shared,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
		issues: 'shared',
	})
		.handle(async ({ input, ctx }) => ({
			url:
				(await ctx.links.issue(ctx.target, { mount: 'shared', days: input.days }))
					.url,
		})),
}))

export const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'task',
	grants: ['tasks.read'],
	issuedBy: 'tasks.write',
	maxDays: 30,
	procedures: (l) => ({
		task: l.query({ output: SharedTask, access: { action: 'tasks.read' } })
			.handle(async ({ ctx }) => {
				const task = await ctx.db.target.get()
				return { title: task.title, status: task.status }
			}),
	}),
})
```

- Mount both: `api: c.rpc('/api', { …, sharing })` and `shared,`. The link's procedures are `POST /s/api/<name>` and
  its SPA is served under `/s/`.
- The issuing endpoint declares `issues: '<mount>'` and its action is the mount's `issuedBy`. IAM binds the key to the
  task's whole chain; the answer is `<prefix>/#<key>`, and a moved task's key reaches nothing.
- The share SPA reads the key with `shareKey()` of `@fabrika/app/client` and calls
  `createClient(contract, 'shared', { key })`. Never read `location.hash`.
- Issue the link after the data work: IAM does not roll back with the transaction.
- `ctx.links.issue` answers `{ id, url, expiresAt }`. Keep the `id` (never the key) to end the link later with
  `ctx.links.revoke(id)`, which the same `issues` declaration gives; its issuer or a holder of `members.manage` on its
  chain may. A revoked link still works until the proxy's token for it expires, at most 5 minutes.
- A link procedure acts on the link's own object (`ctx.db.target`), with no `from` and no id in its input. A link
  that should work once records its use in the row: a `verify` sets `verified_at` once under `getForUpdate`, and a
  second call answers the same. IAM counts no uses.
- A cron job may issue links too (`issues` on `app.cron`, `references/jobs.md`): a visitor without an account gets a
  link by e-mail from a job that drains a form's inbox. `references/public-intake.md` is that recipe end to end, with
  the files a link holder uploads (`link: true`, `references/files.md`).

## Connectors: another application's data

A consumer imports an owner's export. The snapshot comes from Control, so this step needs an operator's credential,
not the application's: `FABRIKA_CONTROL_URL` (or `--url=<control origin>`) and `FABRIKA_CONTROL_KEY`, a machine key
that holds `deploy.read` on the consumer, both in the shell that runs the command only. Ask the human for them; they
are CLI credentials, never application variables, and never committed.

```bash
bunx fabrika connect add catalog/products@1 --consumer=tasks --env=prod    # writes fabrika/connect/catalog.products.v1.ts
bunx fabrika connect pull catalog/products@1 --consumer=tasks --env=prod   # refreshes it from what the owner approved now
```

The kit takes the snapshot, and an endpoint that calls it declares `connect`:

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { catalogProductsV1 } from '../fabrika/connect/catalog.products.v1'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables, {
	imports: { catalog: { snapshot: catalogProductsV1, procedures: ['get'] } },
})
```

```ts src/products/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const BySku = z.strictObject({
	orgId: z.string().min(1).max(100),
	sku: z.string().min(1).max(64),
})
const ProductName = z.strictObject({
	name: z.nullable(z.string()),
	status: z.enum(['found', 'missing', 'unavailable']),
})

export const products = app.group({ callers: ['human'] }, (r) => ({
	name: r.query({
		input: BySku,
		output: ProductName,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
		connect: ['catalog'],
	})
		.handle(async ({ input, ctx }) => {
			const product = await ctx.connect.catalog.get({ sku: input.sku })
			if (product.outcome !== 'ok') return { name: null, status: 'unavailable' }
			return product.value === null
				? { name: null, status: 'missing' }
				: { name: product.value.name, status: 'found' }
		}),
}))
```

- A call never throws for the owner's answer and never becomes an HTTP error by itself: it resolves to an outcome,
  `ok`, `denied`, `invalid_input`, `unavailable`, `timeout` or `contract_violation`. Decide what each one answers, as
  the example does: a missing product and an unreachable owner are different answers.
- Exports are read-only and carry no per-user data. When the export you need does not exist, ask the owner
  application's maintainer. The platform writes `FABRIKA_CONNECT_*`; never read or set them.

The owner side is an export, mounted under `exports` in the contract. Its procedures run read-only for the consumer
applications it names:

```ts src/billing/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const ProjectCount = z.strictObject({ projects: z.int() })

export const projectCounts = app.export({
	version: 1,
	consumers: ['billing'],
	audience: 'any consumer user',
	procedures: (e) => ({
		count: e.query({
			output: ProjectCount,
			access: { action: 'tasks.read', over: 'org' },
		})
			.handle(async ({ ctx }) => ({
				projects: await ctx.db.within.projects.count(),
			})),
	}),
})
```

Change a published export only by adding to it (a new procedure, a new optional input field) or by a new version
served beside the old one.
