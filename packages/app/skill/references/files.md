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

| Endpoint                                     | Access                      | Does                                                        |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| `POST /api/files.attachments.upload/:taskId` | `write` on the task         | the body is the file, `?name=` its name; answers `{ id }`   |
| `GET /api/files.attachments/:fileId`         | `read` on the file's task   | streams the file                                            |
| `POST /api/files.attachments.list`           | `read` on the task          | body `{ owner, limit?, after? }`; answers `{ items, next }` |
| `POST /api/files.attachments.remove`         | `delete` on the file's task | body `{ id }`                                               |

A file reaches what its task reaches, now: a moved task moves its files. The list answers the task's files oldest
first, each `{ id, name, type, size, status, createdAt }`, at most `limit` (1–100, default 50) after the id `after`.

## Malware scan

`scan: true` on a collection holds every upload `quarantined` until ClamAV answers clean; on Zerops the platform
installs ClamAV and runs the scan job. The download answers 409 `quarantined` until then and 404 once the file is
`rejected`; the list shows each file's `status`, so show it rather than a broken link.

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
