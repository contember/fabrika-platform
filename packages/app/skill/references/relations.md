# references/relations.md — relation grants and conditions

A relation gives a role its actions at the nodes where a row of the application names the person: "the assistants of
this project, until their assignment ends". A condition (`when`) narrows an action to the rows it admits: "no task is
written in a project past its end". Both are declarations the approver reads; the data layer applies them to every
statement. This file is an application of its own (`tasks` with assistants); its `package.json`, `tsconfig.json`,
`src/app-kit.ts`, `src/app.ts` and `src/schemas.ts` are those of `app-setup.md` and `endpoint.md`.

Ask the human before you add a relation, a role's `via`, a table's `confers` or its `assign`: each lets someone reach
more, and the approver sees each as a widening. A `when` only narrows; removing or changing one widens. They need
`@fabrika/app` `0.9.0-dev.13` or later: Control refuses to publish them for an application pinned to an earlier release.

## The vocabulary: a relation and a role's `via`

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
		'tasks.read': 'Read projects and tasks',
		'tasks.write': 'Create projects and tasks, and finish tasks',
		'assistants.assign': 'Assign an assistant to a project',
		'members.manage': 'Invite and remove members',
	},
	relations: {
		assisting: { dimension: 'project' },
	},
	roles: {
		owner: {
			grants: ['tasks.read', 'tasks.write', 'assistants.assign', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
		coordinator: {
			grants: ['tasks.read', 'assistants.assign'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
		assistant: {
			grants: [],
			via: { assisting: ['tasks.read', 'tasks.write'] },
		},
	},
})
```

- `relations: { <name>: { dimension } }` names a relation and the dimension of the node its rows name.
- `via: { <relation>: [<action>, …] }` on a role: a holder of the role holds those actions at each node where a source
  row names them, and nowhere else. Its `grants` still hold globally, so an assistant's are empty.
- `via` is only for a global, internal role without `member`: IAM grants `assistant` application-wide (an operator,
  in IAM's console), and the rows say where it applies. A grant of the role in a scope value carries no relation, so
  the proxy refuses its holder (403). A person from outside the organization (`external: true`) holds no relation.
- The token says only that the role holds those actions through `assisting`. The data layer reads the source rows on
  every statement, so an inserted row grants at the next request and a deleted one stops access at the next request.
  Nothing caches it.
- A principal a row names reaches nothing unless IAM grants it a role whose `via` names the relation.

## The migration

```sql db/migrations/20261104090000_assistants.sql
CREATE TABLE projects (
	id UUID PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	ends_at TIMESTAMPTZ,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, org_id)
);
CREATE INDEX projects_org ON projects (org_id);

-- A condition's path follows a single-column foreign key: project_id carries one beside the composite key.
CREATE TABLE tasks (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects (id),
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	done BOOLEAN NOT NULL DEFAULT false,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE
);
CREATE INDEX tasks_project ON tasks (project_id);

-- A relation source: each row names one principal at one project until it expires.
CREATE TABLE project_assistants (
	id UUID PRIMARY KEY,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	created_by TEXT NOT NULL,
	FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX project_assistants_principal ON project_assistants (principal_id, project_id);
```

- A source table is an ordinary child or dimension table with a principal column (`TEXT`, an IAM principal id), the
  node column (by default the table's column of the relation's dimension: `project_id`) and, for a bounded
  delegation, an expiry (`TIMESTAMPTZ NOT NULL`).
- Give it an index on `(principal, node)`. Every statement under the relation runs
  `node in (select node from <source> where principal = $me …)`, and nothing creates the index for you.
- After the migration run `fabrika db migrate` and `fabrika db codegen` (on Cloudflare `codegen` only): the policies
  below read the generated `columns`, its foreign keys and which columns are `NOT NULL`.

## The policies

```ts src/db/tables.ts
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['name', 'ends_at'],
		version: 'version',
		createdBy: 'created_by',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['title'],
		update: ['done'],
		version: 'version',
		createdBy: 'created_by',
		when: {
			'tasks.write': {
				anyOf: [
					{ 'project_id.ends_at': { isNull: true } },
					{ 'project_id.ends_at': { gt: { now: true } } },
				],
			},
		},
	},
	project_assistants: {
		scope: { child: 'projects' },
		actions: {
			read: 'tasks.read',
			insert: 'assistants.assign',
			delete: 'assistants.assign',
		},
		insert: ['principal_id', 'expires_at'],
		createdBy: 'created_by',
		confers: {
			assisting: {
				principal: 'principal_id',
				expires: 'expires_at',
				assign: { maxDays: 30 },
			},
		},
	},
})
```

### `confers`: the rows that grant a relation

- `confers: { <relation>: { principal, node?, expires?, when?, assign? } }`. `node` defaults to the table's column of
  the relation's dimension. A row confers nothing once `expires` passed, nor while its own `when` does not admit it.
  A source's `when` never reads its `version`. It may follow one foreign key to the row the source names, such as
  `{ 'person_id.active': { eq: true } }`, the far side of a many-to-many table: no update of that table may write the
  column it tests, and the table is no view, queue or top-level dimension table. It takes no second foreign key and no
  `some`. That table joins the source table among those `ctx.sql` of a writing endpoint never names, so a writing
  statement that already names it fails at run time once the condition is added: move that write to `ctx.db` first.
- Inserting a row is delegation: the coordinator gives the assistant `tasks.read` and `tasks.write` without holding
  `tasks.write` itself. The insert's own action (`assistants.assign`) decides who may write it, and the layer bounds
  what it gives instead:
  - the node is stamped from the writer's `Ref`, so a coordinator delegates only in a project it reaches;
  - `assign.maxDays` caps the expiry; a later or a missing expiry is a 409, and `maxDays` needs `expires`;
  - a row naming its writer is a 409 unless `assign.self: true` allows it. `principal` may name the table's
    `createdBy`: then every row names its writer at the row's node. On `projects`, a relation at `project` makes a
    creator hold it at that project, and one at `org` at the project's org; on a child table such as
    `project_assistants` the writer holds it at the parent project, not at the row. So a table with an insert states
    `assign: { self: true }`, and the policy is refused without it;
  - a table that confers without `assign` takes no insert.
- `principal` may be read through one foreign key, `'<column>.<principal column>'`: `principal: 'person_id.principal_id'`
  on a staff row that names a person of a directory table, whose own row holds the principal id. `<column>` needs a
  single-column `REFERENCES <table> (id)` to the key of a contained dimension, child or application table (no view, no
  queue table, no top-level dimension), and is not the source's own key, version, file or containment column (an
  `org_id` a move rewrites). No other foreign key holds that column, but a composite one to the same row, such as
  `(person_id, org_id) REFERENCES people (id, org_id)`, and the referenced table's key references nothing. No update of that table may write the principal column, so a person row is replaced, never edited:
  deleting it, or the source row, ends the access at the next request. A row whose person names its writer is a 409
  without `assign.self`, as above. The foreign key needs only the referenced table's key, not a key that holds the
  tenant: a writer may name a person of another organization, which gives no more than naming that principal id
  directly. Index the referenced table on `(principal column, id)` too.
- A column that holds a principal, on the source or on the table a path reads, has no `REFERENCES`: a key that
  cascades on update would change whom every row names.
- A source row never moves, and no update writes its principal, node, expiry or a column its `when` reads. Change an
  assignment by deleting the row and inserting a new one. `ctx.sql` of a writing endpoint never names a source table,
  `unscoped` never writes one, and a queue table confers nothing.

### `when`: a condition narrows an action

- `when: { <action>: <condition> }` is ANDed onto every grant of that action on the table: global, IAM-scoped and
  through a relation alike. The owner cannot add a task to a project past its end either. A row the condition does
  not admit is not there for that action: a read or an update `on` it is 404, a list leaves it out, and an insert
  it refuses is a 409 with nothing written.
- A condition is data, never SQL: `{ <column>: { <operator>: <value> } }` with `eq`, `notEq`, `in`, `notIn`,
  `isNull`, `lt`, `lte`, `gt` and `gte`; several columns in one object must all hold; `allOf`, `anyOf` and `not` stand
  alone in their object. `{ now: true }` is the statement's clock (`{ gt: { now: true } }`), never the text `now`. A
  JSON column is never compared: extract the value into a typed column.
- A path follows foreign keys: `'project_id.ends_at'` reads the task's project. The column needs a single-column
  `REFERENCES <table> (id)`, and the hop must stay in the row's tenant: the row's own container or parent column, a
  key into a reference table, or a key that holds every ancestor the two tables share (below). A view's path starts at
  its parent column, which needs no foreign key.
- `{ some: { <table>: <condition> } }` holds when a row of `<table>` whose single-column foreign key names this row
  meets the condition, `none` when no such row does: on `projects`, `{ some: { tasks: { done: { eq: false } } } }` is
  a project with an open task. The rows' foreign key is held like a path's hop, so it keeps to the row's tenant, and
  a key into a reference table is not followed back: `{ tag_id: { some: { project_tags: … } } }` would count every
  tenant's rows that name the tag, so the policy refuses it.
- A path may end in `some` or `none`: on `tasks`, `{ project_id: { some: { project_tags: { 'tag_id.name': { eq:
  'urgent' } } } } }` is a task of a project tagged urgent, through the link table `project_tags`. A `null` foreign key
  reaches no row, so neither `some` nor `none` holds there. A `some` nests in a `some`.
- A `not` follows a path only through columns declared `NOT NULL`, at any depth: on a null key the path's lookup
  would turn on rows of every tenant. `{ not: { 'client_id.active': { eq: true } } }` with a nullable `client_id` is
  refused and names the column: declare it `NOT NULL` in a migration and run `fabrika db codegen`, or say what a row
  without a client gets, `{ anyOf: [{ client_id: { isNull: true } }, { 'client_id.active': { eq: false } }] }`. Like
  the `not`, it leaves out a row whose client's `active` is null.
- A path follows at most three foreign keys, the path before a `some`, the `some` and every hop inside it counted
  together. Each hop is one more subquery in every statement of the action; shorten a longer path with a stored column.
- An insert's condition is judged on the written row. One with a path runs in the insert's transaction, every row on
  its paths locked `FOR SHARE` first, so nobody changes the project while the task goes in. An insert action's
  condition may end a path in `some` (`{ project_id: { some: … } }`), whose rows are locked too. It takes no `none`,
  no `some` under `not`, no `some` straight on the inserted row, and no `some` of the inserted table's own rows
  (`{ project_id: { some: { tasks: … } } }` on `tasks`): a row inserted meanwhile could make the first two false,
  nothing names the new row yet, and the last would count the new task itself, since the condition is judged after
  the write. An upsert's conflict update is judged on the stored row.

### A key that holds the tenant needs its ancestors NOT NULL

A path into another scoped table, other than the container or parent, and a `readThrough` follow a foreign key of
exactly the column and every ancestor the two tables share, `(team_id, org_id) REFERENCES teams (id, org_id)`, beside
the column's single-column key. Each ancestor column of that key must be `NOT NULL`: under SQL's matching a null
`org_id` skips the whole key, so a row written with one could point at another org's team. A policy over a nullable
one is refused and names the column: add a migration that sets it `NOT NULL`, then run `fabrika db migrate` and
`fabrika db codegen`, which writes the `notNull` list the policy is checked against.

### `readThrough`, `reveals` and `memberReveals`

- `readThrough: { <dimension>: <column> }` lets a `Within` of a dimension outside the table's chain, or a relation at
  it, read the row through that column's tenant-holding key: a task in a project, read by the members of the team its
  `team_id` names. No update writes the column. When the key
  lives on the row's container, name the container's path from the row's own containment column:
  `readThrough: { team: 'task_id.team_id' }` on a task's comments. The container declares `readThrough.team` through
  a column of its own; the row follows it wherever the container's column points now. Such a table takes no reveal
  matched through that path: declare the reveal on the container.
- `writeThrough: { <dimension>: [<actions>] }` beside `readThrough` lets the path hold those actions for an `on` or `in`
  endpoint too, writes included: a member of the team a task names updates the task. A path holds reads only without
  it. Whoever inserts a row naming a team must hold every listed action at that team (a grant there or above it, or a
  relation row there), or the insert answers 409; so must the container's writer for the actions its rows' paths list.
  A job or a webhook holds nothing there. A `Ref` held through the path never moves a row, the table is never written
  `unscoped` or by `ctx.sql`, and `ctx.sql.scope` refuses such a `Ref`.
- `reveals: { <relation>: { to, actions, when? } }` on a table the relation reaches: such a row also gives the
  relation `actions` (those its roles name in `via`) at its ancestor node in `to` while `when` admits the row: an
  assignee of an open task reads its project. A reveal matched through `readThrough` on a table with an insert needs
  `assign: {}` (or `{ self: true }`), because the writer picks the node.
- `memberReveals: { <own dimension>: { to, actions, when? } }`: a grant at the row's own node holds `actions` at its
  ancestor in `to` too, while `when` admits the row: an `over` list reads through it, and an `on` or `in` endpoint of a
  listed action gets a `Ref` of the ancestor, writes included. A member of an open task renames its project; once the
  task closes, the next statement answers 404. Such a row is never written unscoped or by `ctx.sql`, and never moves.
  `ctx.sql.scope` refuses a `Ref` held this way: read it through `ctx.db`.
- `memberReveals` may also be keyed by a dimension the table reads through: `memberReveals: { team: { to: 'project',
  actions: ['projects.read'], assign: {} } }` on tasks that name a team in `readThrough.team`: a grant at that team
  reads the project of each open task naming it. A link row (a child of the task naming a team) reveals its task the
  same way. Through a path `to` is the row's nearest container, and a table with an insert states `assign`: without
  `self`, inserting a row that names a team where the writer holds one of the listed actions answers 409, and a job or
  a webhook names no team there. An `on` or `in` endpoint gets a `Ref` through it only for an action the path's
  `writeThrough` also lists.
- A view under a parent takes none of them: it is read through its parent row, so a relation, a reveal, a member
  reveal or a secondary path that reaches the parent reaches the view's rows of that parent.

## The endpoints

```ts src/projects/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Saved } from '../schemas'

