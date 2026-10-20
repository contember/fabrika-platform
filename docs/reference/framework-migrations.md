# Framework migrations

How an application moves from one framework minor to the next. One section per minor, newest first. Each section
lists every removed or changed form with its old and its new spelling, and the steps.

The framework API may break in a minor release before 1.0. An application meets a break only when it raises its own
`@fabrika/*` pin. The platform keeps reading, approving and serving an application on every older minor of its window
([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)): a platform upgrade never forces
an application to change. Control refuses an application whose release is outside the window, and its refusal links to
this page.

## Raising the pin

1. Upgrade the installation first. Control refuses an application whose framework release is newer than the platform.
2. Set every `@fabrika/*` dependency of the application to one exact release, for example `"@fabrika/app": "0.6.0"`.
   Never a range: a range mixes releases of the co-versioned set
   ([`release-process.md`](release-process.md#the-framework-window)).
3. Run `bun install` and commit `bun.lock`. Control reads the release from the `@fabrika/app` entry of the `bun.lock`
   at the application's root, and refuses a commit without one.
4. Follow the section of each minor you cross, oldest first.
5. Regenerate and check: `fabrika db codegen` after the migrations, `fabrika db test-scaffold` for the generated
   tests, then `fabrika-check` and the application's tests. The skill in `node_modules/@fabrika/app/skill/` describes
   the new release.

## 0.5 → 0.6

0.6 removes every contract form that performed an application operation instead of declaring a surface: forms, inbox
tables, `then`, file collections and their generated endpoints, and the generated webhook binding endpoints. Each is
now a procedure with a handler, or a table with a policy ([ADR-0012](../decisions/0012-fabrika-app-runtime.md)).

| 0.5                                                       | 0.6                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `c.form(path, { appendTo, … })`                           | a public procedure in an RPC mount                                   |
| `scope: { inbox: '<form>', read }`                        | an application table, `scope: { app: '<why>' }`                      |
| `then: '<job>'` on a mutation or a form                   | `kicks: ['<job>']` and `ctx.kick('<job>')`                           |
| `c.files({ owner, read, write, delete, maxPerOwner, … })` | `c.files({ types, maxBytes, scan? })` and a table with a file column |
| `/api/files.<collection>.*` and the link mount's files    | procedures with a `file('<kind>')` input or output                   |
| `ctx.files('<collection>')`                               | the table's handles, `ctx.files.put` and `ctx.files.open`            |
| `POST /api/webhooks.<name>.bind` and `.unbind`            | a mutation with `binds: '<webhook>'`                                 |
| webhook `maxBytes`                                        | webhook `limits: { maxBytes, timeoutMs }`                            |
| job `scope: 'app'`                                        | nothing: a job is application-wide                                   |
| job `timeout: '5m'`                                       | job `limits: { timeoutMs: 300000 }`                                  |
| procedure `crossOrigin: true`                             | `admission: { origins: 'listed' }`                                   |
| SPA `public: ['<VARIABLE>']`                              | SPA `browserConfig: ['<VARIABLE>']`                                  |
| an outbox drained with `sql: 'write'` and `skip locked`   | optional: a `queue` table and `claim`                                |

`attachment()`, `c.spa(…, { access: { public: true } })`, `c.health`, `app.link`, `app.export`, `connect`, `issues`,
`mailer`, `sql` and `unscoped` keep their 0.5 form.

### Before the first deploy on 0.6

- **IAM and Control must know public procedures.** A public procedure runs as a workload of its own kind, which IAM
  signs and Control keys ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)). The platform
  upgrade of step 1 brings both.
- **On Zerops, re-pin the namespace's proxy.** A namespace proxy's manifest parser is strict, so a proxy pinned before
  the upgrade refuses a public row or a row with several capabilities. Control refuses such a deploy while the
  namespace's proxy source is not its own, and names the command:
  `fabrika control namespaces update --namespace=<id> --proxy-source=current`
  ([`deployment-namespaces.md`](deployment-namespaces.md)).
- **On Cloudflare**, a row with `http.cache` needs a proxy Worker of the new release, and token purposes are refused.

### Forms become public procedures

