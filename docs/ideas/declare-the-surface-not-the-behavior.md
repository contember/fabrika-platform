# Declare the surface, not the behavior

A pre-1.0 revision of the application framework's contract kinds. Two independent proposals (one per model family)
were merged into this one. Two adversarial reviews checked it for correctness, and two more for generality, coverage
and simplicity. Where a choice was contested, the decision table states the rejected option and when it would win.

## The problem

A contract declaration is read by the platform without running application code: the static reader, the artifact,
the proxy table and the approval diff all work from it (ADR-0012, ADR-0050). That is why it must describe the
surface: who reaches what, with which credential and admission, and what reach the code behind it holds.

Several kinds go further and encode application operations, with no handler:

- `c.form` appends its input fields to an inbox table and answers a constant (`implement/dispatch.ts`, `#form`).
  Anything a form needs beyond that becomes a new option with its own runtime: PR #11 adds files with a new table, a
  seven-day hold, a sweep path and a job-only `attach` (about 3,900 lines).
- `c.files` generates `upload`, `list` and `remove` endpoints with no hook. The owner row must exist before the file,
  a file cannot be written in the same transaction as its data, no handler or job can write a file at all
  (`files/handle.ts`: `list`, `open`, `removeAll`), and a file belongs to exactly one owner, whose whole scope chain
  its row copies (`packages/db/src/file-tables.ts:272`).
- `then` on a form or a mutation kicks a job after the commit: the framework performs an operation the declaration
  names.
- Webhook `bind` and `unbind` are generated endpoints.

Other gaps sit next to these: no anonymous read, one capability per endpoint (backlog 157), no e-mail attachments or
list headers, one webhook scheme, undeclared outbound calls, a fixed 10 s budget, no body limit on credentialed
procedures beyond Bun's 128 MiB, and outbox drains that need raw `sql: 'write'` for `for update skip locked`.

The one application on the framework shows the cost. It uses forms as anonymous event logs, cannot store the client
address and user agent as consent evidence, cannot tie an uploaded document to the request that asks for it, cannot
attach files to e-mails, and goes off-road (`sql`, `unscoped`) for an ordinary cross-dimension handover and for its
outbox claims.

## The principle

**A declaration states where a request enters, who may send it, how it is admitted, what it carries and what reach
the code behind it holds. It never encodes an application operation.**

| Belongs in a declaration   | Examples                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Where a request enters     | path, method, mount prefix                                                                                  |
| Who may send it            | callers, access forms, `public`                                                                             |
| How it is admitted         | body codec, body and time limits, origins, rate buckets, challenge, signature                               |
| What it carries            | input and output shapes, file fields, a file answer, a redirect and its allowed targets                     |
| What reach the code holds  | capabilities, workload actions, `sql`, `unscoped`, `connect`, `issues`, `binds`, `signs`, `kicks`, `egress` |
| What platform state exists | tables and their policies (file columns included), file kinds, job schedules                                |

Never in a declaration: which rows a request writes or reads, how input maps to them, what an answer is computed from,
or a lifecycle step written as an option flag. The framework still does platform work a declaration asks for: it
parses, admits, encodes, quarantines, verifies signatures, schedules and cleans up.

The test for a new option: **does it bound what code may do, or does it make the framework perform an application
operation?** `kicks: ['intake']` bounds; `then: 'intake'` performs. A table's `insert` action bounds; a generated
upload endpoint performs.

Corollary: **every request that touches application data runs a handler**, with its caller's capabilities or as a
declared workload (a job, a webhook, a public procedure). The framework serves on its own only what the platform owns:
SPA files, the browser config, the caller document, health, signature verification.

The kinds below are procedure boundaries and platform surfaces. An RPC procedure, a link procedure and an export
procedure share one procedure engine; they are separate kinds because of their credential (a session or key, an IAM
link key with its own issuer and share SPA, a consumer application with a versioned contract), not because of their
encoding. Public access is an access form, not a kind, as `c.spa(…, { access: { public: true } })` is today.

### Terms

| Term           | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| capability     | a request-bound value the runtime mints for one action on one object or dimension (`Ref`, `Within`, `AppCapability`)              |
| workload       | an identity that is no person: a job, a webhook or a public procedure. IAM signs its key; its declared `actions` are all it holds |
| site           | one place code runs: a procedure, a webhook handler or a job                                                                      |
| off-road       | `sql` or `unscoped`: reach outside the table policies, listed in the approval as such                                             |
| row mode       | how the proxy treats one manifest row: credentialed, link, protocol, or (new) public                                              |
| file kind      | a declared class of stored files: allowed types, size bound, scan policy. It has no owner                                         |
| file reference | the request-bound value a file column holds when read through the data layer; the only handle that serves or opens a file         |
| pending grace  | how long an unreferenced, pending file may live before the sweep deletes it (one hour today)                                      |
| constant work  | a public handler does the same work for a new and a known visitor, so its timing reveals nothing                                  |

## The catalog

### Procedures

Every procedure is `r.query` / `r.mutation` (or `l.…` in a link mount) with an inline `.handle`. The options are in
"Procedure options" below.

