# references/files.md — file kinds and file columns

A file is a value in a table column. The contract declares a file kind (`c.files`): which types, how large, whether it
is scanned. A table declares a file column of that kind, and the table's policy is the file's authority: reading the
column under the table's `read` action is what lets a procedure answer the file, and writing it needs the action that
writes the column. There are no generated file endpoints: each operation is a procedure of a few lines.

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { archive } from './src/archiving/endpoints'
import { attachments } from './src/attachments/endpoints'
import { comments } from './src/comments/endpoints'
import { erase } from './src/erasure/endpoints'
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
		attachments,
	}),
	files: {
		attachments: c.files({
			types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
			maxBytes: 5242880,
		}),
	},
	jobs: { archive, erase },
	health: c.health('/healthz'),
}))
```

The table that holds the files is a child of `tasks`, with a file column of the kind `attachments`:

```sql db/migrations/20261012100000_attachments.sql
CREATE TABLE task_attachments (
	id UUID PRIMARY KEY,
	task_id UUID NOT NULL,
	project_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	file UUID NOT NULL REFERENCES fabrika_files (id),
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (task_id, project_id, org_id) REFERENCES tasks (id, project_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX task_attachments_task ON task_attachments (task_id);
CREATE INDEX task_attachments_file ON task_attachments (file);
```

Its policy in `src/db/tables.ts` (`references/table-and-migration.md`) names the column and its kind:

```text
task_attachments: {
	scope: { child: 'tasks' },
	actions: { read: 'tasks.read', insert: 'tasks.write', delete: 'tasks.write' },
	insert: ['file'],
	files: { file: 'attachments' },
	createdBy: 'created_by',
},
```

- A file column is `UUID REFERENCES fabrika_files (id)` with an index on it; the checker's `file-column-migration`
  verifies both for every column the policy names in `files`. `fabrika_files` is the framework's table: never write
  it.
- A file kind (`c.files({ types, maxBytes, scan? })`) has no owner, no actions and no endpoint. The table's actions
  are the file's authority, and the approver reads "`tasks.write` writes `task_attachments.file` (attachments)".
- A file reaches what its row reaches, now: a moved task moves its files. Deleting the row (here with its task, by the
  cascade) or clearing a nullable column removes the reference; the framework's sweep deletes a file no column
  references.
- A file column takes only a file reference: an input file (`file('<kind>')`), a `ctx.files.put` of this request, or a
  reference this request read from a file column under that table's `read` action. A string id is refused.

```ts src/attachments/endpoints.ts
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Upload = z.strictObject({ taskId: z.uuid(), file: file('attachments') })
const OfTask = z.strictObject({ taskId: z.uuid() })
const OneFile = z.strictObject({ taskId: z.uuid(), id: z.uuid() })
const Saved = z.strictObject({ id: z.uuid() })
const Empty = z.strictObject({})
const Attachments = z.strictObject({
	items: z.array(z.strictObject({
		id: z.uuid(),
		name: z.nullable(z.string()),
		type: z.string(),
		size: z.int(),
		status: z.enum(['pending', 'quarantined', 'live', 'rejected']),
	})),
})

export const attachments = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: Upload,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'taskId' },
	})
		.handle(({ input, ctx }) =>
			ctx.db.target.task_attachments.insert({ file: input.file })
		),
	list: r.query({
		input: OfTask,
		output: Attachments,
		access: { action: 'tasks.read', on: 'task', from: 'taskId' },
	})
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.target.task_attachments.list()).items.map((row) => ({
				id: row.id,
				name: row.file.name,
				type: row.file.type,
				size: row.file.size,
				status: row.file.status,
			})),
		})),
	download: r.query({
		input: OneFile,
		output: file('attachments'),
		access: { action: 'tasks.read', on: 'task', from: 'taskId' },
	})
		.handle(async ({ input, ctx }) =>
			(await ctx.db.target.task_attachments.get(input.id)).file
		),
	remove: r.mutation({
		input: OneFile,
		output: Empty,
		access: { action: 'tasks.write', on: 'task', from: 'taskId' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.task_attachments.remove(input.id)
			return {}
		}),
}))
```

- An input field `file('<kind>')` of a mutation makes the body multipart; the file is bounded by the kind's `types`
  (sniffed, not trusted) and `maxBytes`. `z.optional(file(k))` is an optional file, `z.array(file(k)).max(n)` up to
  `n` files, each a top-level field; one request carries at most 20 files. The body limit grows by each file at its kind's `maxBytes`, up to 48
  MiB (`limits.maxBytes`, `references/endpoint.md`). The JSON `input` part takes up to that whole limit, and the
  input part and the files together never exceed it: a large input beside its files declares a `limits.maxBytes` that
  covers both. The handler writes the reference into the column, in its
  transaction; a rolled-back request keeps no file.
- A row read through the data layer carries a file reference in each file column, with `id`, `name`, `type`, `size`
  and `status`, so a list shows them without a call per file.
- A query whose output is `file('<kind>')` returns the reference, and the framework streams the file. It is a `GET`
  with its input in flat query parameters. A mutation with a file output is a `POST` that answers the file after its
  commit, so a download that writes an audit row is a mutation. The handler never returns a `Response`. A `pending`
  or `quarantined` file answers 409 `file_not_ready`, a `rejected` one 409 `file_rejected`, and one the sweep deleted
  404.
- A public image (a catalog picture in a page or an e-mail) is a public `GET` query with `http: { cache: 'immutable' }`
  whose input names the file as well as its row (`{ product, file }`), so a new image changes the URL. The handler
  refuses a file id that is not the row's.

The SPA calls them through the typed client, never a hand-written `fetch`. `api.attachments.download.url(input)` is
the URL of a `GET` file procedure for a same-origin page (`<img src>`, `<a download>`), and
`download(api.attachments.download, input)` of `@fabrika/app/client` fetches it with the caller's credential and
answers a file (`blob()`, `stream()`, `save()`).

```ts web/attachments.ts
import { createClient, RpcError } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'