A form appended its input to an inbox and answered a constant, with no handler. A public procedure is an ordinary
procedure that anyone may call. Its handler runs as the procedure's own workload and holds only the `actions` it
declares ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)).

0.5:

```ts
register: c.form('/register', {
	input: Register,
	appendTo: 'registrations',
	maxBytes: 4096,
	honeypot: 'website',
	challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
	rate: { perClient: 10, perForm: 100 },
	files: { photo: { collection: 'photos' } },
	then: 'intake',
}),
```

0.6:

```ts
import { honeypot } from '@fabrika/app'
import { file } from '@fabrika/app/contract'

const Register = z.strictObject({
	email: z.email().max(200),
	fullName: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
	photo: z.optional(file('photos')),
})
const Empty = z.strictObject({})

export const visitors = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['candidates.register'],
		admission: {
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
			rate: { perClient: 10, perEndpoint: 100, bytesPerHour: 536870912 },
		},
		kicks: ['intake'],
	})
		.handle(async ({ input, ctx }) => {
			if (honeypot(input.website)) return {}
			await ctx.db.app('candidates.register').registrations.insert({
				email: input.email,
				full_name: input.fullName,
				photo: input.photo ?? null,
				client_ip: ctx.client.ip,
				user_agent: ctx.client.userAgent,
			})
			ctx.kick('intake')
			return {}
		}),
}))

// fabrika.contract.ts
api: c.rpc('/api', { visitors, candidates }),
```

Steps:

1. Add an action for each public procedure to the vocabulary and grant it to no role. IAM refuses a schema in which a
   role grants a public procedure's action, so a role change cannot widen what anyone may do.
2. Put the procedure in a group without callers, `app.group({}, …)`, and mount the group in a `c.rpc` mount. A group
   that also holds credentialed procedures keeps its `callers`; a public procedure discards every credential.
3. Write the handler: the insert that `appendTo` did, mapping each input field to its column. A public site's
   `ctx.db.app('<action>')` reaches application tables only: an insert answers only the new key, a read needs the
   table's `read` action, and an update or a delete takes only a row id that a verified signed token of the request
   carries. `sql`, `unscoped`, `connect`, `issues`, `egress`, mail and members are refused on a public procedure.
4. Map the options:

   | Form option                    | Public procedure                                                             |
   | ------------------------------ | ---------------------------------------------------------------------------- |
   | `appendTo`                     | the handler's insert                                                         |
   | `honeypot: 'website'`          | `if (honeypot(input.website)) return {}`; keep the field in the input        |
   | `challenge`                    | `admission.challenge`, the same shape                                        |
   | `rate: { perClient, perForm }` | `admission.rate: { perClient, perEndpoint }`                                 |
   | `rate.bytesPerHour`            | `admission.rate.bytesPerHour`, required with a file field                    |
   | `maxBytes` (the input only)    | `limits.maxBytes` (the whole body)                                           |
   | `files: { f: { collection } }` | a top-level input field `f: file('<kind>')`, optional or `z.array(…).max(n)` |
   | `crossOrigin: true` / `'*'`    | `admission.origins: 'listed'` / `'any'`                                      |
   | `then: '<job>'`                | `kicks: ['<job>']` and `ctx.kick('<job>')`                                   |
   | the constant answer            | the output schema; answer the same for a new and a known visitor             |

5. Check the bounds. A public mutation counts 10 calls per client and 100 for the endpoint per minute unless it
   declares its own buckets; `null` turns one off. A form with files counted 20 per minute by default: declare
   `perEndpoint: 20` to keep that bound. `bytesPerHour` now charges the body's declared length before the body is read,
   not each file's `maxBytes`. The body limit defaults to 64 KiB plus each file field at its kind's `maxBytes`, at
   most 48 MiB with files and 1 MiB without. A public file field needs a challenge, `bytesPerHour` and a kind with
   `scan: true`.
6. Move the pages. The path moves under the RPC prefix: `POST /register` becomes `POST /api/visitors.register`. Call
   it through the typed client (`api.visitors.register(input)`), which sends a JSON body, or a multipart body when the
   input holds a `Blob`: the JSON input in the first part, named `input`, then each file in a part named after its
   field. The challenge token stays the input field `challengeToken`. The widget's `action` is now the endpoint id
   with `_` for `.` (`api_visitors_register`), not the form's name; the provider admits at most 32 characters. The
   answer is the RPC envelope of the output, `{ result: {} }` here.