| Kind             | Declared by                                                                        | Serves                                                                            | Caller                                                       |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| RPC procedure    | `app.group({ callers }, …)` mounted by `c.rpc(prefix, groups, { compatibility? })` | `POST <prefix>/<path>`, or `GET` (see "The HTTP shape")                           | a session or a service key (`callers`), or anyone (`public`) |
| Link procedure   | `app.link(prefix, { spa, dimension, grants, issuedBy, maxDays, procedures })`      | `GET <prefix>/*` (the share SPA with the key bootstrap) and `<prefix>/api/<path>` | the link key; the target is `ctx.target`                     |
| Export procedure | `app.export(name, { version, consumers, audience, procedures })`                   | `POST /__fabrika/connect/<export>.v<n>.<path>` and the description                | `app:<consumer>`                                             |

A group's `callers` applies to its credentialed procedures; a public procedure in the group discards every credential.

### Platform surfaces and verified entries

| Kind    | Declared by                                                                                         | Serves                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| SPA     | `c.spa(prefix, { dir, access, browserConfig? })`                                                    | `GET <prefix>/*`, `GET <prefix>` (308), `__fabrika-config.json`, `__fabrika-me.json`. No handler          |
| Webhook | `app.webhook(path, { scheme, boundTo, actions, input, limits?, kicks?, egress?, sql?, unscoped? })` | `POST <path>/:bindingId`: signature, account and replay claim, then the handler as the webhook's workload |
| Health  | `c.health(path)`                                                                                    | `GET <path>`, a fixed answer, the one row served without the proxy secret                                 |

