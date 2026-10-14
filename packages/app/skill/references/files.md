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
import { digest } from './src/tasks/digest'
import { tasks } from './src/tasks/endpoints'
import { report } from './src/tasks/report'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
		report,
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
	jobs: { digest },
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

## From a handler or a job: `ctx.files`

`ctx.files('<collection>')` reaches one collection of the contract from a handler, a job's `ctx` and its `tx`. Each
call takes a `Ref` of the owner (a task here), for one of the collection's actions:

| Call                              | Takes the owner's `Ref` for | Answers                                                                    |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `list(owner, { after?, limit? })` | `read` or `write`           | `{ items, next }`, the files the list endpoint answers; `createdAt` a Date |
| `open(owner, id, { maxBytes })`   | `read`                      | `{ id, name, type, size, bytes }` of one live file, read whole             |

A Ref for another action, or of another dimension, is refused. `open` answers 404 for a file of another owner, a
removed or a rejected one, 409 `quarantined` while the scan has not called it clean, and 413 for a file over
`maxBytes`, before any byte is read. Pass the size you hold in memory, at most the collection's `maxBytes`. The name
is checked when the call runs, not by the types: a name the contract does not declare is a 500.

A mutation that writes the owner lists with its own capability, the collection's `write`:

```ts src/tasks/report.ts
import { ConflictError } from '@fabrika/app'
import { app } from '../app-kit'
import { Saved, Versioned } from '../schemas'

export const report = app.group({ callers: ['human'] }, (r) => ({
	close: r.mutation({
		input: Versioned,
		output: Saved,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const page = await ctx.files('attachments').list(ctx.target)
			// A quarantined file is uploaded; the scan decides about it later.
			if (!page.items.some((file) => file.status !== 'rejected')) {
				throw new ConflictError('a task closes with its report attached')
			}
			return ctx.db.target.update({ status: 'done' }, {
				expectVersion: input.expectVersion,
			})
		}),
}))
```

A job mints the owner's `Ref` with `ctx.ref` and opens each live file, here to attach it to an e-mail of `deps`:

```ts src/tasks/digest.ts
import { app } from '../app-kit'
import { mailer } from '../mail'

/** The largest report one e-mail carries: the collection's maxBytes. */
const REPORT_MAX_BYTES = 5242880

export const digest = app.cron('0 6 * * *', {
	actions: ['tasks.read'],
	scope: 'app',
})
	.handle(async ({ ctx }) => {
		const mail = mailer.get()
		const tasks = ctx.db.over(ctx.within('tasks.read', 'project')).tasks
		const done = await tasks.list({ where: [['status', '=', 'done']], limit: 50 })
		for (const task of done.items) {
			const owner = await ctx.ref('tasks.read', 'task', task.id)
			const files = ctx.files('attachments')
			const page = await files.list(owner)
			const reports = []
			for (const file of page.items.filter((item) => item.status === 'live')) {
				reports.push(
					await files.open(owner, file.id, { maxBytes: REPORT_MAX_BYTES }),
				)
			}
			ctx.signal.throwIfAborted()
			await mail.sendReports(task.title, reports, ctx.signal)
		}
	})
```

```ts src/mail.ts
import { defineDeps } from '@fabrika/app/implement'

export interface Report {
	readonly name: string | null
	readonly type: string
	readonly bytes: Uint8Array
}

export interface Mailer {
	/** Sends the reports of one task; throws when the provider refuses, and gives up once `signal` aborts. */
	sendReports(
		title: string,
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

export const mailer = defineDeps((env): Mailer => ({
	async sendReports(title, reports, signal) {
		const response = await fetch(variable(env, 'MAIL_API_URL'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${variable(env, 'MAIL_API_KEY')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				to: variable(env, 'REPORTS_TO'),
				subject: `Reports of ${title}`,
				attachments: reports.map((file) => ({
					filename: file.name ?? 'report',
					contentType: file.type,
					content: Buffer.from(file.bytes).toString('base64'),
				})),
			}),
			signal,
		})
		if (!response.ok) {
			throw new Error(`the mail provider answered ${response.status}`)
		}
	},
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { mailer } from './mail'

export default serve(contract, { database: scoped(tables), deps: mailer })
```

- The owner is a table with a dimension scope; an application table owns no collection.
- There is no limit on the bytes of one owner's files together: `maxPerOwner` × `maxBytes` bounds them.

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
- `link: ['completion']` serves the named link mounts only. Name them when the owner's dimension has a link meant
  for something else (a one-click answer): a mount the list does not name has no file route and need not grant
  the collection's actions. Its holder gets 403 from the proxy, which finds no endpoint for the path.

## Storage

On Zerops, declare one `object-storage` service in `fabrika.config.ts`; the platform writes `FABRIKA_APP_STORAGE_*`
from it. Never read those variables, build a storage URL or import an S3 client.

```text
// in the services of fabrika.config.ts
{ hostname: 'tasksfiles', type: 'object-storage', objectStorageSize: 1, priority: 50 }
```

A test that boots an application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to
`testKit`.