7. Keep the visitor's evidence. `ctx.client.ip` and `ctx.client.userAgent` are information the handler may store,
   never a check. `ip` is `null` on Bun and Zerops, where the platform cannot vouch for the visitor's address.

### Inbox tables become application tables

0.5:

```ts
registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
```

0.6:

```ts
registrations: {
	scope: { app: 'registrations of visitors, until the intake job takes them' },
	actions: {
		read: 'candidates.process',
		insert: 'candidates.register',
		update: 'candidates.process',
		delete: 'candidates.process',
	},
	insert: ['email', 'full_name', 'photo', 'client_ip', 'user_agent'],
	update: ['last_failure'],
	files: { photo: 'photos' },
	queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: 5 },
	version: 'version',
},
```

One migration turns the inbox into an application table and keeps its rows:

```sql
ALTER TABLE registrations ADD PRIMARY KEY (id);
ALTER TABLE registrations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE registrations ADD COLUMN next_attempt_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE registrations ADD COLUMN client_ip TEXT;
ALTER TABLE registrations ADD COLUMN user_agent TEXT;
ALTER TABLE registrations ADD CONSTRAINT registrations_photo_file FOREIGN KEY (photo) REFERENCES fabrika_files (id);
CREATE INDEX registrations_photo ON registrations (photo);
```

- The handler writes the table under the procedure's action. A job reads it under the `read` action, from
  `ctx.db.app('<action>')`, not through `sql` or `unscoped`.
- `version` is needed by a queue and by a file column. `queue` is optional (see "Outbox drains on `claim`").
- A form's held file keeps its id: the framework's `0008_files.sql` migration moves every held file into
  `fabrika_files` as a quarantined file of the kind named like its collection, so the inbox's file column can take the
  foreign key. Name the file kind as the collection was named. A file the 0.5 sweep already deleted (a held file
  lived seven days) is no longer there, and the foreign key refuses its row: set that column to `NULL` first, for
  example for every row older than seven days.

### `then` becomes `kicks`

0.5:

```ts
create: r.mutation({ input, output, access, then: 'mailing' }).handle(…)
```

0.6:

```ts
create: r.mutation({ input, output, access, kicks: ['mailing'] })
	.handle(async ({ input, ctx }) => {
		// …
		ctx.kick('mailing')
		return saved
	}),
```

- A kick is sent only after the site's transaction committed; a handler that throws drops its kicks with its writes.
  It carries no payload; the job reads its tables.
- `kicks` is allowed on a mutation (credentialed, link or public), a webhook and a cron job. It names cron jobs of the
  contract, and the kick edges between jobs must be acyclic
  ([ADR-0060](../decisions/0060-a-handler-kicks-a-declared-job-after-its-commit.md)).

### File collections become file kinds and file columns

A collection owned its files and generated their endpoints. A file is now a value in a table column, and the table's
policy is its authority ([ADR-0061](../decisions/0061-a-file-is-a-value-in-a-table-column.md)).

0.5:

```ts
files: {
	attachments: c.files({
		owner: 'deals',
		read: 'crm.read',
		write: 'deals.write',
		delete: 'crm.delete',
		maxBytes: MAX_ATTACHMENT_BYTES,
		types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv'],
		maxPerOwner: MAX_ATTACHMENTS_PER_DEAL,
	}),
},
```

0.6:

```ts
// fabrika.contract.ts
files: {
	attachments: c.files({ maxBytes: MAX_ATTACHMENT_BYTES, types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv'] }),
},

// src/db/tables.ts
deal_attachments: {
	scope: { child: 'deals' },
	actions: { read: 'crm.read', insert: 'deals.write', delete: 'crm.delete' },
	insert: ['file', 'name'],
	files: { file: 'attachments' },
	createdBy: 'created_by',
},
```

Steps:

1. **Keep the name.** Declare a file kind with the collection's name, `types`, `maxBytes` and `scan`. The framework
   copied the collection's files into `fabrika_files` with the collection's name as their kind, and a file column takes
   only files of its own kind.