SPA `access`: `{ member: true }` | `{ action, over }` | `{ action, app: true }` | `{ public: true }`. `browserConfig`
(today's `public` list) names the variables the browser config exposes; the rename ends the two meanings of `public` on
one builder.

### Jobs

`app.cron(schedule, { actions, limits?, retries?, kicks?, mailer?, signs?, egress?, issues?, sql?, unscoped? })`.
Started by its schedule or by a kick from a mutation, a webhook or another job. Its scope is the application; the
option `scope: 'app'`, which has no other value, is dropped. `timeout` becomes `limits.timeoutMs`, one vocabulary with
procedures.

### Resources

- **File kind**: `c.files({ types, maxBytes, scan? })` under `files: { <kind>: … }`. No owner, no actions, no endpoint.
- **Tables**: the table policy gains `files: { <column>: '<kind>' }`. Its actions are the file's authority.
- **Imports, `csp`, vocabulary**: unchanged.
- **Framework jobs**: the file sweep and the file scan.

### Procedure options

| Option         | Values                                                                                                                                                                                                           | Allowed on                                                                                  | Default                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `input`        | a strict zod schema; `file('<kind>')` or `z.array(file(k)).max(n)` at the top level; `signedToken('<purpose>', Claims)` as a field                                                                               | files: mutations                                                                            | none                                       |
| `output`       | a schema \| `file('<kind>', { cache? })` \| `sheet(Row, …)` (today's `attachment()`) \| `redirect({ origins? })`                                                                                                 | `file` on a query or a mutation; `redirect` not on exports                                  | required                                   |
| `access`       | `{ member: true }` \| `{ action, on, from }` \| `{ action, in, from }` \| `{ action, over }` \| `{ action, creates }` \| `{ action, app: true }` \| `{ capabilities: { <name>: <form> } }` \| `{ public: true }` | `public` on RPC only; link: `{ action }`                                                    | required                                   |
| `actions`      | the workload's actions                                                                                                                                                                                           | public procedures, required there                                                           | —                                          |
| `http`         | `{ method?: 'GET' \| 'POST', query?: Schema, body?: 'json' \| 'urlencoded' }`                                                                                                                                    | see "The HTTP shape"                                                                        | `POST`, JSON; multipart derived from files |
| `limits`       | `{ maxBytes?, timeoutMs? }`                                                                                                                                                                                      | every procedure, webhook and job (`timeoutMs` only on jobs)                                 | see "Defaults and ceilings"                |
| `admission`    | `{ origins?, rate?: { perClient?, perCaller?, perEndpoint?, bytesPerHour? }, challenge? }`                                                                                                                       | `perClient`, `challenge`, `origins: 'any'`: public only; `perCaller`: credentialed and link | see "Defaults and ceilings"                |
| declared reach | `sql`, `unscoped`, `connect`, `issues`, `binds`, `signs`, `kicks`, `egress`                                                                                                                                      | see each block; a public procedure takes only `kicks` and `signs`                           | none                                       |

### Defaults and ceilings

| Bound                         | Default                                                                                       | Ceiling                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `limits.maxBytes`, no files   | 64 KiB                                                                                        | 1 MiB                                    |
| `limits.maxBytes`, files      | 64 KiB + Σ (the schema's file count × the kind's `maxBytes`)                                  | 48 MiB                                   |
| body deadline (derived)       | `max(30 s, maxBytes ÷ 16 KiB/s)`: a 10 MiB body gets about 11 min                             | 51 min, below the one-hour pending grace |
| `limits.timeoutMs`            | 10 s on a procedure and a webhook (`REQUEST_BUDGET_MS`); the job's default today              | 60 s on a procedure and a webhook        |
| file count per request        | the schema's `.max(n)`                                                                        | 20                                       |
| `admission.rate`              | public: `perClient` 10/min, `perEndpoint` 100/min (today's `FORM_LIMITS`); credentialed: none | —                                        |
| `admission.rate.bytesPerHour` | required with a public file field                                                             | 64 GiB                                   |
| public in-flight share        | a quarter of the instance's connection pool, shared by all public procedures                  | —                                        |

The approval prints the effective value of every bound, derived ones included.

### Removed

`c.form`; the inbox table scope; `then`; `ack()` and `admission.honeypot` (a handler helper instead); every generated
`/api/files.*` route, session and link; the file collection's `owner`, `read`, `write`, `delete`, `maxPerOwner` and
`link`; the file operations `attach`, `list`, `move` and `removeAll`; the generated webhook `bind`/`unbind`; the job
option `scope`; PR #11's fixed limits and seven-day hold.

### Out of scope

Installation services keep their own `protocol` rows (ADR-0022 "Installation entries"); the Sentry-compatible ingest
of Operations is one. An application cannot declare a self-authenticating protocol row, and this revision does not
change that.

## The blocks

### Public procedures

```ts
const stats = app.group({ callers: ['human'] }, (r) => ({
	cta: r.mutation({
		input: CtaClick,
		output: Empty,
		access: { public: true },
		actions: ['stats.click'],
		admission: { rate: { perClient: 300, perEndpoint: 300 } },
		limits: { maxBytes: 1024 },
	}).handle((call) => appendRow(call, 'cta_clicks', 'stats.click')),
}))
```

**Who calls versus what the code reaches.** `access: { public: true }` says anyone may call; top-level `actions` say
what the handler may do, as on a job and a webhook. The approval keeps the two apart: "Anyone may call `api.cta`
(POST /api/cta); it runs with `stats.click`."

**The compiled row.** A public procedure is its own row mode: no callers, no requirement, no delegation, and every
credential discarded, on any mount. Its endpoint kind is new, so an older proxy's strict manifest parser refuses it
instead of serving it without the new admission rules.

**Where the capability comes from.** The handler holds what IAM signs for the endpoint's own workload key, as a job and
a webhook do:

1. `schemaFromContract` adds `{ kind: 'public', name: '<endpoint id>', actions }` to the workloads. The name is the
   full endpoint id, so one group mounted twice does not merge authority.
2. Control issues one key per public procedure of the approved contract under a collision-safe variable name; deploys
   reconcile, rotate and revoke the family like job and webhook keys.
3. `boot` exchanges it at IAM's workload token path, verifies `ptype: 'public'` and the workload name, and caches it
   until shortly before it expires (`WorkloadCredential`). A flood costs IAM one exchange per token lifetime.
4. `ctx.app`, `ctx.within` and `ctx.ref` mint only for a declared action the token carries, bound to the request.
5. `callerOf` maps the token to no caller; IAM refuses every membership, link and admin operation for it.

**Bounding the reach.** Any action a table names admits `get(id)` and `getForUpdate(id)` today
(`packages/db/src/orm.ts:472`). For a public workload the data layer narrows it:

- An insert writes and reads nothing back. The handler knows the new row's id, because ids are generated caller-side.
  A file field of the input goes straight into a file column of that insert.
- A read needs the table's `read` action, and the approval lists the columns that action reads.
- `sql`, `unscoped`, `issues`, `connect`, `egress`, `binds`, mail and members are refused.
- A public action may not be granted by any role, so a role change cannot widen it unseen.

**`ctx.client`.** Every request context gains `{ ip, userAgent }`. `ip` is `X-Fabrika-Client-Ip`, the one address
header the proxy sets, or `null` where the provider cannot supply the visitor's address (Zerops until backlog 05).
`userAgent` is cut to a bounded length. It is information, never a check.

**The honeypot** is a helper: `if (honeypot(input.website)) return {}` answers what a real submission answers and
kicks nothing. The challenge, which runs before the handler, refuses most bots earlier.

**Order of a public request**, with the answer of each refusal:

1. The proxy: the row, the body codec, the origin rule (403).
2. The proxy secret and the endpoint header (403).
3. The client bucket and the in-flight share, in a short admission transaction of their own, because a query's data
   transaction is `READ ONLY` (429, 503).
4. The bounded body and the strict input (413, 400).
5. The workload token, before the challenge spends a token (503 when IAM is down and the cached token expired).
6. The challenge (403).
7. The file parts, staged as pending files ("Files as values").
8. The invocation: a mutation takes `perEndpoint` and `bytesPerHour` in its transaction (429), then the handler, the
   output, the commit, and the kicks.

### Several capabilities

Backlog 157: an access form hands one capability, so an operation that reads one dimension and writes another goes
off-road.

```ts
const requests = app.group({ callers: ['human'] }, (r) => ({
	handover: r.mutation({
		input: Handover,
		output: Empty,
		access: {
			capabilities: {
				request: { action: 'requests.handover', on: 'request', from: 'requestId' },
				records: { action: 'records.read', over: 'record' },
			},
		},
	}).handle(({ input, ctx }) =>
		handOver(input, ctx.capabilities.request, ctx.capabilities.records)
	),
}))
```

The proxy checks every requirement; the runtime mints every capability through the one issuer; the generated tests
add a denied case per capability. `capabilities` removes one cause of off-road reach, not all: joins, aggregates across
tables and locks over many rows still need `sql` (see "Coverage").

### Files as values

A file is a value in a table column. The table's policy is the file's authority: reading the column under the table's
`read` action is what lets a request serve the file, and writing it needs the action that writes that column.

```ts
// contract
const contract = app.contract((c) => ({
	files: {
		attachments: c.files({
			types: ['application/pdf', 'image/png'],
			maxBytes: 10 * 1024 * 1024,
			scan: true,
		}),
	},
	// …
}))

// table policy
const tables = defineTables(vocabulary, columns)({
	deal_attachments: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'deals.write', delete: 'crm.delete' },
		insert: ['file', 'name'],
		files: { file: 'attachments' },
		createdBy: 'created_by',
	},
})
```

The application's migration writes `file uuid not null references fabrika_files (id)` and an index on it; the checker
verifies both for every declared file column.

**The storage.** One framework table, `fabrika_files`: id, kind, status (`pending`, `quarantined`, `live`,
`rejected`), size, SHA-256, sniffed type, name, object key, the scope value of its first reference, the creating
request, created time. Bytes live in the object store under the object key, as today.

**Writing.** A file column accepts three values, and the data layer refuses anything else, a string id included:

- an incoming file of this request's input (`file('<kind>')`);
- a file a `ctx.files.put('<kind>', bytes, { type, name })` of this request created;
- a file reference this request read from another file column.

Every value must be of the column's kind. The first reference sets the file's scope value; a reference from another
top-level scope is refused.

**Staging.** The same for an incoming file and a `put`:

1. A `pending` row is committed in its own statement before any byte is written. That row is the cleanup intent.
2. The object is written, sniffed and bounded by the kind's `maxBytes`; size and SHA-256 are recorded.
3. The first write of the file into a column, in the handler's transaction, claims it: still `pending`, of this request
   and kind, not past the grace. It becomes `quarantined` (a scanning kind) or `live`.
4. After a known rollback the request deletes its unclaimed rows and objects. After an uncertain outcome (a lost commit
   answer, a crash) it deletes nothing; the sweep decides from the database.

**Reading and serving.** A row read through the data layer carries a file reference in each file column. The handler
passes it on: `ctx.files.info(ref)` (name, type, size, scan status), `ctx.files.open(ref)` (the bytes, in a job or a
handler), or it returns it from a procedure whose output is `file('<kind>')`. A file list is a query of the table that
holds the column.

**Removing.** Clearing the column or deleting the row removes the reference. The sweep deletes a file that no declared
column references and that is past the grace, together with its object. The foreign key keeps that race-free: an
insert that references the file holds a share lock on its row, so the sweep's delete waits or fails. The sweep also
deletes a `pending` file past the grace.

**What this covers without new operations:** a file shared by two records (two columns hold one reference), an
attachment reused by many e-mails, versioned documents (a versions table with a file column), a thumbnail (a second
column of another kind), metadata on an attachment (columns beside it), and a handover between owners (copy the
reference, delete the old row).

**Output.** `file('<kind>')` on a query is served at `GET` with the input from flat scalar query parameters
(canonical encodings for boolean, number and null; duplicates and unknown names refused; a bounded URL), so
`<img src>` and `<a download>` work for a same-origin session. On a mutation it is a `POST` that returns the file after
its commit, which is how a download writes an audit row. The framework streams the file; the handler returns the
reference, never a `Response`. A file output compiles to a file-response profile in the manifest row and in its
endpoint digest, so the proxy and the application apply ADR-0022's file treatment from the row, denials included.

**The client.** `api.x.url(input)` gives the URL of a `GET` file procedure for a same-origin session.
`download(api.x, input)` fetches any file output with the caller's credential and answers a file handle (`blob()`,
`stream()`, `save()`). A link holder's key is a bearer in a closure, so a link page uses `download`; the key never goes
into a URL. `download` replaces today's attachment helper and the proposed `fetchFile`.

**Caching.** `file('<kind>', { cache: 'immutable' })` is allowed on a public query only: `Cache-Control: public,
immutable`, with the file's id in the URL, for a logo or a catalog image, in a page or in an e-mail. The default is
`no-store`. Inline display stays limited to inert images.

**What the approval sees.** File reach follows from table reach: "`deals.write` writes `deal_attachments.file`
(attachments)". A file kind adds no authority of its own.

**Generated tests.** The endpoint access kit seeds a file with a framework-side `put` and writes its reference into the
column; the scaffold samples a file per declared type for a file input.

### The HTTP shape

`http: { method?, query?, body? }` describes the wire independently of the output.

| Field    | Rule                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method` | `POST` by default. A query may declare `GET`, and is `GET` by default when its output is a file; its input is then read from flat scalar query parameters. A mutation is `GET` only when it is public and its input holds a `signedToken`; the approval reads "changes state on GET; link scanners may trigger it". A session mutation is never `GET`: a top-level navigation carries the session cookie. |
| `query`  | a POST only: a flat schema for the URL's parameters, passed to the handler as `query`, beside the body's `input`                                                                                                                                                                                                                                                                                          |
| `body`   | `json` by default; multipart when the input has a file field; `urlencoded` for flat scalar fields without files                                                                                                                                                                                                                                                                                           |

`redirect({ origins? })` is an output: the handler returns `{ to }` and the framework answers 303 after a POST and
302 after a GET. A target is a path of the application's own origin, a URL of a listed origin, or a URL that a verified
signed token of this request carries. Anything else is a 500 and a log line, never an open redirect. A native form can
then POST, redirect and GET; a tracked link can redirect to its signed target.

**Browser admission matrix**, enforced in the proxy:

| Request                                          | Rule                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session, non-GET (any body codec)                | `Sec-Fetch-Site: same-origin`                                                                                                      |
| Session, `GET`                                   | a query only                                                                                                                       |
| Bearer, cross-origin                             | the proxy's preflight for `origins: 'listed'`; never a session                                                                     |
| Public, multipart or `urlencoded` (no preflight) | `Origin` must be the application's own, a listed origin (`'listed'`) or any (`'any'`); no `Origin` passes, `Origin: null` does not |
| Public, `GET` mutation                           | a valid signed token in the input, checked before the workload token                                                               |

### Admission and limits

- **One `admission` object** on every procedure holds origins, rate buckets and the challenge. `perClient` counts by
  the client address and exists on public procedures; `perCaller` counts by principal or link key and exists on
  credentialed and link procedures; `perEndpoint` counts every call. On Zerops `perClient` counts one client until
  backlog 05, and the approval says so.
- **A public file field** requires `bytesPerHour`, a challenge and a scanning kind.
- **`limits`** holds only `maxBytes` and `timeoutMs`. The file count comes from the schema, the per-file size from the
  kind, the body deadline from `maxBytes`. The handler budget starts after the last body byte, so a large upload over a
  phone connection still commits.
- **The in-flight share** bounds a local resource: all public procedures of an instance together hold at most a
  quarter of its connection pool, and the next public call answers 503. Signed-in staff keep the rest.

### Kicks and claims

```ts
const intake = app.group({ callers: ['human'] }, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['intake.register'],
		kicks: ['intake'],
	})
		.handle(async ({ input, ctx }) => {
			// …
			ctx.kick('intake')
		}),
}))
```

**Kicks** stay without a payload: a kick says "something changed, look", and the row it looks at is the only record.

- `ctx.kick` is request-bound and accepts only the declared names.
- Kicks are deduplicated per job and sent after the output validated and the transaction committed; nothing on a
  rollback, a cancellation or a refused output. A procedure without a transaction kicks once its answer is built.
- They go through ADR-0060's coalescing lease and pending flag, to `waitUntil` where the runtime has one, never
  awaited, never rejecting, drained on shutdown and by the test kit. The schedule stays the recovery path.
- Allowed on a mutation, a webhook and (new) a job. The kick edges of a contract are acyclic, so a job never kicks
  itself, directly or around a cycle.
- A new kick edge on a public procedure widens: it adds no data reach, but lets anyone cause job runs.

**Claims** are the data-layer operation every outbox drain writes in raw SQL today. A table policy declares
`queue: { attempts: '<column>', due: '<column>' }`; a job calls `ctx.db.app(cap).<table>.claim({ where, limit })`:

- it selects due rows (`<due> <= now()`) `for update skip locked`, in the job's transaction;
- it increments the attempts and moves `<due>` by the framework's backoff, so a crash or a failure retries later;
- it needs the table's `update` action; the job marks a row done by its own update or delete.

One recipe then covers an outbox, a per-record reminder (`due` is the reminder time) and asynchronous work: a mutation
inserts a `report_requests` row and kicks; the job claims it, renders, writes the result with `put` into a file column
and sets its state; the page polls the row and downloads the file.

### Webhooks

- **Verifiers.** `scheme` is a preset (`github-sha256`, `standard-webhooks`, `stripe`) or a framework-owned shape:
  `{ hmac: { header, algorithm, encoding, prefix?, timestamp?, signed: 'body' | 'timestamp.body', id? } }`,
  `{ basic: true }` or `{ bearer: true }` against the binding's secret. That covers Shopify, Slack, Twilio, Postmark,
  Mailgun, HubSpot and most others without a framework release. A verifier is never application code.
- **`boundTo`** is a dimension or `'app'`; most inbound providers need one application-wide endpoint.
- **Binding.** A procedure that binds declares `binds: '<webhook>'`, as a site that issues links declares `issues`. It
  calls `ctx.webhooks('<name>').bind(ref, account)` or `.unbind(ref, id)` with a capability on the bound value (an
  `app` capability for `'app'`), in its transaction, and answers the secret once. The framework owns the secret, the
  binding storage, the replay records and the signature check.
- **Files.** A webhook handler may `put` files, so a provider's inbound e-mail with attachments lands in file columns.
- **Delivery guarantee.** Today the replay key is recorded outside the handler's transaction
  (`implement/dispatch.ts:827`), so a crash between the record and the commit loses the delivery. The claim becomes
  recoverable: the key is claimed with a lease and marked complete in the handler's transaction; an expired claim
  without completion lets the redelivery run.
- **Not covered:** a provider that validates the URL with a `GET`, or that needs a custom response body.

### Outbound calls and e-mail

**Egress.** `egress: ['https://api.example.com']` on a credentialed procedure (query or mutation), a webhook or a job
declares the HTTPS origins its code calls; no wildcard. Boot installs a guard on the global `fetch` of the serving
process that refuses an undeclared origin for a site that runs; the approval lists every origin. This stops mistakes
and makes a bypass conspicuous; it is not a sandbox (ADR-0012 §8). A public, link or export procedure takes no egress.
Destinations a customer configures (outbound webhooks to customer URLs) are not covered.

**E-mail.** `ctx.mail.send` in a mailer job gains two fields:

- `attachments: [fileRef]`: the framework reads each file, refuses a quarantined or rejected one, bounds the total size
  and passes the parts to the transport. A transport without attachment support refuses at boot. The idempotency key
  covers the attachments.
- `unsubscribe: { url }`: the framework writes `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  (RFC 8058). There are no free headers.

