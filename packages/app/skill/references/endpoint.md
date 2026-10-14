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
  (`{ kind: 'user', id, label, email }` for a `human` caller) and `ctx.requestId`. An `on`, `in` or `over` endpoint
  also reads `ctx.db.app.<table>`: each application table whose read action is the endpoint's action, every row,
  read-only (below).
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
  each operation's own action, and every scoped table, read-only and every row: `list`, `count` and `aggregate` where
  the endpoint's action is its read action or one its policy names in `actions.appRead`, with the columns of that
  action (a column whose own read action is another is left out, as for a `Ref`), and only `count({ where })` where it
  is one of `actions.appCount`. `ctx.app` is the capability.
- So an export, a bulk send or an operations counter runs under an action of its own, not the read action: the table
  names it (`appRead: ['candidates.export']`, `appCount: ['candidates.count']`), and a global holder of only the read
  action gets 403 from that endpoint. An `appCount` action has no `aggregate`: a group, a minimum or a sum is a row's
  value. Count each value of a known set with its own `where` (`count({ where: [['status', '=', status]] })`).
- An endpoint `on`, `in` or `over` a dimension reads an application table too, read-only and every row, where its
  action is the table's read action: `list`, `count`, `aggregate` and `get(id)` of `ctx.db.app.<table>`, and no write.
  With another action the table is a type error that names its read action, and a refusal at run time. So a code list
  an administrator edits is validated by reading it: an unknown or retired value answers `BadRequestError` (400) that
  names it (`decide` in `references/public-intake.md`), not a foreign key's 500.
- An audited export of every record is one `app` mutation of its own action, which the records' policy names in
  `appRead`: it lists the records through `ctx.db.app.<table>` and inserts its log row into an application table whose
  insert action is the export's action (`references/public-intake.md`). It needs no `sql` and no `unscoped`.
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
| `app.<table>` (`app: true`), a scoped table            | `list(options)` (read action or `appRead`), `count({ where })` (also `appCount`), `aggregate(spec)`                                                                                             |
| `app.<table>` (`on`, `in`, `over`)                     | an application table whose read action is the endpoint's: `list(options)`, `count({ where })`, `aggregate(spec)`, `get(id)`; no write                                                           |
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
  `Within` it minted to `tx.sql.scope`. A table the capability does not reach is a type error at the table name. A
  reference table is shared by every scope and needs no fragment, and no statement writes it. A form's inbox needs none either; read it from a site that holds the inbox's
  `read` action (the intake job of `references/public-intake.md`).
- **A fragment carries its action into the statement.** On the table an `update` or `delete` writes it needs the
  table's own update or delete action (`ctx.within('tasks.write', 'project')` for `update tasks`), so a read action
  never scopes a write; anywhere else it needs an action the handles read the table with. `insert … on conflict do
  update … where ${…}` is an update of the inserted table. The fragment answers for its own query block: a CTE that
  updates and a statement that deletes take one capability each, and another occurrence of the written table (a
  subquery, `from tasks other`) reads with a read capability under its own alias. A refused fragment fails the call
  before anything is sent.
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
