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

---

# references/app-setup.md — the repository of an application

An application is the root of its own repository: Zerops reads `zerops.yaml` there. In the fabrika-platform
repository an example is a workspace under `examples/<name>/`, laid out the same way.

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
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { projects, tasks, comments, reports, members }),
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
  on Zerops), `c.form(path, { input, appendTo })` (an anonymous form that appends one row and runs no handler), a
  webhook, a link mount. Sections: `files`, `jobs`, `exports`, `csp`. No path under `/__fabrika`.
- `src/app.ts` composes and does nothing else. A dependency built from the application's own variables is
  `defineDeps(build)`, passed as `serve(contract, { database, deps })` and read in a handler with `get()`. Never read
  `process.env`.

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

## The SPA

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

export const Task = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	title: z.string(),
	status: TaskStatus,
	assignee: z.nullable(z.string()),
	dueOn: z.nullable(z.iso.date()),
	overdue: z.boolean(),
	version: z.int(),
})
export const TaskPage = z.strictObject({
	items: z.array(Task),
	next: z.nullable(z.string()),
})
export const ListTasks = z.strictObject({
	projectId: z.uuid(),
	status: TaskStatus.optional(),
	after: Cursor.optional(),
})
export const MyTasks = z.strictObject({ after: Cursor.optional() })
export const NewTask = z.strictObject({
	projectId: z.uuid(),
	title: z.string().min(1).max(200),
	dueOn: z.iso.date().optional(),
})
export const EditTask = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.string().min(1).max(200),
	dueOn: z.nullable(z.iso.date()),
})
export const AssignTask = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	assignee: z.nullable(z.string().max(100)),
})
export const OrgInput = z.strictObject({ orgId: z.string().min(1).max(100) })
```

- `z` comes from `zod/v4`. Objects are `z.strictObject`, never `z.object`. No `transform`, `refine`, `pipe`,
  `preprocess`, `passthrough`, `lazy` or `custom`: the shell is read without running it.
- A schema module holds literal consts only. An endpoint module may declare its own consts too.
- `z.iso.datetime()` takes UTC (`…Z`) only; `z.iso.date()` is `YYYY-MM-DD`.
- An edit endpoint takes every field it sets as required. An update that sets no column is a 500, and the generated
  tests send no optional field.

## The access forms and their handles

| Access                                         | Use it for                        | `ctx.db` (query)                                            | adds in a mutation                                                                          |
| ---------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{ action, on: 'task', from: 'id' }`           | one object by id; 404 otherwise   | `target.get()`; a child table's `list`, `get`               | `getForUpdate()`, `update(v, { expectVersion })`, `remove({ expectVersion })`; child writes |
| `{ action, in: 'project', from: 'projectId' }` | a container; 403 when not held    | `target.get()` (the container's row); `target.<table>.list` | `target.<table>.insert(v)`                                                                  |
| `{ action, over: 'org' }`                      | a list across the caller's scopes | `within.<table>.list`, `.count`, `.aggregate`               | — (a list write: `sql` or `unscoped`)                                                       |
| `{ action, creates: 'org' }`                   | a new top-level scope from IAM    | —                                                           | `created.<table>.insert(v)`                                                                 |
| `{ member: true }`                             | any member, no application data   | nothing                                                     | nothing                                                                                     |

- Every endpoint also has `ctx.db.reference.<table>` (reference tables), `ctx.principal` (`{ kind: 'user', id, label }`
  for a `human` caller) and `ctx.requestId`.
- `ctx.target` is the capability (a `Ref`); its id is `ctx.target.value`. `ctx.within` is the `over` capability.
- `over` reaches every table whose chain holds the dimension: `over: 'org'` lists tasks two levels down.
- A capability reads its own target, whatever its action: `tasks.assign` reads the task it assigns. A column with
  its own read action is left out for every other action.
- Never use `{ member: true }` for application data. `callers` is `['human']`, `['machine']` or both; every group of
  one mount names the same callers.

## Lists

- `list({ where, orderBy, limit, after })` answers `{ items, next }`: a keyset page of at most `limit` rows (50 by
  default, 500 at most). Pass `next` back as `after`; it is `null` on the last page.
- `where` is AND of `[column, operator, value]`: `=`, `<>`, `<`, `<=`, `>`, `>=`, `in` and `not in` (a list),
  `like`, `ilike`, `not like`, `not ilike`, `contains`. An optional filter is a conditional list:
  `where: input.status === undefined ? [] : [['status', '=', input.status]]`. There is no `is null` and no OR:
  write that in `ctx.sql`.
- `orderBy` is `[[column, 'asc' | 'desc']]`; the key is added last as the tiebreak.
- `count({ where })` answers a number. `aggregate({ groupBy, count, sum, min, max })` answers rows whose `count` is a
  string (Postgres `bigint`): convert it with `Number(…)`. `sum_<column>` is text for an integer or `numeric` column,
  a number for a floating-point one, and `null` over no rows; `min_`/`max_` are `null` over no rows too.

## Business rules: `logic.ts`

```ts src/tasks/logic.ts
export const canClose = (status: 'open' | 'doing' | 'done'): boolean =>
	status === 'doing'
```

`logic.ts` takes and answers plain values: no `ctx`, no handle, no row it was not given. Test it without a database.

## A slice of its own

```ts src/projects/endpoints.ts
import { fromRow } from '@fabrika/app'
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
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.projects.list({
				orderBy: [['name', 'asc']],
				after: input.after,
			})
			return {
				items: page.items.map((row) => fromRow(Project, row)),
				next: page.next,
			}
		}),
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
import { fromRow } from '@fabrika/app'
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
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.task_comments.list({
				orderBy: [['created_at', 'asc']],
				after: input.after,
			})
			return {
				items: page.items.map((row) => fromRow(Comment, row)),
				next: page.next,
			}
		}),
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

Mount every group in `fabrika.contract.ts`: `api: c.rpc('/api', { projects, tasks, comments, reports, members })`.
A procedure is served at `POST /api/<group>.<endpoint>`.

## Rows and outputs

- `fromRow(Schema, row)` turns snake_case columns into the schema's camelCase fields, a `Date` into ISO text, drops a
  column the schema does not declare, and parses the rest.
- `RowOf<typeof tables, '<table>'>` (`@fabrika/db/tables`) is the row a table's read action reads, for a function that
  takes one: `const toTask = (row: RowOf<typeof tables, 'tasks'>) => fromRow(Task, row)`.

## Shared data access: `queries.ts`

A function of the slice's `queries.ts` takes the handle as a parameter typed with `DbHandle` and returns plain values.
It decides no authorization: the capability already bounds the handle.

```ts src/reports/queries.ts
import type { DbHandle } from '@fabrika/app/contract'
import type { app } from '../app-kit'

export const statusCounts = async (
	within: DbHandle<typeof app, 'over', 'org', 'tasks.read'>,
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
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { OrgInput, TaskStatus } from '../schemas'
import { statusCounts } from './queries'

const Workload = z.strictObject({
	orgId: z.string().min(1).max(100),
	status: TaskStatus.optional(),
})
const WorkloadRow = z.strictObject({
	assignee: z.nullable(z.string()),
	open: z.int(),
	overdue: z.int(),
})
const WorkloadReport = z.strictObject({ rows: z.array(WorkloadRow) })
const Counts = z.strictObject({ open: z.int(), doing: z.int(), done: z.int() })

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
		input: OrgInput,
		output: Counts,
		access: { action: 'tasks.read', over: 'org' },
	})
		.handle(({ ctx }) => statusCounts(ctx.db.within)),
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
  by every scope and needs no fragment.
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

