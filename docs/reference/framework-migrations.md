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
2. Set every `@fabrika/*` dependency of the application to one exact release, for example `"@fabrika/app": "0.8.0"`.
   Never a range: a range mixes releases of the co-versioned set
   ([`release-process.md`](release-process.md#the-framework-window)).
3. Run `bun install` and commit `bun.lock`. Control reads the release from the `@fabrika/app` entry of the `bun.lock`
   at the application's root, and refuses a commit without one.
4. Follow the section of each minor you cross, oldest first.
5. Regenerate and check: `fabrika db codegen` after the migrations, `fabrika db test-scaffold` for the generated
   tests, then `fabrika-check` and the application's tests. The skill in `node_modules/@fabrika/app/skill/` describes
   the new release.

## 0.8 → 0.9

0.9 changes no 0.8 form of an application's contract or handlers. On Zerops, raise the pin; the one other change is
for code that opens a database itself: `Database.postgres(options)` and the root `PostgresOptions` type moved to
`openPostgres(options)` and `PostgresOptions` in `@fabrika/db/postgres`. On Cloudflare an application environment now
runs in one Durable Object over its own SQLite
([ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)): `ctx.db`
and table policies, jobs and kicks, webhooks, public procedures, file kinds (stored in R2), signed tokens and
installation mail all run there. On 0.8 its Worker was stateless, and the deploy refused each of them.

An `over` list now also returns the rows a grant on a dimension inside the listed one reaches (S4 of the
authorization model): a holder of `crm.read` on one deal sees that deal in the `over: 'company'` list of deals. Those
grants count toward `MAX_WITHIN_VALUES` (1000 scope values per `Within`) with the direct and container values. A caller
whose grants on inner dimensions push one action past 1000 values gets 403 (`CapabilityLimitError`) from a list that
answered on 0.8; give such a caller a grant on a container instead of per-object grants.

An application on Cloudflare that raises its pin to 0.9:

1. Regenerates its entry with `fabrika app build`. `fabrika/entry.generated.ts` now exports `FabrikaApplication` and
   imports `fabrika/migrations.generated.ts`, which the build writes from `db/migrations/`. Commit both where the
   application commits its entry.
2. Writes its migrations in SQLite under `db/migrations/` (the skill's `references/table-and-migration.md`), runs
   `fabrika db codegen`, which needs no database URL, and serves `scoped(tables)` from `defineApp(vocabulary, tables)`
   as on Zerops. There is no `fabrika db migrate`: the object applies the framework's tables and then the
   application's migrations when it boots. `fabrika db test-scaffold` writes the generated tests on
   `@fabrika/db/testing-sqlite`, which runs in memory; the application's own tests import `testDatabase` from there.
   An application without tables skips this step.
3. Keeps every procedure's and webhook's `limits.timeoutMs` at or below 25 s, declares no `sql` and no file kind with
   `scan: true`: a handler holds the object's transaction, and a Durable Object has no runtime role under raw SQL and no
   scanner. The checker (`cloudflare-sql`, `cloudflare-scan`), the deploy and the boot refuse each.
4. Declares no `FABRIKA_APPLICATION` or `FABRIKA_FILES` binding and no cron trigger in `fabrika.config.ts`: the
   platform writes them, and refuses a config that sets them.
5. Runs locally on Lopata 0.30 or newer, which implements the object's `storage.transaction`.

The first deploy at 0.9 adds what the object needs: the `FabrikaApplication` class and its Durable Object migration
(`v0001`, `new_sqlite_classes`), the environment's bucket (`<env>-<app>-files`), the minute tick when the contract has
a job or a file kind, and the proxy secret that the Worker forwards each request with, which Control issues per
environment. The object's database starts empty. An application that stays on 0.8 keeps its stateless Worker: Control
names the release it read the application with, and the deployer gives that Worker no object, bucket, tick or proxy
secret, and refuses its jobs, webhooks, public procedures, installation mail and token purposes as before.

0.9 also adds the dev launcher (`@fabrika/app/dev`), which a `dev` environment starts
([MCP authoring](mcp-authoring.md#the-dev-environment)); an application needs 0.9 only for a `dev` environment.

## 0.7 → 0.8

0.8 changed no 0.7 form: it added the ALTCHA challenge provider. Raise the pin; nothing else changes. To move a public
procedure from Turnstile to ALTCHA, which is a change the approval shows:

1. Replace `challenge: { provider: 'turnstile', secret, siteKey }` with `challenge: { provider: 'altcha', secret:
   'ALTCHA_HMAC_KEY' }`, keeping its `action` if it declares one, and set `ALTCHA_HMAC_KEY` for the environment to a
   long random value (at least 32 characters, `openssl rand -base64 32`).
2. On the page, render `Challenge` of `@fabrika/ui/challenge` at `challengeUrl(api.<procedure>)` in place of the
   Turnstile widget (add `altcha` to the dependencies), or, on a page outside the application, the `altcha` widget
   pointed at `/__fabrika/challenge/<action>`, with `worker-src blob:` in that page's CSP. The input field stays
   `challengeToken`.
3. A test sends `await kit.solveChallenge(api.<procedure>)` as `challengeToken` and drops its `challengeFetch`.
4. Remove the Turnstile variables once no procedure names them.

On Zerops, a namespace whose proxy is pinned to an older source refuses the first deploy with an ALTCHA challenge until
the proxy is re-pinned (`fabrika control namespaces update --namespace=<id> --proxy-source=current`).

## 0.6 → 0.7

0.7 removes every contract form that performed an application operation instead of declaring a surface: forms, inbox
tables, `then`, file collections and their generated endpoints, and the generated webhook binding endpoints. Each is
now a procedure with a handler, or a table with a policy ([ADR-0012](../decisions/0012-fabrika-app-runtime.md)).

| 0.6                                                       | 0.7                                                                  |
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
`mailer`, `sql` and `unscoped` keep their 0.6 form.

### Before the first deploy on 0.7

- **IAM and Control must know public procedures.** A public procedure runs as a workload of its own kind, which IAM
  signs and Control keys ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)). The platform
  upgrade of step 1 brings both.
- **On Zerops, re-pin the namespace's proxy.** A namespace proxy's manifest parser is strict, so a proxy pinned before
  the upgrade refuses a row of a form this release added: a public procedure, `http.cache`, a file output, several
  capabilities. Control refuses such a deploy while the namespace's proxy source is not its own, and names the command:
  `fabrika control namespaces update --namespace=<id> --proxy-source=current`
  ([`deployment-namespaces.md`](deployment-namespaces.md)).
- **On Cloudflare**, a row with `http.cache` needs a proxy Worker of the new release, and token purposes are refused.

### Forms become public procedures

A form appended its input to an inbox and answered a constant, with no handler. A public procedure is an ordinary
procedure that anyone may call. Its handler runs as the procedure's own workload and holds only the `actions` it
declares ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)).

0.6:

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

0.7:

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
// The answer 0.6 gave: the envelope is `{ result: { received: true } }`, as before.
const Received = z.strictObject({ received: z.literal(true) })

export const visitors = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Received,
		access: { public: true },
		actions: ['candidates.register'],
		admission: {
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
			rate: { perClient: 10, perEndpoint: 100, bytesPerHour: 536870912 },
		},
		kicks: ['intake'],
	})
		.handle(async ({ input, ctx }) => {
			if (honeypot(input.website)) return { received: true }
			await ctx.db.app('candidates.register').registrations.insert({
				email: input.email,
				full_name: input.fullName,
				photo: input.photo ?? null,
			})
			ctx.kick('intake')
			return { received: true }
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
   | `honeypot: 'website'`          | `if (honeypot(input.website)) return { received: true }`; keep the field     |
   | `challenge`                    | `admission.challenge`, the same shape                                        |
   | `rate: { perClient, perForm }` | `admission.rate: { perClient, perEndpoint }`                                 |
   | `rate.bytesPerHour`            | `admission.rate.bytesPerHour`, required with a file field                    |
   | `maxBytes` (the input only)    | `limits.maxBytes` (the whole body, files included: step 5)                   |
   | `files: { f: { collection } }` | a top-level input field `f: file('<kind>')`, optional or `z.array(…).max(n)` |
   | `crossOrigin: true` / `'*'`    | `admission.origins: 'listed'` / `'any'`                                      |
   | `then: '<job>'`                | `kicks: ['<job>']` and `ctx.kick('<job>')`                                   |
   | the constant answer            | the output schema; keep the answer the clients read (step 6)                 |

   - **The honeypot comes after the challenge.** A form checked its honeypot before the challenge: a filled one got the
     200 and its token was not verified. A public procedure verifies the challenge before the handler runs, so a bot
     that fills the honeypot and fails the challenge now gets 400 `challenge_failed`. A filled honeypot with a valid
     token still gets the 200 and writes nothing.

5. Check the bounds. A public mutation counts 10 calls per client and 100 for the endpoint per minute unless it
   declares its own buckets; `null` turns one off. A form with files counted 20 per minute by default: declare
   `perEndpoint: 20` to keep that bound. `bytesPerHour` now charges the body's declared length before the body is read,
   not each file's `maxBytes`. The body limit defaults to 64 KiB plus each file field at its kind's `maxBytes`, at
   most 48 MiB with files and 1 MiB without. A public file field needs a challenge, `bytesPerHour` and a kind with
   `scan: true`.
   - **The body limit.** A form's `maxBytes` bounded its input; its files were bounded apart. `limits.maxBytes`
     bounds the whole body. Without files, it takes the form's `maxBytes`. With files, leave it out when the form's
     `maxBytes` was 64 KiB or less: the default already adds the files to 64 KiB. Otherwise declare the form's
     `maxBytes` plus each file field's files at its kind's `maxBytes`. The JSON input part may take the whole limit,
     and the input with the files together never pass it.
6. Move the pages. Without `http.path`, the path moves under the RPC prefix: `POST /register` becomes
   `POST /api/visitors.register`. Without `challenge.action`, the widget's `action` is the endpoint id with `_` for `.`
   (`api_visitors_register`), not the form's name; the provider admits at most 32 characters. A client that you cannot
   change keeps both: declare them as "Clients on another origin" shows. Call the procedure through the typed client
   (`api.visitors.register(input)`), which sends a JSON body, or a multipart body when the input holds a `Blob`: the
   JSON input in the first part, named `input`, then each file in a part named after its field. The challenge token
   stays the input field `challengeToken`. A failed or replayed token stays a 400 `challenge_failed`, as the form
   answered.
   - **The answer.** The answer is the RPC envelope of the output. A 0.6 form answered `{ result: { received: true } }`;
     the example keeps it with `output: z.strictObject({ received: z.literal(true) })`. Keep the answer that your
     clients read. An output of `{}` answers `{ result: {} }`, and a client that reads `received` breaks.
7. Optional: record the visitor's evidence. This is not an upgrade step. `ctx.client.ip` and `ctx.client.userAgent` are
   information the handler may store, never a check, in columns the application adds for its own reasons (for
   example `client_ip TEXT` and `user_agent TEXT` as consent evidence). `ip` is `null` on Bun and Zerops, where the
   platform cannot vouch for the visitor's address.

### Clients on another origin

A page that the application does not serve (a marketing site, a partner's page, a mobile application) posts to the
form directly, and so does a caller of a URL published elsewhere. Keep what it sends and reads, and it sees no change:

- **The path and the challenge action.** Declare the form's own on the public procedure. Without them, the path
  becomes `POST /api/visitors.register` and the widget's `action` the endpoint id with `_` for `.`
  (`api_visitors_register`), and a token solved for the old action fails the challenge.

  ```ts
  register: r.mutation({
  	// …
  	http: { path: '/register' },
  	admission: {
  		challenge: {
  			provider: 'turnstile',
  			secret: 'TURNSTILE_SECRET',
  			siteKey: 'TURNSTILE_SITE_KEY',
  			action: 'register',
  		},
  		// …
  	},
  })
  ```

  `http.path` is a literal path outside every mount's prefix (the root SPA's excepted); the endpoint id stays
  `api.visitors.register`, and the typed client calls `/register`. `challenge.action` takes at most 32 letters,
  digits, `_` and `-`, and no two procedures share one.
- **The statuses.** A failed challenge answers 400 `challenge_failed`, a body past the limit 413 and a full bucket 429,
  as before. Two answers change:
  - **An input past the form's `maxBytes`.** The form answered 413. A public procedure reads an input up to its whole
    `limits.maxBytes`, and the input schema decides: a field past its `.max()` answers 400 `validation`, and an input
    that the schema admits is accepted. To keep the bound, give each field of the schema a `.max()`, as the example
    does. Without files, a `limits.maxBytes` of the form's `maxBytes` also keeps the 413 (step 5). With files, that
    limit bounds the input and the files together, so only the schema bounds the input alone.
  - **A filled honeypot with a failed challenge.** The form answered 200, and the procedure answers 400 (step 4).
- **The answer.** Keep the one it reads (step 6 above).

Such a page also needs `admission.origins` (`'listed'` or `'any'`, see "Cross-origin procedures").

### Inbox tables become application tables

0.6:

```ts
registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
```

0.7:

```ts
registrations: {
	scope: { app: 'registrations of visitors, until the intake job takes them' },
	actions: {
		read: 'candidates.process',
		insert: 'candidates.register',
		update: 'candidates.process',
		delete: 'candidates.process',
	},
	insert: ['email', 'full_name', 'photo'],
	update: ['last_failure'],
	files: { photo: 'photos' },
	queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: 5 },
	version: 'version',
},
```

One migration turns the inbox into an application table and keeps its rows. Start from what the inbox has. A 0.6
inbox needed no key, so it may have no `id`, no `attempts` and no `last_failure`. Add each column that is missing:

```sql
-- An inbox without a key: every existing row gets its own UUID.
ALTER TABLE registrations ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE registrations ADD PRIMARY KEY (id);
-- What the queue counts, when the job did not count it already.
ALTER TABLE registrations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN last_failure TEXT;
ALTER TABLE registrations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE registrations ADD COLUMN next_attempt_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE registrations ADD CONSTRAINT registrations_photo_file FOREIGN KEY (photo) REFERENCES fabrika_files (id);
CREATE INDEX registrations_photo ON registrations (photo);
```

- An inbox that already has an `id` column without a key takes only `ADD PRIMARY KEY (id)`. Its rows must have
  distinct, non-null ids; a 0.6 inbox filled `id` from a `DEFAULT gen_random_uuid()`.
- Keep `DEFAULT gen_random_uuid()` on `id`, and a default on every other new `NOT NULL` column. The 0.6 instance
  still runs during the rollout and inserts only its input's columns; without a default its insert fails. The 0.7
  handler sends its own id, so the default serves only the old instance.
- The handler writes the table under the procedure's action. A job reads it under the `read` action, from
  `ctx.db.app('<action>')`, not through `sql` or `unscoped`.
- `version` is needed by a queue and by a file column. `queue` is optional (see "Outbox drains on `claim`").
- A form's held file keeps its id: the framework's `0008_files.sql` migration moves every held file into
  `fabrika_files` as a quarantined file of the kind named like its collection, so the inbox's file column can take the
  foreign key. Name the file kind as the collection was named. A file the 0.6 sweep already deleted (a held file
  lived seven days) is no longer there, and the foreign key refuses its row: set that column to `NULL` first, for
  example for every row older than seven days.

### `then` becomes `kicks`

0.6:

```ts
create: r.mutation({ input, output, access, then: 'mailing' }).handle(…)
```

0.7:

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

0.6:

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

0.7:

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

   It copies what an older instance wrote since the adoption, refuses while a copied file is referenced by no file
   column, clears the legacy marker of the rest, records for deletion the objects only the old table knew (a file whose
   owner was deleted), and drops `fabrika_files_<collection>`. Until the release, the sweep never deletes a copied
   file. On a fresh install both migrations do nothing.
   - **Adopt again right before the release.** A file that an older instance attached after the adoption ran is in the
     collection's table only. The release copies it, no file column references it, and the release refuses. So when
     an older instance can attach files during the rollout window, the release's migration always repeats the
     adoption first, for the rows not adopted yet:

     ```sql
     SELECT fabrika_files_copy_legacy('attachments');
     INSERT INTO deal_attachments (id, deal_id, company_id, org_id, file, name, created_by, created_at)
     SELECT s.id, s.owner_id, s.company_id, s.org_id, s.id, COALESCE(s.original_name, 'attachment'), s.created_by, s.created_at
     FROM fabrika_files_attachments s
     WHERE s.owner_id IS NOT NULL AND s.deleted_at IS NULL AND s.status <> 'pending'
     	AND NOT EXISTS (SELECT 1 FROM deal_attachments a WHERE a.id = s.id);
     SELECT fabrika_files_release('attachments');
     ```

     The copy comes first again: without it, the insert names a file that `fabrika_files` does not hold, and the
     foreign key refuses it.
   - **Ship the release once no older instance runs** ("The rollout window"). The catch-up then adopts every file the
     window wrote. In the same release as the adoption, an older instance can still attach a file between the catch-up
     and the release: the release refuses, the migration's transaction rolls back, and the deploy fails until a later
     deploy runs it again.
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

   | 0.6                                           | 0.7                                                                                      |
   | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
   | `POST /api/files.<c>.upload/:owner`, `?name=` | a mutation with a `file('<kind>')` input field; the body is multipart                    |
   | `GET /api/files.<c>/:fileId`                  | a query with `output: file('<kind>')`, served at `GET`                                   |
   | `POST /api/files.<c>.list`                    | a query of the table; each row carries the file's `id`, `name`, `type`, `size`, `status` |
   | `POST /api/files.<c>.remove`                  | a mutation that removes the row; the sweep deletes the unreferenced file                 |
   | `link: true` (the link mount's files)         | link procedures (`l.mutation`, `l.query`) with the same inputs and outputs               |

   `download` and `remove` take a row's id. Name that field in `rows` of `src/__tests__/endpoint-access.fixtures.ts`,
   with the row's table, so the generated access tests seed a row and send its key
   ([`references/tests.md`](../../packages/app/skill/references/tests.md) of the skill):

   ```ts
   export const rows = {
   	'api.attachments.download': { id: 'deal_attachments' },
   	'api.attachments.remove': { id: 'deal_attachments' },
   }
   ```

   Without it they send a sample id, the handler answers 404, and the generated tests fail.

6. **Move the client.** `api.files.<c>.upload(owner, file)` becomes `api.attachments.upload({ dealId, name, file })`.
   A `GET` file procedure has `api.attachments.download.url(input)` for a same-origin page (`<img src>`,
   `<a download>`). `download(api.attachments.download, input)` of `@fabrika/app/client` fetches any file answer with
   the caller's credential; a link page uses it, because a link key never goes into a URL.
7. **Bound the count yourself.** `maxPerOwner` is gone. Count under the owner's lock in the upload handler:

   ```ts
   await ctx.db.target.getForUpdate()
   const held = await ctx.db.target.deal_attachments.list({
   	limit: MAX_ATTACHMENTS_PER_DEAL,
   })
   if (held.items.length >= MAX_ATTACHMENTS_PER_DEAL) {
   	throw new ConflictError('too many attachments')
   }
   ```

   - Both reads run under the upload's one action. A table reads under every action it names: an action of its policy
     or a column's `write`. `deal_attachments` names `deals.write` as its `insert` action. `deals` must name it too
     (for example as its `update` action); otherwise `getForUpdate` is a type error that names the action.
   - When the owner's table does not name the upload's action, a credentialed procedure declares two capabilities,
     `access: { capabilities: { deal: …, attached: … } }`, locks with one and counts with the other:
     `ctx.db.on(ctx.capabilities.deal).getForUpdate()`, then `ctx.db.on(ctx.capabilities.attached).deal_attachments.list(…)`.
   - A link procedure holds exactly one action, so it has no second capability. It counts under the lock only when the
     owner's table names the link's action, as the portal's `attach` in the skill's `references/public-intake.md`
     does: `candidates.photo` is written with `candidates.attach`. Otherwise a link procedure cannot take the owner's
     lock, and the count is not bounded under concurrent uploads.

### `ctx.files` in handlers and jobs

| 0.6 (`ctx.files('<collection>')`) | 0.7                                                                                  |
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

`unbind(ref, id)` removes one, and `setSecret(ref, id, secret)` replaces its secret with one the provider issued. Each
writes in the mutation's transaction, and `bind`'s answer carries the secret once. Existing bindings keep working. A
webhook's `maxBytes` becomes `limits: { maxBytes, timeoutMs }`: 1 MiB and 10 s by default, at most 48 MiB and 60 s.

### Jobs

```ts
// 0.6
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.write'],
	scope: 'app',
	timeout: '5m',
})

// 0.7
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.write'],
	limits: { timeoutMs: 300000 },
})
```

- Drop `scope`: a job is application-wide.
- `timeout` becomes `limits.timeoutMs`, in milliseconds: 15 minutes by default, at most 24 hours.

### Cross-origin procedures

```ts
// 0.6
lookup: r.query({ input, output, access, crossOrigin: true })

// 0.7
lookup: r.query({ input, output, access, admission: { origins: 'listed' } })
```

`'listed'` admits the origins an operator lists for the environment in Control, with a key only, never a session
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)). `'any'` exists on public procedures only.

### The browser config of an SPA

```ts
// 0.6
site: c.spa('/', {
	dir: 'dist/site',
	access: { public: true },
	public: ['SIGNUP_URL'],
})

// 0.7
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
table and a claim, on the paved road:

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

### The rollout window

A deploy migrates the schema before the 0.7 instance starts, and the 0.6 instance serves until the 0.7 instance is
ready. For that time the 0.6 instance runs against the migrated schema:

- **A form with a file fails.** The 0.6 form holds its file in `fabrika_files_<collection>` and writes the id into the
  inbox's file column. The new foreign key to `fabrika_files (id)` refuses that row, so the form answers 500.
- **A file removal fails** once `fabrika_files_release('<collection>')` has dropped the collection's table.
- **An insert without a default fails.** Keep a default on every new `NOT NULL` column of an inbox (see "Inbox
  tables become application tables").

Keep the window short, or keep the release out of it:

1. Migrate and deploy in one step: the deploy that runs the migrations is the one that starts 0.7. Never run the 0.7
   migrations against a database that a 0.6 instance keeps serving for longer.
2. Ship `fabrika_files_release(…)` in the next deploy, once no 0.6 instance runs. Until the release the collection's
   table stays. The release copies what the old instance wrote since the adoption and refuses it until a file column
   references it, so its migration adopts those rows first (step 4 of "File collections become file kinds and file
   columns").

### An application that used forms as event logs

An application that took anonymous submissions through forms, drained them with a job and kept files in collections
moves in one release:

1. Each form becomes a public procedure with one action that no role holds. It keeps the form's path and the
   challenge's widget `action` with `http.path` and `challenge.action` (see "Clients on another origin"), so a page
   that posts to it needs no change. Its own pages may switch to the typed client in the same release.
2. One migration turns each inbox table into an application table (a primary key `id`, `version`, and the queue's
   columns) and keeps its rows. Recording `ctx.client.ip` and `ctx.client.userAgent` as consent evidence is an
   addition of that application, not an upgrade step.
3. `then` becomes `kicks` and `ctx.kick`. Its outbox drains move from `sql: 'write'` to `queue` and `claim`.
4. Each file collection becomes a table with a file column, adopted and released by its own migrations. The generated
   upload, list and download become link procedures for the visitor and queries for staff.
5. A request that asks a visitor for a document takes it as a file field and writes it in the same call. Every read
   of the row carries the file's scan status with its reference.
6. Mail with attachments keeps a file column on its draft row and passes the references to `ctx.mail.send({
   attachments })`; bulk mail adds `unsubscribe: { url }` for the one-click headers.
7. A handover across two dimensions that needed `sql` and `unscoped` only for its second capability declares
   `access: { capabilities: { … } }`.
8. Click tracking becomes a public `GET` mutation with a `signedToken` input and `output: redirect()`.

## 0.5 → 0.6

0.6.0 changed nothing in the framework API: its framework sources are those of 0.5.5. Raise the pin; nothing else
changes. An application on 0.5 goes 0.5 → 0.6 → 0.7, or raises its pin straight to 0.9 and follows "0.6 → 0.7".

## 0.4 → 0.5

0.5 changed no 0.4 form: it added `then` and the job's `mailer`. An application on 0.4 raises its pin straight to 0.9
and follows "0.6 → 0.7"; it has no `then` to replace.