2. **Declare the table.** The collection's `owner` becomes the table's scope (a child of the owner's table), `read`,
   `write` and `delete` become its `read`, `insert` and `delete` actions, and `files: { <column>: '<kind>' }` names the
   file column.
3. **Write the adoption migration.** It creates the table and fills it from the collection's table, by id:

   ```sql
   CREATE TABLE deal_attachments (
   	id UUID PRIMARY KEY,
   	deal_id UUID NOT NULL,
   	company_id UUID NOT NULL,
   	org_id TEXT NOT NULL,
   	file UUID NOT NULL REFERENCES fabrika_files (id),
   	name TEXT NOT NULL,
   	created_by TEXT NOT NULL,
   	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   	FOREIGN KEY (deal_id, company_id, org_id) REFERENCES deals (id, company_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
   );
   CREATE INDEX deal_attachments_deal ON deal_attachments (deal_id);
   CREATE INDEX deal_attachments_file ON deal_attachments (file);

   SELECT fabrika_files_copy_legacy('attachments');
   INSERT INTO deal_attachments (id, deal_id, company_id, org_id, file, name, created_by, created_at)
   SELECT s.id, s.owner_id, s.company_id, s.org_id, s.id, COALESCE(s.original_name, 'attachment'), s.created_by, s.created_at
   FROM fabrika_files_attachments s
   WHERE s.owner_id IS NOT NULL AND s.deleted_at IS NULL AND s.status <> 'pending';
   ```

   - A file column is `UUID REFERENCES fabrika_files (id)` with an index it leads. The checker's
     `file-column-migration` rule refuses a declared file column without both.
   - `SELECT fabrika_files_copy_legacy('<collection>');` copies the rows an older instance wrote after `0008_files.sql`
     ran, while the rollout still served it. Call it right before the `INSERT`, so every row the insert reads has its
     `fabrika_files` row. It is idempotent.
   - The `WHERE` clause is the copy's own: rows with an owner, not deleted, not pending. Adopt every such row, a
     rejected one too; a row the copy skipped has no `fabrika_files` row and fails the foreign key.
   - The migration classifier admits exactly these framework names in an application migration: a file column's
     `REFERENCES fabrika_files`, a collection table read in an `INSERT … SELECT`, and the two `SELECT` calls, each as a
     statement of its own.
4. **Release the collection.** The last adoption migration of a collection calls the release:

   ```sql
   SELECT fabrika_files_release('attachments');
   ```

   It copies what an older instance wrote since, refuses while a copied file is referenced by no file column, clears
   the legacy marker of the rest, records for deletion the objects only the old table knew (a file whose owner was
   deleted), and drops `fabrika_files_<collection>`. Until the release, the sweep never deletes a copied file. When it
   refuses, add one more adoption migration before it, which inserts the rows not adopted yet
   (`WHERE NOT EXISTS (SELECT 1 FROM deal_attachments a WHERE a.id = s.id)`). The release may ship in the same
   release as the adoption or in a later one. On a fresh install both migrations do nothing.
5. **Replace the generated endpoints with procedures.** Each operation is a procedure of a few lines:

   ```ts
   export const attachments = app.group({ callers: ['human'] }, (r) => ({
   	upload: r.mutation({
   		input: z.strictObject({
   			dealId: z.uuid(),
   			name: Name,
   			file: file('attachments'),
   		}),
   		output: Done,
   		access: { action: 'deals.write', on: 'deal', from: 'dealId' },
   	}).handle(({ input, ctx }) =>
   		ctx.db.target.deal_attachments.insert({
   			file: input.file,
   			name: input.name,
   		})
   	),
   	list: r.query({
   		input: OfDeal,
   		output: AttachmentPage,
   		access: { action: 'crm.read', on: 'deal', from: 'dealId' },
   	})
   		.handle(async ({ input, ctx }) =>
   			fromPage(
   				Attachment,
   				await ctx.db.target.deal_attachments.list({ after: input.after }),
   			)
   		),
   	download: r.query({
   		input: OneAttachment,
   		output: file('attachments'),
   		access: { action: 'crm.read', on: 'deal', from: 'dealId' },
   	})
   		.handle(async ({ input, ctx }) =>
   			(await ctx.db.target.deal_attachments.get(input.id)).file
   		),
   	remove: r.mutation({
   		input: OneAttachment,
   		output: Done,
   		access: { action: 'crm.delete', on: 'deal', from: 'dealId' },
   	})
   		.handle(({ input, ctx }) =>
   			ctx.db.target.deal_attachments.remove(input.id).then(() => ({
   				id: input.id,
   			}))
   		),
   }))
   ```

   | 0.5                                           | 0.6                                                                                      |
   | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
   | `POST /api/files.<c>.upload/:owner`, `?name=` | a mutation with a `file('<kind>')` input field; the body is multipart                    |
   | `GET /api/files.<c>/:fileId`                  | a query with `output: file('<kind>')`, served at `GET`                                   |
   | `POST /api/files.<c>.list`                    | a query of the table; each row carries the file's `id`, `name`, `type`, `size`, `status` |
   | `POST /api/files.<c>.remove`                  | a mutation that removes the row; the sweep deletes the unreferenced file                 |
   | `link: true` (the link mount's files)         | link procedures (`l.mutation`, `l.query`) with the same inputs and outputs               |

6. **Move the client.** `api.files.<c>.upload(owner, file)` becomes `api.attachments.upload({ dealId, name, file })`.
   A `GET` file procedure has `api.attachments.download.url(input)` for a same-origin page (`<img src>`,
   `<a download>`). `download(api.attachments.download, input)` of `@fabrika/app/client` fetches any file answer with
   the caller's credential; a link page uses it, because a link key never goes into a URL.
7. **Bound the count yourself.** `maxPerOwner` is gone. Count under the owner's lock in the upload handler:

   ```ts
   await ctx.db.on(ctx.capabilities.deal).getForUpdate()
   const held = await ctx.db.on(ctx.capabilities.attached).deal_attachments
   	.list({ limit: MAX_ATTACHMENTS_PER_DEAL })
   if (held.items.length >= MAX_ATTACHMENTS_PER_DEAL) {
   	throw new ConflictError('too many attachments')
   }
   ```

   The upload then needs the table's `read` action beside `insert`: declare both with
   `access: { capabilities: { … } }`.

### `ctx.files` in handlers and jobs

| 0.5 (`ctx.files('<collection>')`) | 0.6                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `list(owner, …)`                  | a list of the table that holds the column, under the owner's capability              |
| `open(owner, id, { maxBytes })`   | `ctx.files.open(row.file, { maxBytes? })` with a reference read from a file column   |
| `removeAll(owner)`                | remove the rows, in the transaction of the other writes; the sweep deletes the files |
| `tx.files(…).attach(owner, id)`   | write the file reference into the record's column, then delete the source row        |
| no way to write a file            | `ctx.files.put('<kind>', bytes, { type, name? })`, then write the reference          |

A file column takes only a file reference: an input file, a `put` of this request, or a reference this request read
from a file column. A string id is refused. A handover writes the new reference before it deletes the old row, in one
transaction.

### Webhook bindings

The generated `POST /api/webhooks.<name>.bind` and `.unbind` are gone. A mutation declares `binds` and binds with a
capability on the bound value:

```ts
export const integrations = app.group({ callers: ['human'] }, (r) => ({
	connectGithub: r.mutation({
		input: z.strictObject({
			orgId: z.string(),
			account: z.string().regex(/^(installation|repository):\d+$/),
		}),
		output: WebhookSecret,
		access: { action: 'members.manage', on: 'org', from: 'orgId' },
		binds: 'github',
	})
		.handle(({ input, ctx }) =>
			ctx.webhooks('github').bind(ctx.target, input.account)
		),
}))
```

`unbind(ref, id)` removes one. Both write in the mutation's transaction, and the answer carries the secret once.
Existing bindings keep working. A webhook's `maxBytes` becomes `limits: { maxBytes, timeoutMs }`: 1 MiB and 10 s by
default, at most 1 MiB and 60 s.

### Jobs

```ts
// 0.5
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.write'],
	scope: 'app',
	timeout: '5m',
})

// 0.6
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.write'],
	limits: { timeoutMs: 300000 },
})
```

- Drop `scope`: a job is application-wide.
- `timeout` becomes `limits.timeoutMs`, in milliseconds: 15 minutes by default, at most 24 hours.

### Cross-origin procedures

```ts
// 0.5
lookup: r.query({ input, output, access, crossOrigin: true })

// 0.6
lookup: r.query({ input, output, access, admission: { origins: 'listed' } })
```

`'listed'` admits the origins an operator lists for the environment in Control, with a key only, never a session
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)). `'any'` exists on public procedures only.