## Rows outside the capability: `unscoped`

`unscoped: { tasks: 'read' }` gives `ctx.db.unscoped.tasks` with no scope predicate (every org), still guarded and in
the invocation's transaction. `'write'` (a mutation, a job, a webhook) also inserts, updates and removes; an insert
then names the chain columns itself. Use it for an operator's cross-scope view, never to dodge a capability the caller
should hold. The generated tests skip the other-scope leak case for such an endpoint.

## Members

An endpoint `on` or `in` a dimension with `members` gets `ctx.members`:

- with the dimension's `members.list` action: the read-only directory `ctx.members.list()`, answering
  `{ principalId, label, roles, disabled }` per member, for an assignee picker or a membership check. `label` is
  `null` unless the caller also holds `members.manage` there, or the dimension opts in with `directory: 'labels'`,
  which widens like any other access change.
- with its `members.manage` action: `list(ref)`, `assign(ref, { email } | { principalId }, role)` and
  `revoke(ref, …)`, one change per request (see "Not built yet" in `SKILL.md`).

```ts src/members/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { OrgInput } from '../schemas'

const Member = z.strictObject({
	principalId: z.string(),
	label: z.nullable(z.string()),
})
const Members = z.strictObject({ items: z.array(Member) })

export const members = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: OrgInput,
		output: Members,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
	})
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list()).map((member) => ({
				principalId: member.principalId,
				label: member.label,
			})),
		})),
}))
```

IAM answers the directory, so do the data work first and call `ctx.members` after it.

---

# references/errors.md — what the checker, the compiler and the runtime tell you