### Signed tokens

`signedToken('<purpose>', Claims)` is an input field type: the framework verifies an HMAC over the purpose and the
claims with a key of the application environment (a `FABRIKA_*` variable; after a rotation the previous key verifies
for an overlap), checks the expiry, and the handler receives the typed claims. A site that issues tokens declares
`signs: ['<purpose>']` and calls `ctx.tokens.sign('<purpose>', claims, { days })`. Any site but an export may sign: a
booking procedure answers its own management link. A token is single-purpose and no credential: it opens no mount.
Single use and revocation are the application's state.

A token fits one action without a session (unsubscribe, a tracked click, manage one booking). A link mount fits a
holder who works over an object across visits, with a share SPA.

**One-click unsubscribe**:

```ts
const mail = app.group({ callers: ['human'] }, (r) => ({
	unsubscribe: r.mutation({
		input: z.strictObject({ 'List-Unsubscribe': z.literal('One-Click') }),
		output: Empty,
		access: { public: true },
		actions: ['mailing.unsubscribe'],
		http: {
			query: z.strictObject({ t: signedToken('unsubscribe', Recipient) }),
			body: 'urlencoded',
		},
	}).handle(({ query, ctx }) => unsubscribe(ctx, query.t)),
}))
```

**A tracked click** is a public `GET` mutation with `http: { method: 'GET' }`, a `signedToken` carrying the target,
and `output: redirect()`. A page that needs certainty (an interest confirmation) keeps a POST behind a button, as
today: link scanners follow GETs.