const api = createClient(contract, 'api')

/** Uploads `file` to the task, then lists its files, each a link to its download. */
export const attach = async (
	taskId: string,
	file: File,
	list: HTMLElement,
): Promise<void> => {
	try {
		await api.attachments.upload({ taskId, file })
		const page = await api.attachments.list({ taskId })
		list.replaceChildren(
			...page.items.map((item) =>
				Object.assign(document.createElement('a'), {
					href: api.attachments.download.url({ taskId, id: item.id }),
					download: item.name ?? 'file',
					textContent: `${item.name ?? 'file'} (${item.status})`,
				})
			),
		)
	} catch (error) {
		list.textContent = error instanceof RpcError
			? `Refused: ${error.type}`
			: 'Failed'
	}
}
```

A link holder's client has a key, which never goes into a URL: a link page uses `download`. `ResultOf<typeof
api.tasks.get>` and `InputOf<typeof api.tasks.create>` of `@fabrika/app/client` name a procedure's answer and input for
a view that maps them.

## From a handler or a job: `ctx.files`

`ctx.files` of a mutation, a webhook, a job and a job's `tx` has two calls; a query's has `open` only:

| Call                                | Does                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `put(kind, bytes, { type, name? })` | stores a new file of the kind and answers its reference; it is pending until a column holds it |
| `open(ref, { maxBytes? })`          | `{ id, name, type, size, bytes }` of a live file, read whole                                   |

`open` takes a reference the site read from a file column under that table's `read` action. It answers 409
`file_not_ready` until the scan called the file clean, 409 `file_rejected` for a rejected one, and 413 for a file over
`maxBytes` (the kind's by default), before any byte is read. Pass the size you hold in memory.

A job reads each task's rows with a `Ref` it minted and opens each live file, here to hand it to an archive service of
`deps`. A file can also leave as an e-mail attachment (`attachments` of `ctx.mail.send`, `references/jobs.md`):

```ts src/archiving/endpoints.ts
import { app } from '../app-kit'
import { archiver } from '../archive'

/** The largest report the archive takes in one call: the kind's maxBytes. */
const REPORT_MAX_BYTES = 5242880

export const archive = app.cron('0 6 * * *', {
	actions: ['tasks.read'],
})
	.handle(async ({ ctx }) => {
		const store = archiver.get()
		const tasks = ctx.db.over(ctx.within('tasks.read', 'project')).tasks
		const done = await tasks.list({ where: [['status', '=', 'done']], limit: 50 })
		for (const task of done.items) {
			const owner = await ctx.ref('tasks.read', 'task', task.id)
			const rows = await ctx.db.on(owner).task_attachments.list()
			const reports = []
			for (const row of rows.items.filter((item) => item.file.status === 'live')) {
				reports.push(
					await ctx.files.open(row.file, { maxBytes: REPORT_MAX_BYTES }),
				)
			}
			ctx.signal.throwIfAborted()
			await store.putReports(task.id, reports, ctx.signal)
		}
	})
```

```ts src/archive.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Report {
	readonly name: string | null
	readonly type: string
	readonly bytes: Uint8Array
}

export interface Archiver {
	/** Stores the reports of one task under its id; throws when the service refuses, and gives up once `signal` aborts. */
	putReports(
		taskId: string,
		reports: readonly Report[],
		signal: AbortSignal,
	): Promise<void>
}