## The checker: refusals and hints

`bunx fabrika-check .` prints one finding per line, `<file>:<line>:<col> <rule> <what> (allowed form: <fix>)`.
Refusals come first and fail the check; hints follow under their own heading and do not. Fix both: a hint is the
architecture, and a refusal's allowed form is the one fix that passes. There is no suppression syntax.

The refusals agents meet most, and their fix:

| Rule                  | Means                                                                                                                | Fix                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `literal`             | the shell (contract, vocabulary, tables, groups, schemas) holds a computed value or call                             | literal objects, `z.*` calls and imported literal consts; move logic into `.handle(…)` |
| `contract`            | the contract does not compile (a reserved role, an unknown action, a wrong field)                                    | the message names the field                                                            |
| `package-replacement` | `package.json` names the app under `@fabrika/*`, or a dependency is `workspace:*`                                    | another name; a registry range such as `^0.0.4`                                        |
| `generated-test-hash` | a generated test is missing, edited or stale                                                                         | `bunx fabrika db test-scaffold`, and commit what it writes                             |
| `endpoint-fixture`    | an endpoint's input cannot be sampled, or a fixture or seed names no endpoint                                        | a literal in `src/__tests__/endpoint-access.fixtures.ts` (`references/tests.md`)       |
| `raw-sql`             | a driver's `sql` (imported from `bun`, Kysely, `postgres`)                                                           | the handles, or `sql: 'read'` and `ctx.sql`                                            |
| `forbidden-import`    | a driver, an S3 client, `jose`, `node:http`, `child_process`                                                         | the handles, a file collection, a connector                                            |
| `forbidden-global`    | `Bun.sql`, `Bun.serve`, `Bun.spawn`; `globalThis`, `window`, `self`, `global` or `Bun` as a value in a server module | the handles; state lives in a table, not in a global                                   |
| `env-read`            | `process.env`, `Bun.env`                                                                                             | `defineDeps(build)`, which receives the application's variables                        |
| `client-identity`     | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId`                                           | the access form's `from`, `ctx.principal.id`, or `createdBy` in the policy             |
| `type-assertion`      | `as T` (other than `as const`), `<T>x`                                                                               | fix the type; `fromRow` parses a row into a schema's type                              |
| `sensitive-log`       | a log of an error object, a request, headers or the environment                                                      | log a short fixed message                                                              |
| `migration-name`      | a migration not named `YYYYMMDDHHMMSS_slug.sql` (UTC)                                                                | `bunx fabrika db new <slug>`                                                           |
| `test-only-import`    | `@fabrika/app/testing` or `@fabrika/db/testing` outside a test file                                                  | import them only from `*.test.ts` or `__tests__/`                                      |
| `spa-server-import`   | the SPA loads a server module                                                                                        | the SPA imports `@fabrika/app/client`, the contract and `src/schemas.ts` only          |
| `skipped-test`        | `.skip`, `.only`, `.todo`                                                                                            | run the test                                                                           |

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

| The compiler says                                                                   | Fix                                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `add .handle(…) to tasks.get: every endpoint takes its handler beside it`           | add the handler; when the handler exists, fix the error inside it first |
| `the handler returns version, which the output does not declare`                    | return only the output's fields                                         |
| `… where the output is camelCase: map it with fromRow(Schema, row)`                 | `fromRow(Schema, row)`                                                  |
| `update on tasks needs the action 'tasks.write', and this endpoint holds '…'`       | the endpoint's action, a column write action, or a separate endpoint    |
| `getForUpdate locks the row, so it runs only in a mutation`                         | `r.mutation`                                                            |
| `update acts on one object: declare access with on`                                 | access `on`, not `in` or `over`                                         |
| `tasks is not under in: 'org' (it lies in project): declare …`                      | the access form the message names                                       |
| `ctx.sql needs a declaration: add sql: 'read' …`                                    | declare `sql` on the endpoint                                           |
| `tasks is outside this site's scope: declare unscoped: { tasks: 'read' } on it`     | declare it, or use the capability's handles                             |
| `a job writes inside ctx.transaction((tx) => …): use tx.db there`                   | move the write into the transaction                                     |
| `ctx.members needs the action '…' (lists the members of org) or '…' (manages them)` | the dimension's `members.list` or `members.manage` action               |
| `admin is a role IAM defines itself for every application (reserved: admin)`        | another role name                                                       |
| `Property 'id' does not exist on type 'Ref<…>'`                                     | `ctx.target.value`                                                      |
| `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`             | the column has its own read action, which this capability lacks         |
| `Type 'Date' is not assignable to type 'string'` on a `date` column                 | a `YYYY-MM-DD` string                                                   |
| `Cannot find module '@fabrika/…'` and implicit `any`s everywhere                    | `bun install` (at the repository root in a monorepo)                    |