### Compatibility of a mount

Integrations already call RPC procedures with an IAM service key (caller `machine`). What they lack is a promise.
`c.rpc('/api/v1', groups, { compatibility: 'backward' })` gets the export's rule (`incompatibleChanges`): Control
refuses a deploy that removes a procedure, narrows its input, changes its output, its HTTP shape, its file-response
profile or its access. A breaking change is a new mount (`/api/v2`) beside the old one. The default is `'unchecked'`.

Service keys are issued by an operator today. Keys an organization's own administrator creates are an IAM decision
outside this revision.

## Helpers and recipes

The static reader needs a literal shell and an inline `.handle` (`packages/check/src/slice.ts`). An inline handler may
call a named function (`slice.ts:55`), and that is where the convenience goes: **the declaration stays explicit, the
behavior comes from a helper**. A helper adds no reach: the capability it uses comes from `ctx`.

### The intake, with a photo

The recipe keeps a submission table, so the public handler does constant work and reads no existing row:

```ts
const intake = app.group({ callers: ['human'] }, (r) => ({
	register: r.mutation({
		input: Register, // …, website (the honeypot), photo: z.optional(file('photos'))
		output: Empty,
		access: { public: true },
		actions: ['intake.register'], // insert into submissions
		admission: {
			challenge: {
				provider: 'turnstile',
				secret: 'TURNSTILE_SECRET',
				siteKey: 'TURNSTILE_SITE_KEY',
			},
			rate: { perClient: 100, perEndpoint: 100, bytesPerHour: 536870912 },
		},
		kicks: ['intake'],
	}).handle(async ({ input, ctx }) => {
		if (honeypot(input.website)) return {}
		await appendRow({ input, ctx }, 'submissions', 'intake.register') // writes input.photo into submissions.photo
		ctx.kick('intake')
		return {}
	}),
}))
```