### The browser config of an SPA

```ts
// 0.5
site: c.spa('/', {
	dir: 'dist/site',
	access: { public: true },
	public: ['SIGNUP_URL'],
})

// 0.6
site: c.spa('/', {
	dir: 'dist/site',
	access: { public: true },
	browserConfig: ['SIGNUP_URL'],
})
```

Only the option's name changes. The variables it names, and a challenge's site key, reach the pages in
`<prefix>/__fabrika-config.json` as before.

### Outbox drains on `claim`

Optional, and recommended. A drain written as raw SQL (`sql: 'write'`, `… for update skip locked`) becomes a queue
table and a claim, off no road:

```ts
// src/db/tables.ts
outbox: {
	scope: { app: 'mail of every organization goes out through one job' },
	actions: { read: 'mail.send', insert: 'mail.queue', update: 'mail.send' },
	insert: ['to', 'subject', 'text'],
	queue: { attempts: 'attempts', due: 'next_attempt_at' },
	version: 'version',
},

// the job
for (const message of await ctx.db.app('mail.send').outbox.claim({ limit: 50 })) {
	await ctx.mail.send({ to: message.to, subject: message.subject, text: message.text, idempotencyKey: message.id })
	await ctx.transaction((tx) => tx.db.on(message.ref).update({}, { expectVersion: message.version, done: true }))
}
```

