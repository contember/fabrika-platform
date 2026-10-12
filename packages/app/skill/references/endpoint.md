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
- `count({ where })` answers a number. `aggregate({ groupBy, count, sum, min, max })` answers rows whose `count` and
  `sum_<column>` are strings (Postgres `bigint`): convert them with `Number(…)`.

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
				where t.org_id = ${ctx.target.value}
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

- Every `${…}` is a bound parameter, never SQL text. Do not put one inside quotes or a comment.
- **Scope the statement yourself**: `ctx.sql` has no scope predicate. Bind the capability's value
  (`where t.org_id = ${ctx.target.value}`); the generated tests check that an `in` endpoint with `sql` leaks nothing
  of another scope.
- Rows are parsed like `fromRow` (snake_case to camelCase), then by the schema. Postgres sends `count(*)` and `sum`
  as text: cast them (`::int`), or the row is refused.
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
  `null` unless the dimension opts in with `directory: 'labels'`, which widens like any other access change.
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