`submissions.photo` and `records.photo` are both file columns of kind `photos`. The job claims submissions, creates
or updates the record with the same file reference in `records.photo`, and deletes the submission row, in one
transaction. A rolled-back job leaves both rows as they were. The file is never copied or moved; the sweep deletes it
only when no column references it. The application's retention removes an unprocessed submission; there is no
framework timer on business data.

What each old option became:

| `c.form` / PR #11                            | Now                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `appendTo`                                   | the handler's insert (`appendRow`)                                    |
| `maxBytes`, `challenge`, `rate`              | `limits` and `admission`, same runtime, same order                    |
| `honeypot`                                   | the `honeypot` helper                                                 |
| `then`                                       | `kicks` and `ctx.kick`                                                |
| the constant answer                          | `output: Empty`                                                       |
| `files` + seven-day hold + job-only `attach` | a file field written into a file column; the job copies the reference |
| input fields only                            | `ctx.client`                                                          |

### Should `/api/files.*` exist?

**No.** A file kind declares storage policy; a table declares who reaches the file. Each operation an application
wants is a procedure of one to three lines, which the approval reads like any other and the generated access tests
cover:

```ts
const portal = app.link('/p', {
	// …
	procedures: (l) => ({
		uploadDocument: l.mutation({
			input: UploadDocument,
			output: Empty,
			access: { action: 'candidates.attach' },
		})
			.handle(({ input, ctx }) => addDocument(ctx, ctx.target, input.document)),
		documents: l.query({
			input: Page,
			output: DocumentList,
			access: { action: 'candidates.read' },
		})
			.handle(({ input, ctx }) => listDocuments(ctx, ctx.target, input)),
		document: l.query({
			input: DocumentId,
			output: file('documents'),
			access: { action: 'candidates.read' },
		})
			.handle(({ input, ctx }) => documentFile(ctx, ctx.target, input.id)),
	}),
})
```

`documentFile` reads the document row under the capability and returns its file reference; the framework serves it.

## Decisions