- The migration adds `attempts INTEGER NOT NULL DEFAULT 0`, `next_attempt_at TIMESTAMPTZ DEFAULT now()` (null once
  done) and `version INTEGER NOT NULL`. A row is due while its `due` column is set.
- `claim({ limit, where? })` leases the due rows in a transaction of its own and moves each one's `due` by the job's
  tick, doubling, at most 30 days. Each row answers its new `version` and a `ref`.
- Finish each row through `tx.db.on(row.ref)`: `update(values, { expectVersion, done: true })`,
  `remove({ expectVersion })`, or `requeue({ at? })`. A row past `maxAttempts` (10 by default) stays, not due.
- `claim` is refused inside `ctx.transaction` and in a request.

### An application that used forms as event logs

An application that took anonymous submissions through forms, drained them with a job and kept files in collections
moves in one release:

1. Each form becomes a public procedure with one action that no role holds. Its path moves under the RPC prefix, its
   pages switch to the typed client in the same release, and the challenge's widget `action` follows the endpoint id.
2. One migration turns each inbox table into an application table (a primary key `id`, `version`, `client_ip`,
   `user_agent`) and keeps its rows. The handler stores `ctx.client.ip` and `ctx.client.userAgent` as consent evidence.
3. `then` becomes `kicks` and `ctx.kick`. The job copies `client_ip` and `user_agent` into its consent rows. Its outbox
   drains move from `sql: 'write'` to `queue` and `claim`.
4. Each file collection becomes a table with a file column, adopted and released by its own migrations. The generated
   upload, list and download become link procedures for the visitor and queries for staff.
5. A request that asks a visitor for a document takes it as a file field and writes it in the same call. Every read
   of the row carries the file's scan status with its reference.
6. Mail with attachments keeps a file column on its draft row and passes the references to `ctx.mail.send({
   attachments })`; bulk mail adds `unsubscribe: { url }` for the one-click headers.
7. A handover across two dimensions that needed `sql` and `unscoped` only for its second capability declares
   `access: { capabilities: { … } }`.
8. Click tracking becomes a public `GET` mutation with a `signedToken` input and `output: redirect()`.

## 0.4 → 0.5

0.5 changed no 0.4 form: it added `then` and the job's `mailer`. An application on 0.4 raises its pin straight to 0.6
and follows "0.5 → 0.6"; it has no `then` to replace.