## Runtime answers

| Answer | Comes from                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | the input does not match its schema; `BadRequestError`                                                                                                                                          |
| 401    | no valid credential. In a test, the caller is missing                                                                                                                                           |
| 403    | the caller lacks the action, or for `in` the scope: a missing grant, never a bug to code around                                                                                                 |
| 404    | `on`: the object does not exist or is not the caller's; `NotFoundError`                                                                                                                         |
| 409    | a stale `expectVersion`; `ConflictError`; a lost `getForUpdate` race                                                                                                                            |
| 500    | a throw without a numeric `httpStatus` below 500, a `type` and a `message`, a refused statement, an update that sets no column, a `ctx.sql` row the schema refuses (`count(*)` without `::int`) |
| 503    | IAM cannot be asked, or the member directory has no transport                                                                                                                                   |

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
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { projects, tasks, comments, reports, members }),
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

| Endpoint                                     | Access                      | Does                                                      |
| -------------------------------------------- | --------------------------- | --------------------------------------------------------- |
| `POST /api/files.attachments.upload/:taskId` | `write` on the task         | the body is the file, `?name=` its name; answers `{ id }` |
| `GET /api/files.attachments/:fileId`         | `read` on the file's task   | streams the file                                          |
| `POST /api/files.attachments.remove`         | `delete` on the file's task | body `{ id }`                                             |

