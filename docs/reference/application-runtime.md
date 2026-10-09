# Application runtime

`@fabrika/app` is the first-party server framework for applications deployed by
Fabrika. It combines Fetch-based HTTP routing, middleware, typed RPC, structural
error handling, object-level authorization, and a typed browser client.

## Request pipeline

`defineApp()` builds the runtime-neutral request application. For each request it:

1. answers 400 for a non-canonical raw path (`isCanonicalPath` from `@fabrika/auth-core`: an
   empty segment, `.` or `..`, an encoded `/` or `\`, a malformed percent escape), before anything
   else runs;
2. builds the caller-owned context;
3. runs global middleware in declaration order;
4. matches an HTTP or RPC route;
5. runs route-scoped middleware;
6. invokes the handler or RPC dispatcher;
7. maps thrown structural errors to a response;
8. serves the optional asset fallback for an unmatched `GET`.

Middleware may mutate context, short-circuit with a response, or wrap the
downstream response. `@fabrika/auth` owns the canonical `Middleware` type;
`@fabrika/app` consumes and re-exports it.

HTTP route patterns support typed `:segment` parameters and one optional terminal
wildcard such as `/public/*path`. The wildcard captures the decoded remaining
path; it can never contain an encoded `/`, because step 1 refuses one. A trailing `/` is
significant and matched literally: `/a/` and `/a` are different routes, and a `:segment`
never matches the empty segment after a trailing `/`. A wildcard below the root needs the
`/` before it, like the gate glob: `/public/*path` matches `/public/` with an empty
remainder, not `/public`; `/*path` still matches `/`. `route.all()` mounts a Fetch-style handler for every method. It is the
compatibility seam for an established REST surface that joins the shared
application pipeline without changing its wire contract.

IAM, Delivery, and Operations are first-party reference applications. They
dispatch through the same application on Cloudflare and Bun while retaining the
protocol surfaces required by their platform roles. See
[`core-application-composition.md`](core-application-composition.md) for their
RPC, authorization, persistence, protocol, and environment boundaries.

`@fabrika/auth` reads application identity from `FABRIKA_IAM_APP_ID` — the IAM
application id `<app>@<env>` ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)
rule 6) — and the IAM origin from `FABRIKA_IAM_ISSUER`, straight off the `Env` it is
handed. Those are the only names it accepts; the predecessor names were retired by
[ADR-0024](../decisions/0024-canonical-environment-names.md), and
there is no compatibility reader left to consult.

## Authorization boundary

The proxy is the only enforcement point
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)): one gate
evaluator, in `@fabrika/auth-core`, and the proxy is the only thing that runs it.
Zerops uses Caddy plus the shared TypeScript auth service. Cloudflare authoring
creates a public proxy Worker with a private application Worker child and the same
authorizer. No application evaluates a gate: `@fabrika/auth` exports nothing that
can.

Enforcement is one of three layers that refuse a request; [`overview.md`](overview.md)
names all three. This section covers the first two — gates and object-level
authorization. The third, admission, belongs to the services that accept browser
sessions and is described in
[`core-application-composition.md`](core-application-composition.md).

Proxy gates and procedure requirements are complementary:

- The proxy evaluates the ordered static gate list and prevents unauthorized
  requests from reaching the private app service on both providers.
- An application's own middleware calls `iam.authenticate(request)`, which verifies
  the proxy-injected `X-Fabrika-Token` locally against IAM's JWKS and builds the
  canonical `AuthContext` from `@fabrika/auth`.
- `.require(action, scopeResolver?)` calls `ctx.auth.can()` before the procedure
  handler. The optional resolver maps validated input and context to an
  application-owned `{ type, value }` coordinate.

A `.require()` check does not replace a proxy gate. A proxy gate cannot replace an
object-level check whose scope depends on application data.

## Typed RPC

`initRpc<Ctx>()` creates immutable procedure builders and nested routers. A
procedure may declare:

- an input Standard Schema;
- an optional output Standard Schema;
- one or more authorization requirements;
- a query, mutation, or neutral handler.

The wire protocol uses one POST endpoint:

- request: `{ method, input }`, one call per request (`{ batch }` is removed and
  answers 400);
- response: `{ result }` or `{ error }`.

Browser-safe contract packages describe the named procedure surface without
importing a server runtime. `RpcRouterFor<Context, Contract>` checks the server
implementation against that contract, and `createRpcClient<Contract>()` derives
the browser call surface from it. No code generation is required.

## Contracts

`@fabrika/app/contract` is the browser-safe declaration of an application's whole
access surface ([ADR-0012](../decisions/0012-fabrika-app-runtime.md)).
`defineContract(vocabulary, (c) => surface)` types it: actions come from the
vocabulary, roles list exact actions, every procedure declares `access`, RPC mounts
have no public or link caller, `from` names a string field of the input, and loose
objects do not type-check. `compileContract(contract, tables)` validates what the
types cannot, applies every default, generates the endpoint rows and returns the
normalized `ContractArtifact` of `@fabrika/auth-core`; `parseContractArtifact` reads
one back from JSON. Both refuse a `*` in an action and a role named after one of IAM's
own roles (`admin`); `creates` takes only a dimension that lies in no other. `tables` is
what `defineTables` returned, or the artifact form of each policy; `@fabrika/db/tables`
(browser-safe) converts one into the other. Schemas are the zod 4 subset that
`@fabrika/check` accepts.

The artifact compiles to what the proxy and IAM consume. On Zerops, `fabrika.config.ts`
hands both to its provider: `target.proxy` (`{ upstream, ...contractProxyTable(artifact) }`)
and `schema`. On Cloudflare the config returns only the application Worker and `schema`; the
deployer reads `fabrika.contract.ts` from the checkout with `@fabrika/check/contract` and
builds the proxy Worker from `contractProxyTable(artifact)` itself (ADR-0048), refusing a
config Worker that binds `APP`. A contract application generates no gates; both providers refuse
one whose proxy carries gates.

- `contractProxyTable(artifact)` (`@fabrika/proxy-core/manifest`) emits every endpoint row's
  rules — kind, method, path, callers, requirement, admission — with its delegation and
  `requirementDigest`, the reserved prefixes, and the contract digest as `snapshot`. The
  proxy selects one endpoint per request with `planEndpoint` and decides there
  (ADR-0022 rule 3); there is no fall-through to a broader path.
- `schemaFromContract(artifact)` emits the dimensions as scopes (with `in`, `creator` and
  `members`), the actions, the roles (a membership role with its scope and `assignableBy`),
  the link mounts by name, the delegations, and `contract: true`, which makes IAM refuse
  every wildcard written for the application. A delegation is an endpoint that spends
  membership authority: a `creates` endpoint, or one whose action is the `members.manage`
  action of the dimension its access form names. `links` and `delegations` are always
  present, so a reconcile drops a mount or an endpoint the contract no longer declares.

## Serving a contract

`@fabrika/app/implement` serves a contract. An application writes `src/app.ts`:

```ts
// src/db/database.ts
export const database = scoped(tables) // the policies of src/db/tables.ts
export const { defineStore, defineChildStore } = database

// src/db/stores/notes.ts
export const notes = defineStore('notes', (t) => ({
	list: (within: Within<'workspace', 'notes.read'>) =>
		t.select(within, (q) => q.columns(['id', 'title'])),
	remove: (note: Ref<'note', 'notes.delete'>) => t.remove(note),
}))

// src/app.ts
export default implement(contract, {
	database, // the policies, and the locator `on` and `in` use, generated from them
	deps: () => ({}),
	handlers: () => ({
		api: {
			notes: {
				list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
				remove: async ({ ctx }) => {
					await notes.remove(ctx.target)
					return { deleted: ctx.target.value }
				},
			},
		},
	}),
})
```

`implement` is typed by the contract: a missing handler, a handler for an undeclared
endpoint or for a mount without procedures, a returned field the output does not
declare, and a `Ref` passed to an operation of another action are type errors.
`deps` runs once at boot with the application's own variables and the capability
authority; `handlers` receives what it returned. Stores are defined in modules of their
own, on the `scoped(tables)` result of `@fabrika/db`; nothing reaches the database until
`boot` binds that layer. That result has no connection and no locator of its own.

`fabrika app build` writes `fabrika/entry.generated.ts` for an application with a
`fabrika.contract.ts`: `serveContract(() => import('../src/app'), process.env)` on
Zerops, `createContractWorker(() => import('../src/app'))` on Cloudflare. The adapter
first takes every `FABRIKA_*` variable out of `process.env` and `Bun.env`, then imports
the application, so no module of it can copy one, and calls
`boot(app, { environment, iam, assets, database, files, membership })`. For an application on `@fabrika/db`,
`serveContract` loads the data layer before the application and opens its connection on
`FABRIKA_APP_DATABASE_URL`, in the schema `app_<FABRIKA_APP_ID>` its migrations created;
`boot` binds the layer to it and to `requestCapabilities`, once, and keeps the locator the
bind answers; the application receives neither. Only an object `scoped` created is bound.
Without a connection (the data layer runs on Bun with Postgres only, so on Cloudflare),
with a copy or a wrapper of the layer, or with a layer bound before boot, `boot` refuses
to start. `boot` verifies tokens for the audience
`FABRIKA_IAM_APP_ID` (`<app>@<env>`, whose application must be the contract's), reads
`FABRIKA_IAM_ISSUER` and `FABRIKA_OPERATIONS_DSN`, and refuses to start when
`FABRIKA_CONTRACT_DIGEST` is missing or is not `contractDigest` of the compiled contract
(ADR-0022 rule 5), when the contract
declares something this version cannot serve yet (a file collection with `link: true`,
a webhook bound to the whole application), when a job cannot run (see Jobs), when an
import has no matching snapshot or no owner, when a file collection
cannot be served (below), when an `on` dimension or a link mount's dimension has no
table, when an access form reaches a dimension that lies in a container no table can
locate it in, when a form or a webhook has no `scoped(tables)` layer (a form's input
field must be a column of its inbox), when an SPA or a link mount has no asset server,
when an endpoint asks IAM for a scope, a membership change or a share link and the
adapter supplies no membership transport, or when a handler is missing or undeclared.
The membership transport is IAM's application entrypoint on the `IAM` binding on
Cloudflare, and `HttpIamRpc` on `FABRIKA_IAM_RPC_URL` and `FABRIKA_IAM_RPC_KEY` on Bun
when the platform sets both.

Where the hop is not a service binding, `boot` also takes the proxy secret
`FABRIKA_PROXY_SECRET` (ADR-0022 rule 5). The Bun adapter, which serves Zerops, refuses
to start without one or with one shorter than 32 characters; the Worker adapter needs
none. Control generates the secret once per application environment and keeps it in its
vault; the Zerops provider writes it to the application service and, under
`proxySecretVariable('<app>@<env>')`, to the namespace proxy, whose Caddy sends it as
`X-Fabrika-Proxy-Secret`.

Per request, in this order:

1. when the application has a proxy secret, a request without it, or with another, is
   403 before any other answer — also for a path no endpoint serves and a non-canonical
   one. Only a `health` endpoint is served without it, because the platform probe dials
   the application directly;
2. refuse a non-canonical path (400) and select the endpoint with `planEndpoint`; no
   endpoint is 404, never the SPA;
3. `X-Fabrika-Endpoint` must be `<id>@<digest>` of that endpoint, with this version's
   `requirementDigest` of its row: the proxy names what it selected and the rules it
   applied, and any other value — or none — is 503. Only a `health` endpoint may arrive
   without it;
4. verify the proxy-injected token with the shared verifier, for this application in
   this environment: none, invalid, or minted for another environment or application
   is 401, an unreachable IAM is 503;
5. the token's caller kind must be one of the mount's callers: a user token is
   `human`, a service token `machine`, an anonymous token (a share link) `link` (403);
6. the requirement: `member` is any permission, an action is that action in some
   scope (403);
7. admission: a request without `Authorization` that is not a `GET` needs
   `Sec-Fetch-Site: same-origin` (403), and RPC needs `Content-Type: application/json`
   (400);
8. parse the body strictly (400), run the access form, remove the `from` field, call
   the handler, project the output through its schema (a union through its first
   branch that accepts the value), answer `{ result }`.

| Form                   | Hands the handler                         | Refuses with                                            |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `{ member: true }`     | nothing                                   | —                                                       |
| `{ action, over }`     | `ctx.within`, or `all` for a global grant | 403 when no value holds the action, or over 1000 values |
| `{ action, in, from }` | `ctx.target` with its containment chain   | 403 not held, 404 missing                               |
| `{ action, on, from }` | `ctx.target` with its containment chain   | 404 when missing or not held                            |
| `{ action, creates }`  | `ctx.created`, the value IAM generated    | 503 without the proxy's delegation grant; IAM's refusal |

A grant on a container reaches every value inside it. `on` and `in` read where the
object or scope lies from the database on every request, with a locator generated from
the table policies, and accept the action on any link of its chain. `over` reads
nothing: `ctx.within` carries the values of its dimension and, separately, the
containers where the caller holds the action (`notes.read` in `organization:o1`), and
the data layer matches each row's chain columns in the same statement, so a workspace
moved out of `o1` after the check is out. A `Within` carries at most 1000 values in
total. A missing
`in` scope is 404 only to a caller who holds the action on that value itself; to anyone
else it is the same 403 as a scope they may not act in. Because the chain is read per
request, a moved object's next `Ref` carries its new chain, and a `Ref` minted before
the move reaches nothing.

Errors share one envelope, `{ error: { type, message, issues? } }`: 400, 401, 403,
404, 409, 500 and 503. Every 5xx and every refused capability answers a fixed message
with no metadata; the server log gets one short line without the error object.
Every response carries the header policy of ADR-0022.

### File collections

A `c.files` collection serves three generated endpoints, for signed-in people only, through
the same pipeline:

| Endpoint                               | Access                                       | Behaviour                                                                                                                             |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/files.<name>.upload/:owner` | `write` `on` the owner's dimension, `:owner` | the body is the file; `Content-Type` must be a declared type; `?name=` is the file name, metadata only. Answers `{ result: { id } }`  |
| `GET /api/files.<name>/:fileId`        | `read` `on` `file:<name>`, `:fileId`         | streams the object with the file treatment                                                                                            |
| `POST /api/files.<name>.remove`        | `delete` `on` `file:<name>`, body `{ id }`   | marks the row removed, then sweeps: deletes the objects of removed and orphaned files of the collection (at most 20), then their rows |

- **A file reaches what its owner reaches, now.** A file row carries its owner's key and the
  owner's whole containment chain under a composite foreign key with `ON UPDATE CASCADE`, so
  a move of the owner moves its files in the same statement. The locator of `file:<name>`
  reads the live row's chain on every request, and every operation after the access check —
  the pending insert, its completion, the download read, the remove — takes the minted `Ref`
  and is scoped by that whole chain in `@fabrika/db`. A move between the check and the
  operation therefore makes it match nothing (404): the request never acts on a file in a
  container the caller was not checked against. Deleting the owner orphans its files (every
  owner column becomes null) for the sweep.
- **An upload has two phases, and the row is the cleanup intent.** It inserts a `pending` row
  under a `FOR SHARE` lock of the owner row, matched on the owner `Ref`'s chain, then writes
  the object `<name>/<id>`, then flips the row to `live` under the same lock and chain. A move
  that starts during a phase waits for it; one that commits between them fails the
  completion. Whatever fails after the insert — the write, a lost answer of the store, the
  completion — deletes the object and the pending row, and when that fails too, the row stays
  for the sweep. The sweep deletes the objects and rows of removed and orphaned files, and of
  pending rows older than one hour (an upload fails after ten minutes), so it never touches
  an upload in progress; a failed delete is retried on its next pass.
- **The upload is checked while it streams.** A `Content-Length` over `maxBytes` is 413
  before the body is read; otherwise the object store stops reading past `maxBytes`, keeps
  nothing and the answer is 413. The first 512 bytes must be the declared type (415):
  each binary type by its signature, a text type (`text/plain`, `text/csv`,
  `text/markdown`, `application/json`, `image/svg+xml`) as UTF-8 without NUL bytes or a
  binary signature. `maxPerOwner` is counted before and again once the file is live (409),
  so concurrent uploads never leave more. The file name (`?name=`) is cut at 255 code points
  and loses its control characters.
- **The file treatment** is on every answer of the download endpoint, its denials and errors
  included: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
  default-src 'none'` and `Cache-Control: private, no-store`, and `Content-Disposition:
  attachment` on any body. The file itself gets `Content-Type` from the recorded type,
  `Content-Disposition: inline` only for PNG, JPEG, GIF and WebP, the file name as RFC 8187
  `filename*`, and `Accept-Ranges: none`: a `Range` request gets the whole file.
- **One table per collection**, `fabrika_files_<name>`, created by an application migration
  with `fileTableSql(name, { table, key, chain })` of `@fabrika/db`, where `chain` lists the
  owner's containment columns, nearest first; the owner table needs `UNIQUE (<key>, <chain
  columns>)`, as a child table's parent does. Codegen leaves the table out; only the
  framework reads it (`@fabrika/db/framework`'s `fileTablesOf`).
- `boot` refuses a collection whose name is not lowercase snake_case of at most 39
  characters, which admits a type the framework cannot sniff, which sets `link: true`, or
  which has no object storage or no `scoped(tables)` data layer. `serveContract` opens the
  storage (path-style S3, `@fabrika/platform-node`'s `S3BlobStore`) from
  `FABRIKA_APP_STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`; a
  partial set stops the boot. Downloads always go through the application: there are no
  presigned URLs.

A `Ref` and a `Within` are classes with private fields, bound to their request with
`AsyncLocalStorage`. `requestCapabilities` — the `CapabilityAuthority` of
`@fabrika/db` — refuses one the framework did not mint, one whose request has ended
and one from another live request. Each resolution returns a fresh frozen copy of the
facts fixed at mint, so changing a returned chain changes nothing the data layer sees.

## Membership, share links and the anonymous kinds

The framework asks IAM on the caller's behalf through `@fabrika/auth`'s `IamMembership`,
with the verified token, the proxy's `X-Request-Id` and the single-use grant the proxy
forwarded in `X-Fabrika-Delegation`. IAM checks the caller's live permissions, generates
every value and issues every key; the framework writes no grant and mints no credential.
IAM's refusal is the caller's answer (401, 403, 404, 409 for the last creator, 400 for a
request the schema cannot express); an IAM that cannot be asked is 503.

- `creates` hands `ctx.created`. Without the delegation grant the answer is 503 and IAM
  is not asked.
- `ctx.members` (`assign`, `revoke`, `list`) exists only on an endpoint whose action is
  its dimension's `members.manage`, and takes that endpoint's own `Ref`. One request
  carries one grant, so it makes one membership change.
- `ctx.links.issue(ref, { mount, days })` exists on an endpoint whose `Ref` carries a link
  mount's `issuedBy` for its dimension. IAM binds the key to the object's whole chain;
  the answer is `<prefix>/#<key>`.
- A link mount serves its share SPA at `GET <prefix>/*` with
  `<script src="<prefix>/__fabrika-share.js">` inserted as the document's first script.
  That bootstrap takes the key out of the fragment, removes the fragment with
  `history.replaceState` and keeps the key in a closure that `shareKey()` of
  `@fabrika/app/client` reads. A link procedure admits only a key of its own mount and
  re-reads where the object lies on every request: a key whose chain differs, because
  the note moved, is 404.
- `c.form` appends one row of its declared fields to its inbox table and answers
  `{ result: { received: true } }`: it reads nothing and runs no handler. The body limit
  is the framework's (413); the rate limit is a token bucket per form per instance
  (10 at once, then 10 a minute, 429), so it grows with the number of instances.
- `c.webhook` (GitHub) answers `POST <path>/:bindingId`. A holder of the bound
  dimension's `members.manage` creates a binding with the generated
  `POST /api/webhooks.<name>.bind` (`{ scope, account }`, where `account` is
  `installation:<id>` or `repository:<id>`); the framework generates the secret and
  answers it once with the URL. `webhooks.<name>.unbind` removes one. A delivery is
  checked in order: the binding (404), `X-Hub-Signature-256` over the raw body with that
  binding's secret (401), the payload's account (403), the input, parsed with its
  schema after every undeclared field is dropped (400), and the delivery key,
  `sha256(bindingId ‖ raw body)`: a key the binding already received in the last 30 days
  is answered 200 and not run again, whatever its unsigned `X-GitHub-Delivery` says (that
  header only names the delivery in the log). The handler gets `ctx.refs`, a `Ref` of the
  bound value for each declared action, and `ctx.delivery.key`. **It runs at least
  once**: a failing handler forgets the key so GitHub's redelivery runs it again, after
  whatever the failed run wrote, so a handler writes idempotently, keyed on
  `ctx.delivery.key`. Bindings and delivery keys live in the framework's `fabrika_*`
  tables, which `fabrika db migrate` applies.
- Revocation takes effect within the token lifetime: a removed member or revoked link
  keeps access until its cached token expires, at most 300 s (ADR-0022 rule 6).

## Jobs

A `c.cron` job of the contract gets one handler under `handlers.jobs`:

```ts
jobs: {
	purge: async ({ ctx }) => {
		for (const note of await notes.expired(ctx.within('notes.read', 'workspace'))) {
			await notes.remove(await ctx.ref('notes.delete', 'note', note.id))
		}
	},
},
```

Each crontab entry runs `fabrika job run <name>` in the application's container
(Zerops only: the lease lives in the application's Postgres schema). The command boots
the application exactly as `serveContract` does — the framework variables leave the
process first — and runs one job:

1. The run takes the job's lease in `fabrika_job_leases` (a framework table of
   `fabrika db migrate`). While another run holds it, this run does not start. Every
   lease time is the database's clock, so containers whose clocks disagree still agree.
2. Each attempt holds one generation of the lease and a deadline (its `timeout`,
   default 15 minutes). Every insert, update and delete of the data layer checks the
   generation and the deadline inside its own transaction, before the write and again
   just before `COMMIT`, with `statement_timeout` set to the time left. When an attempt
   ends, the runner cancels the statements it still has running. An attempt that timed
   out, failed or lost the lease commits nothing more (`LeaseLostError`).
3. An attempt that outlives its `timeout` is cancelled (`ctx.signal` aborts, its
   capabilities are refused) and fails. A failed attempt is retried up to `retries`
   times with jittered exponential backoff, under a new generation each time.
4. Failures are fixed codes: `timeout`, `lease_lost`, `handler_failed`,
   `driver_failed`, `crashed`, and `boot_failed` from the CLI. An application error's
   name and message are never logged or reported.
5. A run that failed after its retries, and a run that crashed (its lease expired
   before it finished), is a `JobFailed` error event in Operations. A job that has not
   succeeded within twice its period is `JobMissed`, at most once per period. The
   serving process registers every job when it starts and checks every job once a
   minute, so a schedule that never fires is reported too. Reports go through the
   application's own ingest (`FABRIKA_OPERATIONS_DSN`), and Operations alerts on the
   new issue. Operations ingests error events only: a successful run, its start and
   its duration stay in the lease row (backlog 96).

Job reports are informational, not authenticated: they use the public ingest key, so
whoever holds the browser DSN can forge one, as they can forge any error event.
Operations treats the `fabrika-job-*` fingerprints like any other. With platform
enforcement, the job's workload credential authenticates its reports.

A job has no caller and no token. Its `ctx` mints capabilities in process, for the
job's declared actions only: `ctx.within(action, dimension)` reaches every value
(`scope: 'app'`), and `ctx.ref(action, dimension, id)` locates one object, 404 when it is
missing. The principal of its writes is `job:<name>`. A job cannot create scopes, manage
members or issue share links. `boot` refuses a job scoped to a dimension (per-binding
jobs are not built), a job without `@fabrika/db`, a schedule that is not a five-field
cron expression, and a missing or undeclared job handler. With platform enforcement a
job runs with its own workload credential of principal kind `job`, which no mount
accepts (ADR-0022); until then the in-process mint is the whole of its authority.

## Connectors

An application reads another's data through a connector
([declarative application connectors](../ideas/declarative-app-connectors.md)): the owner exports queries,
the consumer imports them. v1 is read-only.

```ts
// the owner's contract
exports: {
	products: c.export({ version: 1, consumers: ['shop'], audience: 'any consumer user', procedures: {
		get: c.query({ input: BySku, output: z.nullable(Product), access: { action: 'catalog.product.read', over: 'catalog' } }),
	} }),
},
// the owner's handlers
handlers: () => ({ exports: { products: { get: ({ input }) => products.get(input.sku) } } }),

// the consumer: `fabrika connect add catalog/products@1 --origin=https://catalog.example.com`
// writes fabrika/connect/catalog.products.v1.ts with catalogProductsV1 and its digest
imports: {
	catalog: { app: 'catalog', export: 'products', version: 1, digest: catalogProductsV1Digest,
		procedures: ['get'], usedBy: ['api.products.show'], timeoutMs: 3000 },
},
// the consumer's implement()
connect: { catalog: catalogProductsV1 },
show: async ({ input, ctx }) => {
	const product = await ctx.connect.catalog.get({ sku: input.sku })
	return product.outcome === 'ok' ? { name: product.value?.name ?? null } : { name: null }
},
```

The owner side:

- Each procedure is `POST /__fabrika/connect/<export>.v<version>.<procedure>`, and the export's
  description — its schemas and `exportDigest` — is `POST /__fabrika/connect/<export>.v<version>`. The
  description has the callers and the requirement of the procedures it describes; in v1 every procedure of
  an export declares the same action in the same dimension.
- Their callers are the consumers' `app:<id>` and `machine`. Until Control reconciles connector
  credentials, an operator provisions one service principal per edge, with a `px_` key bound to the
  consumer's environment and holding the export's actions at the owner; that key is a `machine` caller.
  It also passes any other owner endpoint `machine` may call with those actions.
- An export handler runs read-only. The data layer refuses every write and lock in its request, whatever
  capability it carries, and reads in `READ ONLY` transactions — the access check's own reads included. An export may not declare an action a
  table writes with, nor one that manages members. Its context has no `ctx.connect` and no membership or file API.

The consumer side:

- `boot` checks each import against its vendored snapshot: same app, export and version, the import's
  digest, and schemas that still describe to that digest. It reads the owner's origin from
  `FABRIKA_CONNECT_<IMPORT>_URL` and the edge key from `FABRIKA_CONNECT_<IMPORT>_KEY` (`catalog` →
  `CATALOG`, `productCatalog` → `PRODUCT_CATALOG`). Both are framework variables, so no application
  module reads them; in part A an operator sets them, for example as secrets the app declares.
- `ctx.connect.<import>.<procedure>` exists only in the handlers `usedBy` names, and only for the
  request that received it: a method kept and called later, from another request or from an export
  handler is `denied` and sends nothing. A call validates its
  input against the snapshot and resolves to `ok`, `denied`, `invalid_input`, `unavailable`, `timeout`
  or `contract_violation`; it never throws for the owner's answer, and `unavailable` is never reported
  as `denied`.
- A deadline bounds every call and its retries: the import's `timeoutMs`, 3 s by default and at most
  10 s. A call is retried at most twice on `unavailable` or `timeout`, inside the deadline.
- The answer is validated against schemas the framework built from the checked snapshot. An answer
  that breaks them, that is not `application/json` or that is larger than 1 MiB is
  `contract_violation`, logged once with a fixed code and the schema's own path, so a drifted owner is
  caught on the first call. A redirect is `unavailable` and never followed; the deadline also cancels
  a body still being read.
- On Cloudflare a `FABRIKA_CONNECT_<IMPORT>` service binding to the owner's proxy Worker carries the call,
  its URL naming the owner's host; a binding routes by the binding, not by the URL. Elsewhere the call
  goes to the owner's public origin with `fetch`. Whether the Zerops balancer forwards `Authorization`
  unchanged is not verified yet ([zerops-platform.md](zerops-platform.md)).

## Runtime boundary

Routing, middleware, RPC, validation, and the client use Web Fetch API types.
Runtime adapters add process lifecycle without changing request behavior:

- `@fabrika/app/cloudflare` exports `createCloudflareWorker()`. It builds a
  Worker-shaped `{ fetch, scheduled?, queue? }` module from a `FabrikaApp`.
  Minimal structural types for the execution context, cron, and queues remain in
  this entrypoint. `createContractWorker()` boots a contract application with the
  first request's environment, verifying tokens through the `IAM` binding and serving
  the SPA from `ASSETS`.
- `@fabrika/app/bun` exports `createBunHandler()`. It binds one `FabrikaApp` to
  its process dependencies and returns `fetch()` plus `drain()`. It tracks every
  `waitUntil()` promise, reports rejected background tasks through a required
  callback, and drains all pending work during shutdown. A service that already
  owns a supervised execution context may inject it; that service remains
  responsible for draining the context. `serveContract()` boots a contract
  application on `PORT`, reads IAM's key set from the issuer's
  `/.well-known/jwks.json`, serves each SPA from its build directory and stops on
  SIGTERM.

Provider authoring remains separate: an app's `fabrika.config.ts` imports its
selected provider package. Portable request code imports `@fabrika/app`; only the
deployment entrypoint imports its runtime adapter.

## Runtime conformance tests

`@fabrika/app/testing` runs an equivalent fresh request through direct
`FabrikaApp.fetch()`, the Bun adapter, and the Cloudflare adapter. It normalizes
the response status, headers, and text body and can assert that all three values
match. The helper has no test-runner dependency.

Each execution receives fresh environment state and a fresh `Request`. Use these
tests for routes that are intentionally portable. Keep composition-specific
surfaces separate; for example, IAM's process health and shared-secret HTTP RPC
transports exist only in the Bun composition.

## The typed client of a contract

`@fabrika/app/client` is browser-safe. `createClient(contract, mount, options?)`
builds one function per procedure of an RPC or link mount from the contract value:

```ts
const api = createClient(contract, 'api')
await api.notes.remove({ id }) // POST /api/notes.remove, body {"id":"…"}
const shared = createClient(contract, 'shared', { key }) // POST /s/api/<procedure>
```

- The path is the one `compileContract` gives the procedure: `<prefix>/<dotted.path>`,
  and `<prefix>/api/<dotted.path>` for a link mount. A procedure without input sends
  `{}`.
- Only declared procedures exist, the input is typed by the input schema, and the
  answer is parsed with the output schema; an answer it refuses is an `RpcError` of
  type `invalid-response`, never a value.
- `key` sends a `px_` key as `Authorization: Bearer` and no cookie. A link mount's
  client needs it: the share key is the caller. In a browser, a client with a key
  refuses a `baseUrl` of another origin. Without a key the request is same-origin and
  carries the session cookie.
- An input that does not serialize rejects with an `RpcError`.
- An error envelope, or a proxy denial, is an `RpcError` with `type`, `httpStatus`,
  `issues` and `loginUrl`. `bounceOnAuth` sends the browser to sign in on a 401 that
  carries a login URL, as `createRpcClient` does.

## Testing a contract application

`@fabrika/app/testing` exports `testKit(app, options?)`. It boots the application as
its generated entrypoint would, for the audience `<app>@test`, behind the production
proxy decision and a stand-in for IAM; it has no test-runner dependency. An
application on `@fabrika/db` passes its connection as `options.database`, which the kit
hands to `boot` as a runtime adapter does; without one it does not boot.

```ts
const kit = testKit(notesApp(rows))
const editor = kit.testCaller([{
	role: 'editor',
	scope: { type: 'workspace', value: 'w1' },
}])
const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
```

- `kit.testCaller(grants, { kind, via })` makes a principal of the test IAM. A grant
  is an action or a role of the contract, global or in one scope; a role resolves to
  its actions in that scope, and a membership role needs a scope of its dimension.
  A human signs in with a session (`cookie`) or a `px_` key; `machine` and `link`
  callers present a key.
- `kit.fetch` takes a request as it reaches the proxy; `kit.browser(caller?)` adds
  what a page of the application sends: `Sec-Fetch-Site: same-origin` and, unless the
  request's credentials are `omit`, the caller's session cookie. Both refuse a host
  other than the application's.
- A caller whose token would exceed `MAX_ACCESS_TOKEN_BYTES` (8 KiB) is refused with
  403, as IAM refuses to sign it.
- Only test files may import the kit: `@fabrika/check` reports `test-only-import`
  for `@fabrika/app/testing` (and its subpaths), `@fabrika/db/testing`, or a test
  module, loaded from any other file, a directory index included.
- The proxy decision runs first, and it is production's: proxy-core's verify service
  over `contractProxyTable(kit.artifact)`, with the kit's IAM (`kit.iam`) behind it. A
  denial or a login answer reaches the test as the proxy sends it: canonical path (400),
  `planEndpoint` (no endpoint is 403), a `px_` key whose caller kind must be a caller
  (401 unknown, 403 wrong kind) or the session (401 when `human` is not a caller, the
  login answer when there is none), the requirement (403) and admission (cross-site
  403, media type 400). An allow forwards `X-Fabrika-Endpoint` as production does.
- A request loses every `X-Fabrika-*` header, `X-Request-Id` and the forwarding
  headers before the decision, and the `__Host-px_*` cookies before the application.
  It carries the proxy's token, signed by the kit the way IAM signs, and the real
  verifier and dispatcher answer it.
- `options.connect` wires each import: the owner's origin, the edge key, and the `fetch`
  that reaches the owner — usually another kit's `fetch`, so a connector call meets the
  owner's own proxy decision.

### The generated tests

**What they are for.** The generated tests catch the **mistakes** of an application's author,
who is usually an agent: a handler that serves another scope's rows, a cache keyed by
nothing, a policy that does not hold. They do not stop a deliberately hostile author, who
runs in the same process and can always subvert them. The data layer (`@fabrika/db`, A8–A10)
is the enforcement.

`fabrika db test-scaffold` writes two kinds of test and deletes a generated test it no
longer writes. Both run only for an application on `@fabrika/db`, and both open a test
database with `@fabrika/db/testing`'s `testDatabase`: a fresh schema `app_test_<hex>`
that the real migration runner fills from `db/migrations/`. Without
`FABRIKA_TEST_POSTGRES_URL` it prints the standard skip message and the file registers no
test; `FABRIKA_TEST_POSTGRES_REQUIRED=1` turns that into a failure.

- **Throwaway schemas.** A schema is held by a session-level advisory lock derived from its
  name, taken before it exists and kept for its whole life. Every test database first drops
  the `app_test_*` schemas whose lock it can take (a run that crashed or was killed) and
  never one whose lock is held (a live run, in any process). A schema is dropped again when
  its migrations fail, and `close` runs every cleanup step. Every application plan refuses a
  migration that names `public`, an `app_…` or a `fabrika…` schema, quoted or not, so neither
  the test run nor `fabrika db migrate` can reach a live schema; names resolve through the
  runner's `search_path`.
- **Seeding.** Every seeded row lies in one of two containment chains that share no value,
  with each container row a table owns. Every text column the fixture fills, nullable or
  not, holds a distinct marker; a required column of another type gets a sample of its type.
  A required foreign key outside the containment chain cannot be filled, so such a column
  needs a default or must be nullable.
- **Policy isolation tests**, `src/db/__tests__/<table>.policy-isolation.test.ts` for
  every dimension and child table, from the policies alone. They prove that the data
  layer enforces the declared policy, not that the application uses it:
  `policyIsolationKit` serves the table through a probe contract over the
  application's vocabulary, booted by `testKit` on a data layer of its own, so a request
  takes the production path and only the handler is the kit's. The caller holds every
  action of the table in the grant dimension of one row: a dimension table's container,
  or its own dimension at the top; a child's parent's. The cases: the own row is read,
  updated and removed, and a list and a count reach it alone; the other row is 404 for
  get, update and remove; insert into the other scope is 403; a child row is also 404
  through the caller's own parent with the other key; a `Ref` for the read action is
  refused by update and remove; a column with its own read action is never returned.
  Insert into a top-level table is checked only for the other scope: the `in` form
  answers 404 for an object that does not exist yet.
- **Endpoint access tests**, one file `src/__tests__/endpoint-access.test.ts`, from the
  contract. `endpointAccessKit` boots the application's own `src/app.ts` (its default
  export) through `testKit`, on the application's own data layer, once: that layer
  binds once per process. For every procedure with an `on` or `in` access form, a
  caller holding the action in one scope names the other scope's object or value and
  gets 404 (`on`) or 403 (`in`). For every `on` and `over` procedure, a caller of the
  other scope asks first, then a caller of one scope asks for its own; the second answer
  must be a 200 that holds no key, scope value or text marker of the other scope's rows.
  `deps` runs with an empty environment.
- **Inputs.** A case sends a fixed literal written into the test: a sample of the input
  schema, or, where the scaffold cannot sample one (a `regex`), the author's literal from
  `src/__tests__/endpoint-access.fixtures.ts` (`export const fixtures = { '<endpoint id>':
  { … } }`, plain literals only, read statically within the reader's budget). A missing
  fixture and a fixture of no tested endpoint are `endpoint-fixture` findings; an input the
  endpoint's schema refuses fails its cases. The access form's `from` field is replaced by
  the seeded value.
- **Registration.** The generated files take `test`, `describe`, `expect` and `afterAll` from
  `@fabrika/app/testing/isolation`. The platform run preloads `@fabrika/app/testing/preload`,
  which captures Bun's own functions before any application module loads, and a case that
  ran no `expect` fails. The checker refuses `mock.module` of `bun:test`, of `@fabrika/*`, of a
  generated test and with a computed specifier (`mock-module`). The kits refuse to load or
  run in a process the generated entrypoint started (`markProductionProcess`, one
  non-configurable property of `globalThis` that every installed package copy reads).
- **What neither kind catches:** an application bug that needs other data or another
  order of requests, such as a cache keyed by something the test does not vary.
- **`move` has no case yet.** An access form hands a handler one capability, and a move
  needs the source and the target `Ref`, so no handler can call `t.move`.
- `@fabrika/check` regenerates every generated test from the contract, the policies and the
  fixtures it reads statically and compares the files byte for byte: a missing, edited or
  replaced one (header or not) and a generated test the scaffold no longer writes are
  `generated-test-hash` findings. `bunfig.toml` may not set `[test] root`,
  `pathIgnorePatterns` or `retry` (`skipped-test`).
- **The platform runs them** at container start on Zerops, after `fabrika db migrate`
  and `fabrika db codegen --verify` (the build has no database): `fabrika db
  test-isolation` runs exactly the generated files with an empty `bunfig.toml` and the
  platform's preload, against a throwaway schema of the application's database, and fails
  unless every case name the scaffold wrote is reported as passed, with an assertion, in the
  JUnit report. It prints none of the tests' output, only the counts and the failed case
  names, because a dependency may write a credential into it; `--verbose`, which the start
  script never passes, prints the output locally. A failure leaves nothing to answer the
  readiness check.

## The agent skill

`@fabrika/app`'s `skill/SKILL.md` (the skill `fabrika-app`) is the one text that tells a coding agent how to write a
contract application: the contract first, tables and policies, migrations and codegen, the generated tests, what the
checker refuses, and what is not built yet. Three places carry it, all read through `@fabrika/app/agent-skill`:

- `fabrika builder init` installs the file verbatim as `.claude/skills/fabrika-app/` and `.agents/skills/fabrika-app/`;
- Control's MCP server answers its body from the read-only tool `get_app_rules`, which its `instructions` name;
- the template's `AGENTS.md` is `renderAgentsFile`: the body under a generated-file marker. The template does not
  carry it yet.

Change the rules in that file only, and keep it to what is built.

## What the platform writes into an application

A deploy writes a small, fixed set of names into the deployed application's environment on every
provider — `managedEnvironment`. They are not application configuration: each is one value per
installation or per deploy that the control plane is the only thing to know, so an application neither
commits them nor sets them, and an application VARIABLE of the same name is refused at deploy
([ADR-0035](../decisions/0035-the-platform-owns-the-application-iam-issuer.md)).

| Name                                                           | What it is                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `FABRIKA_IAM_ISSUER`                                           | The IAM origin: the `iss` of every token the app verifies, and its JWKS base    |
| `FABRIKA_IAM_APP_ID`                                           | The IAM application id `<app>@<env>`: the `aud` of every token the app verifies |
| `FABRIKA_RELEASE`                                              | The deploy-scoped release name                                                  |
| `FABRIKA_OPERATIONS_DSN`                                       | The browser-safe public ingest DSN for this application environment             |
| `FABRIKA_APP_ID`, `FABRIKA_ENVIRONMENT`, `FABRIKA_SERVICE_KEY` | The ingest coordinates that DSN reports under                                   |

A name whose value the installation cannot supply is REMOVED from the service rather than left stale —
an app verifying against a previous installation's issuer is worse than one that fails to boot.

Everything else an app needs per environment is its own `pipeline.vars`, which are inputs to the app's
CONFIGURATION rather than its runtime environment: the deploy makes each declared name available while
the app's config is compiled, and the config decides what to do with it. A variable the artifact does
not declare is refused where it is set.

## Browser error reporting

Fabrika supplies an application's Operations ingest settings as two managed
runtime values:

- `FABRIKA_OPERATIONS_DSN` is a browser-safe public DSN scoped to one application
  environment.
- `FABRIKA_RELEASE` is the current deploy-scoped release name.

Applications may pass these two values to a browser, but must not expose other
runtime configuration. The Zerops notes example demonstrates this boundary at
`/operations-sdk` and initializes `@sentry/browser` **10.69.0** from a JSON
config response containing only `dsn` and `release`.

The tested compatibility profile is deliberately narrow. Fabrika accepts the
SDK's envelope authentication query and an `event` item for a captured browser
exception. It parses the exception, JavaScript stack frames, release,
environment, level, tags, and optional SDK fingerprint used for grouping.
Non-event items are not processed; bounded item types such as `client_report`
are ignored when an envelope also contains an event. Tracing, sessions, replay,
logs, metrics, and general Sentry protocol compatibility are not supported by
this witness.