| #  | Decision                           | Chosen                                                                                       | Rejected, and when it would win                                                                                                                                                                                                                                                                       |
| -- | ---------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | The capability of a public handler | a workload key per endpoint, signed by IAM                                                   | an in-process mint from the artifact (IAM off the public path): a second mint path, and removing a declaration would revoke nothing; a table policy "insert for anyone": cannot carry richer handlers                                                                                                 |
| 2  | How public access is written       | `access: { public: true }` + top-level `actions` on an ordinary procedure                    | a separate builder (one more kind); `callers: ['anyone']` on a group (keeps `callers` literally true, but moves a per-endpoint permission away from the endpoint); `{ public: true, actions }` in one object (mixes who calls with what the code reaches)                                             |
| 3  | "form" as a kind                   | no: kinds follow the credential, the body codec follows the input and `http`                 | a `form` kind for public multipart: a public click is JSON and a signed-in upload is multipart, so the name fits neither                                                                                                                                                                              |
| 4  | Multipart shape                    | a JSON `input` part, then file parts                                                         | PHP-style parts per field: a second coercion layer beside the strict parser                                                                                                                                                                                                                           |
| 5  | Bounding public reach              | inserts read nothing back, reads under the table's `read` action, no off-road reach          | a per-site table and operation mask in the data session (stronger, a second restriction system)                                                                                                                                                                                                       |
| 6  | The file model                     | a file is a value in a table column; the table's policy is its authority                     | an owner chain on the file row with `move`/`moveTo` (today's model; one owner per file, no sharing, operations shaped by one handover); immutable blobs plus attachment records with `share`/`transfer` (keeps collection policies, but adds a second record type and two operations to the same end) |
| 7  | Asynchronous work                  | payload-less kicks plus a data-layer `claim`                                                 | a durable typed queue `enqueue(job, payload)` beside `wake` (wins if work must outlive its business row, or when the rows become a throughput problem): a second record beside the business row and a new subsystem                                                                                   |
| 8  | The HTTP shape                     | `http: { method, query, body }` independent of the output; `redirect()` with checked targets | fixed rules per use (GET only for a file query, `inputFrom` for unsubscribe, GET mutation only with `redirect()`): fewer knobs, but each rule exists for one scenario                                                                                                                                 |
| 9  | The download                       | a procedure with a file output, `GET` on a query, `POST` on a mutation                       | one generated route per file kind: the last generated data endpoint, no audit                                                                                                                                                                                                                         |
| 10 | The honeypot                       | a handler helper                                                                             | `ack()` plus `admission.honeypot` (the framework answers without the handler): an output type for one admission rule                                                                                                                                                                                  |
| 11 | `c.form` as sugar                  | no; helpers inside the handler                                                               | a declaration macro expanded identically by the builder and the reader: keeps the inbox concept and hides the handler to save four lines                                                                                                                                                              |
| 12 | Webhook verifiers                  | presets plus framework-owned HMAC, basic and bearer shapes                                   | a closed list of named providers: one release per provider                                                                                                                                                                                                                                            |
| 13 | Egress                             | declared static origins and a guard on `fetch`                                               | undeclared (today); a provider network policy (stronger, later); dynamic destinations (needs approved destination bindings)                                                                                                                                                                           |
| 14 | E-mail links                       | single-purpose signed tokens with typed claims                                               | a link key in the URL: a credential in logs and referrers                                                                                                                                                                                                                                             |
| 15 | Presigned uploads                  | not now                                                                                      | wins for large media, resumable uploads and high volume; it hands a credential to a client and moves the sniff and the size bound out of the framework                                                                                                                                                |

## Coverage

With this revision the surface covers:

- internal business applications for organizations with roles (a CRM, an intake, HR, a back office): CRUD, filters
  and lists within a table, approvals, imports through a job, exports (`sheet`), generated documents, attachments with
  metadata, shared and versioned files;
- public entry: forms with files, public reads, public images, consent evidence, a booking page that reads under a
  `read` action and writes under an insert;
- outside parties: invitations and persistent portals (IAM, ADR-0051), share links over one object, signed one-action
  links;
- e-mail: templated mail with attachments, one-click unsubscribe, click tracking;
- asynchronous work: outboxes, reminders and report generation through `claim`, job chains through kicks;
- integrations: signed webhooks of most providers, inbound e-mail through a provider webhook, declared outbound calls,
  a versioned API for service keys.

Still off-road, and the largest remaining cause of it: **reads across tables** (joins, filters over related tables,
aggregates) and locks over many rows. In the one application 23 procedures declare `sql` for these reasons;
`capabilities` and `claim` remove only some. A read block for the paved road is its own proposal.

Not covered, by decision, until after 1.0: realtime (server-sent events), server rendering for search engines, ICS and
RSS feeds, inbound e-mail without a provider webhook, a provider that validates a webhook URL with a `GET`, outbound
webhooks to customer-configured URLs, OAuth connections with per-tenant tokens, self-service API keys, resumable
uploads, `Range` requests on file downloads, self-service tenant sign-up (an IAM decision). Each is its own decision,
not a gap in the principle.

Every block above needs the Postgres and Bun runtime; an application on Cloudflare has no data or job path today, and
this revision does not change that.

## Risks

| Risk                            | Bound                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bug in code anyone can call   | declared actions only, inserts that read nothing back, reads under `read` actions, no off-road reach, no role holds a public action, projected output, closer review of every public procedure                                          |
| Flood cost                      | client bucket before the body, in-flight share, bounded body, handler budget, endpoint bucket, byte budget, challenge for files, cached workload token, coalesced kicks; on Zerops the client bucket counts one client until backlog 05 |
| Enumeration                     | a constant output and constant work in the recipe; the approval shows any non-constant public output                                                                                                                                    |
| A file referenced across scopes | the data layer accepts only references this request created or read, of the column's kind, within the file's first scope; an `sql: 'write'` site can write any file id, which the approval already treats as full reach                 |
| Storage at rest                 | unreferenced files live at most the pending grace; referenced submission files live until the application's retention, which the recipe must state                                                                                      |
| Mixed proxy versions            | a new row mode and a file-response profile in the digest: an older proxy refuses the manifest instead of serving it without the new rules                                                                                               |
| IAM on the public path          | an expired token with IAM down answers 503, as a webhook does                                                                                                                                                                           |
| State change on GET             | only a public mutation with a signed token, shown as such in the approval                                                                                                                                                               |
| An open redirect                | targets limited to the own origin, listed origins and URLs a verified token carries                                                                                                                                                     |