const DAY_MS = 86_400_000
const NewProject = z.strictObject({
	orgId: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	endsAt: z.iso.datetime().optional(),
})
const Assign = z.strictObject({
	id: z.uuid(),
	assistant: z.string().min(1).max(200),
	days: z.int().min(1).max(30),
})
const Unassign = z.strictObject({ id: z.uuid(), assignment: z.uuid() })
const Assignment = z.strictObject({ id: z.uuid() })

export const projects = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: NewProject,
		output: Saved,
		access: { action: 'tasks.write', in: 'org', from: 'orgId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.projects.insert({
				name: input.name,
				ends_at: input.endsAt ?? null,
			})
		),
	assign: r.mutation({
		input: Assign,
		output: Assignment,
		access: { action: 'assistants.assign', on: 'project', from: 'id' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.project_assistants.insert({
				principal_id: input.assistant,
				expires_at: new Date(Date.now() + input.days * DAY_MS),
			})
		),
	unassign: r.mutation({
		input: Unassign,
		output: Assignment,
		access: { action: 'assistants.assign', on: 'project', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.project_assistants.remove(input.assignment)
			return { id: input.assignment }
		}),
}))
```

```ts src/tasks/endpoints.ts
import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Cursor, Saved, Versioned } from '../schemas'

const Task = z.strictObject({
	id: z.uuid(),
	title: z.string(),
	done: z.boolean(),
	version: z.int(),
})
const TaskPage = z.strictObject({
	items: z.array(Task),
	next: z.nullable(z.string()),
})
const ListTasks = z.strictObject({
	projectId: z.uuid(),
	after: Cursor.optional(),
})
const MyTasks = z.strictObject({ after: Cursor.optional() })
const NewTask = z.strictObject({
	projectId: z.uuid(),
	title: z.string().min(1).max(200),
})

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		input: ListTasks,
		output: TaskPage,
		access: { action: 'tasks.read', in: 'project', from: 'projectId' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Task,
				await ctx.db.target.tasks.list({
					orderBy: [['title', 'asc']],
					after: input.after,
				}),
			)
		),
	mine: r.query({
		input: MyTasks,
		output: TaskPage,
		access: { action: 'tasks.read', over: 'project' },
	})
		.handle(async ({ input, ctx }) =>
			fromPage(
				Task,
				await ctx.db.within.tasks.list({
					where: [['done', '=', false]],
					orderBy: [['title', 'asc']],
					after: input.after,
				}),
			)
		),
	create: r.mutation({
		input: NewTask,
		output: Saved,
		access: { action: 'tasks.write', in: 'project', from: 'projectId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.tasks.insert({ title: input.title })
		),
	finish: r.mutation({
		input: Versioned,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.update({ done: true }, {
				expectVersion: input.expectVersion,
			})
		),
}))
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { projects } from './src/projects/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { projects, tasks }),
	health: c.health('/healthz'),
}))
```

- The handlers know nothing of relations. An assistant's `on`, `in` and `over` calls reach a project and its tasks
  exactly while a row names it there. Elsewhere an `on` call is 404, an `in` call 403 and an `over` list leaves the
  project out, as for any caller without the action there.
- `assign` takes the assistant's principal id from the input: that is the person picked, never the caller. `days`
  stops at the policy's `maxDays`, so of the layer's bounds only the writer naming itself answers 409.

## Tests

Grant the role app-wide (`{ role: 'assistant' }`, no scope), as IAM does, and let the endpoints write the rows:

```ts src/__tests__/assistants.test.ts
import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'