A file reaches what its task reaches, now: a moved task moves its files. There is no list endpoint yet; keep the file
ids you need in your own table or show the upload's answer.

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
	status TEXT NOT NULL CHECK (status IN ('pending', 'live')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	FOREIGN KEY (owner_id, project_id, org_id) REFERENCES tasks (id, project_id, org_id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
```

- The owner table needs `UNIQUE (<key>, <chain columns>)`; `tasks` has `UNIQUE (id, project_id, org_id)`.
- Codegen leaves the table out, and no policy names it: only the framework reads it.
- The name is lowercase snake_case, at most 39 characters. `link: true` is not built.

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

/** Marks every open task past its due day, hourly. A retried attempt lists again, so it marks no task twice. */
export const markOverdue = app.cron('15 * * * *', {
	actions: ['tasks.read', 'tasks.write'],
	scope: 'app',
	timeout: '10m',
	retries: 2,
})
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const tasks = ctx.db.over(ctx.within('tasks.read', 'org')).tasks
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
				await ctx.transaction((tx) =>
					tx.db.on(ref).update({ overdue: true }, { expectVersion: task.version })
				)
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { markOverdue } from './src/overdue/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { projects, tasks, comments, reports, members }),
	jobs: { markOverdue },
	health: c.health('/healthz'),
}))
```

- The schedule is five cron fields, UTC. `scope: 'app'` is the only scope: a job reaches every value.
- A job holds exactly its `actions`. `ctx.within(action, dimension)` is a `Within` of every value;
  `ctx.ref(action, dimension, id)` locates one object (404 when it is gone). Bind them with `ctx.db.over(within)`,
  `ctx.db.in(ref)` and `ctx.db.on(ref)`.
- **Reads run outside the transaction; every write runs inside `ctx.transaction((tx) => …)`**, through `tx.db`, fenced
  by the attempt's lease. A write outside it is a type error that names `tx.db`.
- An attempt that fails or outlives `timeout` (default 15 minutes) is retried up to `retries` times, so every write is
  idempotent: re-read the state, and use `expectVersion`, as above.
- A bulk write declares `sql: 'write'` on the job and runs `tx.sql` inside the transaction:

  ``ctx.transaction((tx) => tx.sql(Marked)`update tasks set overdue = true, version = version + 1 where (…) and ${tx.sql.scope(within, 'tasks')} returning id`)``

  `within` is the `Within` the job minted (`ctx.within('tasks.write', 'org')`). The version bump is yours to write.
- `bun test --isolate` runs a job with `kit.runJob('markOverdue')` (`references/tests.md`). The platform runs
  `fabrika job run <name>` from the crontab it generates; never write a crontab or read `FABRIKA_JOB_*`.
- A job cannot create scopes, manage members or issue share links.

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
- A **membership role** (`member: { scope, assignableBy }`) is granted in one value of `scope`.
  `members: { manage, list }` on a dimension gives `ctx.members` to endpoints of those actions
  (`references/endpoint.md`).
- `admin` is reserved: IAM defines it for every application. `defineVocabulary` refuses it.
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
		columns: { assignee: { write: 'tasks.assign' } },
	},
	task_comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['body'],
		createdBy: 'created_by',
	},
})
```

- Every table has a policy. Its scope is one of: `{ dimension: '<d>' }` (the table owns the dimension's values),
  `{ child: '<table>' }` (rows that belong to one row of the parent), or `{ reference: '<why>' }` (shared rows every
  endpoint reads and none writes).
- The key (`id`), the container column (`<container>_id`), a child's column (`<parent dimension>_id`) and the chain
  are derived. State `in: { column }` or `column` only off that convention.
- `actions` maps `read`, `insert`, `update` and `delete` to vocabulary actions. `insert` and `update` list the columns
  that those actions write; nothing else is writable.
- `columns: { <column>: { read: '<action>' } }` hides a column from every capability of another action, in the data
  and in the types. `columns: { <column>: { write: '<action>' } }` lets only that action update the column (and that
  action updates nothing else); the column is then not in `update`.

---

# references/tests.md — generated tests, seeds and your own tests

## The generated tests

`bunx fabrika db test-scaffold` writes them from the contract and the table policies, and deletes the ones it no
longer writes. Commit them; never edit, format or import them (`generated-test-hash`).

- `src/db/__tests__/<table>.policy-isolation.test.ts`: the data layer keeps each table's rows in their scope.
- `src/__tests__/endpoint-access.test.ts`: every `on` and `in` endpoint refuses another scope's object (404 or 403);
  every `on` and `over` endpoint, and every `in` endpoint that declares `sql`, answers nothing of another scope; a
  caller with only an endpoint's write action reaches its own object (200).

Run them after every change of the contract or the tables. The platform runs them at every start, and the
application is not ready until each passes. A failing generated test is a bug in the handler, the policy or the
fixtures, never in the test: do not loosen access to make it pass.

## Fixtures and seeds

`src/__tests__/endpoint-access.fixtures.ts` is yours, read statically (plain literals only):

```ts src/__tests__/endpoint-access.fixtures.ts
export const seeds = { 'api.tasks.close': { status: 'doing' } }
```

- `export const fixtures = { '<endpoint id>': { … } }` is an input for an endpoint whose schema the scaffold cannot
  sample, such as a `regex` or a webhook's bind:
  `{ 'webhooks.github.bind': { scope: 'acme', account: 'installation:1' } }`. The checker names each missing one,
  and one of an endpoint that does not exist (`endpoint-fixture`). The access form's `from` field is
  replaced by the seeded scope.
- `seeds['<endpoint id>']` is the state its precondition needs, written into the row of the table that owns the
  endpoint's dimension in both scopes: `close` answers 409 for an open task, so the seed makes it `doing`. A seed
  sets neither a column that places the row nor a text column.
- The endpoint id is `<mount>.<group>.<endpoint>` (`api.tasks.close`).
- The seed of the tests fills every text column with a marker and every other required column with a sample of its
  type. A `CHECK` on a text column fails those rows: use an `ENUM` type. A required foreign key outside the
  containment chain cannot be filled: give it a default or make it nullable.

## Your own tests

Test the rules of `logic.ts` as plain functions. Test a handler through `testKit` and the typed client, with each
allowed call beside its refused twin:

```ts src/tasks/__tests__/tasks.test.ts
import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'tasks.test.ts',
})

const statusOf = async (
	call: Promise<unknown>,
): Promise<number | undefined> => {
	try {
		await call
		return 200
	} catch (error) {
		return error instanceof RpcError ? error.httpStatus : undefined
	}
}

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const inAcme = (role: 'owner' | 'member') =>
		kit.testCaller([{ role, scope: { type: 'org', value: 'acme' } }])
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

- `testDatabase` migrates a throwaway schema; without `FABRIKA_TEST_POSTGRES_URL` it answers `null` and the file
  registers no test. A skip proves nothing: run with the variable set.
- `kit.testCaller(grants, { kind })` makes a caller: a grant is a role or an action, in one scope or global. `kind:
  'machine'` presents a `px_` key (`createClient(contract, 'api', { fetch: kit.fetch, key: caller.key })`).
- A member directory (`ctx.members.list()`) answers from the kit's own callers: everyone `testCaller` gave a
  membership role in that scope, labels only where the dimension declares `directory: 'labels'` (or to a
  `members.manage` holder). To list someone, make them a caller:
  `kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'acme' } }])`. For share links, `creates` or member
  management, pass your own `IamMembershipRpc` as `testKit(app, { membership })`; without one `boot` names it.
- `kit.runJob('<job>')` runs a cron job once and answers `{ status: 'succeeded', attempts }`.
- An application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to `testKit`.
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