## Migration

### ADRs

- **0012**: the principle; public access as an access form; `capabilities`; `kicks` and `claim`; `limits` and
  `admission`; the HTTP shape; `egress`; signed tokens.
- **0022**: the public row mode, the browser admission matrix, the file-response profile, the workload kind `public`.
- **0050**: lines for public procedures, admission and limits with effective values, file columns, kick edges,
  `binds`, `signs`, egress, `compatibility`.
- **0060**: rewritten as "a handler kicks a declared job after its commit", with `claim` as the drain.
- **0061** (PR #11): rewritten as "a file is a value in a table column".
- A new ADR for public procedures and their workload. Backlog 157 graduates into the `capabilities` form.

### PR #11

Recommended: close it unmerged. Its framework migrations `0005_form_files.sql` and `0006_form_bytes.sql` would stay
in every installation's ledger for good once applied, because migration identity is `(bundle, filename)` (ADR-0017).
Port its streaming multipart parser, its proxy origin check, its byte budget (as `fabrika_endpoint_bytes`, in a new
migration) and `tx.ref` locating in the transaction. If it lands first, the revision adds a forward migration that
drains held files into `fabrika_files` and drops both tables.

### Existing files

A framework migration creates `fabrika_files`, moves every row of the `fabrika_files_<collection>` tables into it, and
leaves a view per collection with `(file_id, owner_id, name)`. The application's own migration fills its attachment
table from that view (the CRM example: `deal_attachments`). The following release drops the views and the old tables.
Pre-1.0 installations may instead be reinstalled.

### Order of work

0. ADR-0062 first: a versioned artifact, the readers of the window bundled in Control, upcasting, and the compatibility
   suite. Without it the revision's release breaks every application on an older framework at its next deploy.
1. Workload kind `public` in auth-core, IAM and Control; `ctx.app` for workloads; `capabilities`.
2. Public procedures, `admission`, `limits`, `http`, `redirect`, `ctx.client`, `kicks` (job edges included); the
   reader, the artifact schema, the proxy table and admission matrix, the approval diff, the test kit.
3. Files as values: `fabrika_files`, file columns in table policies and the checker, staging, `put`, `info`, `open`,
   file outputs, the sweep over declared columns, the data migration; the typed client's codec, `url` and `download`.
4. `claim` in the data layer.
5. Webhook verifiers, `boundTo: 'app'`, `binds`, `put` in webhooks, the recoverable replay claim.
6. `egress`, mail attachments and `unsubscribe`, signed tokens, `compatibility`.
7. Delete `c.form`, the inbox scope, `then`, `ack()`, the generated file and webhook endpoints and the collection
   options from the framework. The platform keeps serving their side (the form row mode and its admission, the
   generated file and webhook rows, the old artifact format's upcast) until no framework release in its window
   produces them (ADR-0062), and retires them in a later release.
8. Docs, the skill, the CRM example (rewritten in the same change; the compatibility suite keeps deploying its previous
   release), ADRs. One breaking framework minor before 1.0.

**Rollout path of an existing installation.** IAM must know the workload kind and Control must issue its keys before
an application declares a public procedure, so `fabrika platform upgrade` comes first. On Zerops a namespace's proxy
pin must understand the new row mode before such an application deploys (`namespaces update --proxy-source=current`);
the strict manifest parser refuses it otherwise, and Control should refuse the deploy instead of leaving the operator
to notice. No generated installation file changes.

### The one application on the framework

1. Four public procedures replace the four forms, with one action each that no role holds. Paths move under the RPC
   prefix (`/register` → `/api/register`); its pages switch to the typed client in the same release, and the
   challenge's action name follows the endpoint id.
2. One migration turns the four inbox tables into application tables (an `id`, `client_ip`, `user_agent`) and keeps
   their rows.
3. `then` becomes `kicks` and `ctx.kick`; the intake job copies `client_ip` and `user_agent` into consent rows. Its
   outbox drains move from raw `sql: 'write'` to `claim`.
4. Documents become a table with a file column; upload, list and download become link procedures and an HR query.
5. The completion request takes its document as a file field and writes it in the same call; its scan status comes
   from `ctx.files.info`.
6. Offer and bulk e-mails get attachments (a file column on the draft) and the one-click unsubscribe headers.
7. The cross-dimension handover moves from `sql` + `unscoped` to `capabilities` where it only needed the second
   capability.
8. Click tracking becomes possible with a signed token and a `redirect()` procedure.

## Open questions

1. **Client address on Zerops.** Until backlog 05 settles the trusted range, `ctx.client.ip` is `null` there. Is that
   acceptable for consent evidence, or does backlog 05 move ahead of this revision?
2. **The body rate floor.** 16 KiB/s sets the body deadline and, with the one-hour grace, the 48 MiB ceiling. A slower
   floor needs a longer grace.
3. **`egress` enforcement.** A guard on the global `fetch` covers SDKs that use it; one that opens its own sockets
   escapes. Is a declaration with that limit worth shipping before a provider network policy exists?
4. **The file scope stamp under `sql: 'write'`.** The data layer enforces it; a database trigger would also bind raw
   SQL. Is the trigger worth its cost?