const postgres = await testDatabase({
	migrations: new URL('../../db/migrations/', import.meta.url),
	label: 'assistants.test.ts',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const acme = kit.scope('org', 'acme')
	const assistant = kit.testCaller([{ role: 'assistant' }])
	const coordinator = kit.testCaller([{ role: 'coordinator', scope: acme }])
	const ownerApi = createClient(contract, 'api', {
		fetch: kit.browser(kit.testCaller([{ role: 'owner', scope: acme }])),
	})
	const coordinatorApi = createClient(contract, 'api', {
		fetch: kit.browser(coordinator),
	})
	const assistantApi = createClient(contract, 'api', {
		fetch: kit.browser(assistant),
	})

	describe('an assistant', () => {
		test('reaches a project only while a row names it there', async () => {
			const launch = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Launch',
			})
			const other = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Other',
			})
			expect(await statusOf(assistantApi.tasks.list({ projectId: launch.id })))
				.toBe(403)
			const assignment = await coordinatorApi.projects.assign({
				id: launch.id,
				assistant: assistant.id,
				days: 7,
			})
			const task = await assistantApi.tasks.create({
				projectId: launch.id,
				title: 'Brief',
			})
			expect((await assistantApi.tasks.mine({})).items.map((item) => item.id))
				.toEqual([task.id])
			expect(await assistantApi.tasks.finish({ id: task.id, expectVersion: 1 }))
				.toEqual({ id: task.id, version: 2 })
			expect(
				await statusOf(
					assistantApi.tasks.create({ projectId: other.id, title: 'No' }),
				),
			).toBe(403)
			await coordinatorApi.projects.unassign({
				id: launch.id,
				assignment: assignment.id,
			})
			expect(
				await statusOf(
					assistantApi.tasks.finish({ id: task.id, expectVersion: 2 }),
				),
			).toBe(404)
			expect((await assistantApi.tasks.mine({})).items).toEqual([])
		})

		test('a coordinator does not assign itself', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Self',
			})
			expect(
				await statusOf(coordinatorApi.projects.assign({
					id: project.id,
					assistant: coordinator.id,
					days: 1,
				})),
			).toBe(409)
		})

		test('a grant of the role in a scope value reaches nothing through the relation', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Scoped',
			})
			const scoped = kit.testCaller([{ role: 'assistant', scope: acme }])
			await coordinatorApi.projects.assign({
				id: project.id,
				assistant: scoped.id,
				days: 1,
			})
			const scopedApi = createClient(contract, 'api', {
				fetch: kit.browser(scoped),
			})
			expect(await statusOf(scopedApi.tasks.list({ projectId: project.id }))).toBe(
				403,
			)
		})
	})

	describe('a project past its end', () => {
		test('is read, and takes no new task from anyone', async () => {
			const ended = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Ended',
				endsAt: '2026-01-01T00:00:00Z',
			})
			await coordinatorApi.projects.assign({
				id: ended.id,
				assistant: assistant.id,
				days: 7,
			})
			expect((await assistantApi.tasks.list({ projectId: ended.id })).items)
				.toEqual([])
			expect(
				await statusOf(
					assistantApi.tasks.create({ projectId: ended.id, title: 'Late' }),
				),
			).toBe(409)
			expect(
				await statusOf(
					ownerApi.tasks.create({ projectId: ended.id, title: 'Late' }),
				),
			).toBe(409)
		})
	})
}
```

## Not built yet

- No widening condition (`admits`): a `when` only narrows. A row that some other rule should open to more people is
  reached by a grant, a relation or an off-road declaration, never by a condition.
- A relation holds only through a global grant of an internal role without `member`. A relation inside the node of a
  scoped grant, and a relation for a person from outside the organization, are not built.
- A view is never a relation source: write the source rows to a table, under `assign`.
- An assignment never changes in place: delete the row and insert a new one.
- No raw SQL and no JSON column in a condition, and no path longer than three foreign keys.