const variable = (env: Readonly<Record<string, unknown>>, name: string) => {
	const value = env[name]
	if (typeof value !== 'string' || value === '') {
		throw new Error(`the application variable ${name} is not set`)
	}
	return value
}

export const archiver = defineDeps((env): Archiver => ({
	async putReports(taskId, reports, signal) {
		const response = await fetch(
			`${variable(env, 'ARCHIVE_URL')}/tasks/${taskId}`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${variable(env, 'ARCHIVE_KEY')}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					files: reports.map((file) => ({
						filename: file.name ?? 'report',
						contentType: file.type,
						content: Buffer.from(file.bytes).toString('base64'),
					})),
				}),
				signal,
			},
		)
		if (!response.ok) {
			throw new Error(`the archive answered ${response.status}`)
		}
	},
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { archiver } from './archive'
import { tables } from './db/tables'

export default serve(contract, { database: scoped(tables), deps: archiver })
```

The `PUT` under the task's id makes a repeated run replace the same object, so a retried attempt stores nothing twice.

An erasure removes the rows that hold the files in the same transaction as its other writes: it keeps both or
neither. The framework's sweep then deletes each file no column references, within the hour.

```ts src/erasure/endpoints.ts
import { app } from '../app-kit'

/** Blanks the title of every task closed more than a year ago, and removes its attachments with it. */
export const erase = app.cron('30 2 * * *', {
	actions: ['tasks.read', 'tasks.write'],
})
	.handle(async ({ ctx }) => {
		const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(
			0,
			10,
		)
		const tasks = ctx.db.over(ctx.within('tasks.read', 'project')).tasks
		const stale = await tasks.list({
			where: [['status', '=', 'done'], ['due_on', '<', yearAgo], [
				'title',
				'<>',
				'',
			]],
			limit: 100,
		})
		for (const task of stale.items) {
			const ref = await ctx.ref('tasks.write', 'task', task.id)
			await ctx.transaction(async (tx) => {
				const target = tx.db.on(ref)
				const locked = await target.getForUpdate()
				await target.update({ title: '' }, { expectVersion: locked.version })
				let page = await target.task_attachments.list({ limit: 100 })
				while (page.items.length > 0) {
					for (const row of page.items) {
						await target.task_attachments.remove(row.id)
					}
					page = await target.task_attachments.list({ limit: 100 })
				}
			})
		}
	})
```

- Never write a sweep or delete an object yourself: a file goes when no column references it.
- **A handover writes the new reference before it deletes the old one, in one transaction.** Written in two
  transactions, the sweep can delete the file between them. The same covers a file two records share, a versioned
  document (a versions table with a file column) and a thumbnail (a second column of another kind): there is no move or
  copy operation.
- A file referenced from a dimension-scoped table belongs to that top-level scope: a reference from another one is
  refused.

## Malware scan

`scan: true` on a kind holds every file of it `quarantined` until ClamAV answers clean; on Zerops the platform
installs ClamAV and runs the scan job. A file answer is 409 `file_not_ready` until then and 409 `file_rejected` once
the file is `rejected`; a list shows each file's `status`, so show it rather than a broken link. In a test, the scan runs with
`kit.runJob(FILE_SCAN_JOB)` and a `scanner` passed to `testKit` (`references/tests.md`); the generated tests pass their
own seeded files.

- A scanning kind admits at most 100 MiB per file (`maxBytes`) and not `application/gzip`; an empty upload is
  400 `empty`.
- A ZIP or Office document must start with the ZIP header. Any other file that holds a ZIP signature anywhere is
  rejected, even a rare harmless PDF or image; that is the fail-closed cost.
- Turning `scan` on needs no migration: the framework's table holds the scan states.
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

## A file from a public procedure

A visitor without an account sends a file as a field of a public procedure's input
(`references/public-intake.md` builds it): `photo: z.optional(file('photos'))`, into a kind with `scan: true`, beside
a challenge and `admission.rate.bytesPerHour`. The handler writes the reference into a file column of an application
table (`registrations.photo`), and the job that claims the row writes the same reference into the record's column in
the transaction that deletes the row. The file is never copied; the sweep deletes it once no column references it.

## Storage

On Zerops, declare one `object-storage` service in `fabrika.config.ts`; the platform writes `FABRIKA_APP_STORAGE_*`
from it. Never read those variables, build a storage URL or import an S3 client.

```text
// in the services of fabrika.config.ts
{ hostname: 'tasksfiles', type: 'object-storage', objectStorageSize: 1, priority: 50 }
```

A test that boots an application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to
`testKit`.
