# Application runtime

`@fabrika/app` is the first-party server framework for applications deployed by
Fabrika. An application declares one contract with the staged kit and serves it through `serve`
([ADR-0012](../decisions/0012-fabrika-app-runtime.md)).
The package also holds typed RPC, structural error handling, object-level
authorization, a typed browser client, and the dispatcher of the installation's own
services.

## An application in the staged kit

Every application is built in the same six steps, each typed by the ones before it. Where each file lives and what
it may import is the [application architecture](application-architecture.md).

```ts
// src/vocabulary.ts — the authorization vocabulary
export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Write notes',
		'notes.delete': 'Delete notes',
	},
	roles: { editor: { grants: ['notes.read', 'notes.write', 'notes.delete'] } },
})

// src/db/tables.ts — the table policies; containment is derived from the vocabulary
export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note' },
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.delete',
		},
		insert: ['title', 'trashed'],
		update: ['title', 'trashed'],
		version: 'version',
	},
})

// src/app-kit.ts — the kit
export const app = defineApp(vocabulary, tables)

// src/notes/endpoints.ts — endpoints with their handlers beside them
export const notes = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		output: NoteList,
		access: { action: 'notes.read', over: 'workspace' },
	})
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.within.notes.list()).items.map((row) =>
				fromRow(Note, row)
			),
		})),
	remove: r.mutation({
		input: Versioned,
		output: Done,
		access: { action: 'notes.delete', on: 'note', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: ctx.target.value }
		}),
}))

// fabrika.contract.ts — the mounts that compose the groups
export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
}))

// src/app.ts — the composition entry the generated entrypoint and `fabrika job run` load
export default serve(contract, { database: scoped(tables) })
```

- `defineVocabulary`, `defineApp` (`@fabrika/app/contract`) and `defineTables` (`@fabrika/db/tables`) build the
  shell; `fromRow` comes from `@fabrika/app`, `serve` from `@fabrika/app/implement`, `scoped` from `@fabrika/db`, and
  `columns` from the generated `src/db/schema.generated.ts`.
- `ctx.target` is the capability (a `Ref`) the access form minted; its id is `ctx.target.value`. `ctx.db.target` is
  the data handle bound to it ([The staged kit's data handles](#the-staged-kits-data-handles-ctxdb)).
- A handler that needs more than the handles give declares it on its endpoint — `sql`, `unscoped`, `connect`,
  `issues`, `binds`, `signs`, `kicks` or `egress` — and the approver sees the declaration. Jobs (`app.cron`), webhooks
  (`app.webhook`), share links (`app.link`) and exports (`app.export`) take their handlers the same way.
- A declaration states where a request enters, who may send it, how it is admitted, what it carries and what reach the
  code behind it holds. It never performs an application operation: every request that touches application data runs
  a handler ([ADR-0012](../decisions/0012-fabrika-app-runtime.md)). A procedure that anyone may call declares
  `access: { public: true }` and the `actions` its handler holds ([Public procedures](#public-procedures)).
- The shell is literal: the reader and Control read each module as its slice, without the `.handle(…)` bodies.
- `defineVocabulary` also takes `locale` (`'en'` or `'cs'`) and `displayName`: the language and the name of the
  application on IAM's sign-in, password and invitation pages and e-mails. The artifact carries each only when it is
  declared, so a contract without them keeps its digest; `schemaFromContract` hands them to IAM, and a change is a line
  the approver reads.

## Serving surfaces

Two surfaces serve requests. Both dispatch through `planEndpoint` from
`@fabrika/auth-core`, the matcher the proxy selects with, so a request reaches the
endpoint whose rules the proxy applied:

- **A contract application** declares `fabrika.contract.ts` from groups whose endpoints carry their handlers, and
  serves it with `serve` (`@fabrika/app/implement`). The generated entrypoint that
  `fabrika app build` writes boots it: `serveContract()` from `@fabrika/app/bun` on
  Zerops, `createContractWorker()` from `@fabrika/app/cloudflare` on Cloudflare. See
  [Contracts](#contracts) and [Serving a contract](#serving-a-contract).
- **An installation service** (IAM, Delivery, Operations) declares a service contract
  with `defineServiceContract` and serves it with `serveService` (`@fabrika/app/service`).
  Per request `serveService` answers 400 for a non-canonical raw path, 404 when no row
  is selected, and 503 for a `service` row that arrives without the proxy's
  `X-Fabrika-Endpoint` for that row and its digest. It then calls the row's handler. An
  application may not import `@fabrika/app/service`; `@fabrika/check` refuses it.

A non-canonical raw path is `isCanonicalPath` from `@fabrika/auth-core` refusing it:
an empty segment, `.` or `..`, an encoded `/` or `\`, a malformed percent escape.

Endpoint paths support `:name` parameters and one terminal `*` wildcard. A trailing
`/` is significant and matched literally: `/a/` and `/a` are different paths, and a
`:name` never matches the empty segment after a trailing `/`. A wildcard below the
root needs the `/` before it: `/x/*` matches `/x/`, not `/x`; `/*` still matches `/`.
The most specific row wins: a literal segment beats a parameter, and a parameter beats
a wildcard. There is no fall-through to another row.

IAM, Delivery, and Operations are first-party reference services. They dispatch
through the same `serveService` on Cloudflare and Bun while retaining the protocol
surfaces required by their platform roles. See
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
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)): one
enforcement decision, in `@fabrika/proxy-core` over `@fabrika/auth-core`'s
`planEndpoint`, and the proxy is the only thing that runs it. Zerops uses Caddy plus
the shared TypeScript auth service. Cloudflare authoring creates a public proxy
Worker with a private application Worker child and the same authorizer. No
application makes the enforcement decision: `@fabrika/auth` exports nothing that can.

Enforcement is one of three layers that refuse a request; [`overview.md`](overview.md)
names all three. This section covers the first two — the endpoint decision and
object-level authorization. The third, admission, belongs to the services that accept
browser sessions and is described in
[`core-application-composition.md`](core-application-composition.md).

The proxy's endpoint decision and procedure requirements are complementary:

- The proxy selects one endpoint from the endpoint table, checks its caller kind,
  requirement and admission, and prevents unauthorized requests from reaching the
  private app service on both providers.
- The service verifies the proxy-injected `X-Fabrika-Token` locally against IAM's
  JWKS and builds the canonical `AuthContext` from `@fabrika/auth`: `boot` does it for
  a contract application, and an installation service's row handler calls
  `iam.authenticate(request)`.
- `.require(action, scopeResolver?)` calls `ctx.auth.can()` before the procedure
  handler. The optional resolver maps validated input and context to an
  application-owned `{ type, value }` coordinate.

A `.require()` check does not replace the proxy's decision. The proxy's decision
cannot replace an object-level check whose scope depends on application data.

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
`app.contract((c) => surface)` of the kit types it: actions come from the
vocabulary, roles list exact actions, every procedure declares `access`, RPC mounts
have no link caller (anyone reaches a procedure only through `access: { public: true }`), `from` names a string field
of the input, and loose
objects do not type-check. The kit's builders produce the same plain declarations as
`defineContract(vocabulary, (c) => surface)`, which stays the framework's own form:
`serve` refuses a contract no kit built. `compileContract(contract, tables)` validates what the
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
config Worker that binds `APP`. An application is protected by this table only: the proxy
manifest's strict parser refuses any other form, and both providers refuse a config or a
manifest that still declares `gates`.

- `contractProxyTable(artifact)` (`@fabrika/proxy-core/manifest`) emits every endpoint row's
  rules — kind, method, path, callers, requirement, admission and, only where declared, its cross-origin form
  (`crossOrigin`), its file-response profile (`response: 'file'`) and its `cache` — with its delegation and
  `requirementDigest`, the reserved prefixes, and the contract digest as `snapshot`. A field absent unless declared
  keeps the digest of every row without it, and an older proxy's strict parser refuses a row that carries one. The
  proxy selects one endpoint per request with `planEndpoint` and decides there
  (ADR-0022 rule 3); there is no fall-through to a broader path.
- `schemaFromContract(artifact)` emits the dimensions as scopes (with `in`, `creator` and
  `members`), the actions, the roles (a membership role with its scope, `assignableBy` and
  `external`, which lets an external principal hold it, ADR-0051),
  the link mounts by name, the delegations, and `contract: true`, which makes IAM refuse
  every wildcard written for the application. A delegation is an endpoint that spends
  membership authority: a `creates` endpoint, or one whose action is the `members.manage`
  action of the dimension its access form names. `links` and `delegations` are always
  present, so a reconcile drops a mount or an endpoint the contract no longer declares.

## Serving a contract

`@fabrika/app/implement` serves a contract with `serve(contract, { database, deps })`. Its handlers sit beside
their endpoints ([An application in the staged kit](#an-application-in-the-staged-kit)), so `src/app.ts` only
composes. The kit types each handler by its endpoint: a returned field the output does not declare, a handle its access form
does not give and a write in a query are type errors. `serve` refuses an endpoint, job or webhook without `.handle(…)`.
`defineDeps(build)` declares dependencies, which `build` makes at each boot from the application's own variables; a
handler reads them with `get()`. `scoped(tables)` of `@fabrika/db` has no connection, no locator and no handle of its
own; nothing reaches the database until `boot` binds it. An application without tables writes `defineApp(vocabulary)` and `serve(contract, { database: null })`; its handlers have no
`ctx.db`, and its `sql` declaration is a type error. `serve` takes only the object `app.contract` returned: a copy
loses what the kit keeps beside it (the handlers, whether it has tables) and is refused. The mirrored handler tree of `implement` is the framework's own test entry, not on the application surface.

`fabrika app build` writes `fabrika/entry.generated.ts` for an application with a
`fabrika.contract.ts`: `serveContract(() => import('../src/app'), process.env)` on
Zerops; on Cloudflare `createContractWorker(() => import('../src/app'), { migrations })` and
`export { FabrikaApplication }`, with `fabrika/migrations.generated.ts`, which holds every `.sql`
file of `db/migrations` by name and text ([On Cloudflare](#on-cloudflare)). The adapter
first takes every `FABRIKA_*` variable out of `process.env` and `Bun.env`, then imports
the application, so no module of it can copy one through `process.env`. The process's original environment
block (`/proc/self/environ` on Linux) still holds them. The adapter then calls
`boot(app, { environment, iam, assets, database, files, membership })`. For an application on `@fabrika/db`,
`serveContract` loads the data layer before the application and opens its connection as the runtime role
`run_<FABRIKA_APP_ID>`, derived from the provisioning credential `FABRIKA_APP_DATABASE_URL`, in the schema
`app_<FABRIKA_APP_ID>` its migrations created as the migration role `app_<FABRIKA_APP_ID>`
([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)). The runtime role has DML on the schema's tables
and no DDL, so no query of the application can create a trigger or write the migration ledger. The derivation happens
in a launcher: handed `FABRIKA_APP_DATABASE_URL`, `serveContract` and `runContractJob` load no application module and
run the same command again with `FABRIKA_APP_RUNTIME_DATABASE_URL` in its place, so the application's process never
holds the provisioning credential. Each process opens at most `FABRIKA_APP_DATABASE_CONNECTIONS` connections (10
without it), which a Zerops deploy sizes from the database's connection limit
([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md));
`boot` binds the layer to it and to its runtime's capability authority, once, and keeps the locator the
bind answers; the application receives neither. Only an object `scoped` created is bound.
Without a connection,
with a copy or a wrapper of the layer, or with a layer bound before boot, `boot` refuses
to start. `boot` verifies tokens for the audience
`FABRIKA_IAM_APP_ID` (`<app>@<env>`, whose application must be the contract's), reads
`FABRIKA_IAM_ISSUER` and `FABRIKA_OPERATIONS_DSN`, and refuses to start when
`FABRIKA_CONTRACT_DIGEST` is missing or is not `contractDigest` of the compiled contract
(ADR-0022 rule 5), when a job cannot run (see Jobs), when an
import has no matching snapshot or no owner, when a file kind
cannot be served ([Stored files](#stored-files)), when an `on` dimension or a link mount's dimension has no
table, when an access form reaches a dimension that lies in a container no table can
locate it in, when a webhook or a procedure with a rate bucket has no `scoped(tables)` layer (both write the
framework's tables), when a challenge's secret or site key variable is not set, when the contract declares token
purposes and `FABRIKA_TOKEN_KEYS` is not set ([Signed tokens](#signed-tokens)), when `FABRIKA_APP_ORIGIN` is not an
origin, when a job, a webhook or a public procedure has no workload key or the adapter supplies no token exchange,
when an SPA or a link mount has no asset server,
when an endpoint asks IAM for a scope, a membership change or a share link and the
adapter supplies no membership transport, or when a handler is missing or undeclared.
The membership transport is IAM's application entrypoint on the `IAM` binding on
Cloudflare, and `HttpIamMembership` on Bun: `POST <FABRIKA_IAM_RPC_URL>/membership/<method>`
with `FABRIKA_IAM_RPC_KEY` as the bearer. On Zerops Control issues that key per
application environment while the approved contract has an endpoint with a delegation
or a share-link mount, and the provider writes both variables (IAM's public origin and
the key); an application may not set either. The key pins the application id and adds
no authority: each operation still acts as the caller's token, and scope creation and
membership changes spend the proxy's delegation grant (a share link needs none, as on
Cloudflare). The surface serves no `requestDelegation`.

Where the hop is not a service binding, `boot` also takes the proxy secret
`FABRIKA_PROXY_SECRET` (ADR-0022 rule 5). The Bun adapter, which serves Zerops, and the
Cloudflare object refuse to start without one or with one shorter than 32 characters.
Control generates the secret once per application environment and keeps it in its
vault; the Zerops provider writes it to the application service and, under
`proxySecretVariable('<app>@<env>')`, to the namespace proxy, whose Caddy sends it as
`X-Fabrika-Proxy-Secret`. The Cloudflare provider declares `applicationHopSecret`, so every
Cloudflare environment gets one, as a Worker secret of the application Worker, which sends it
on its hop to the environment's Durable Object.

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
   scope, and under the `app` form that action held as a global grant (403);
7. admission: a request without `Authorization` that is not a `GET` needs
   `Sec-Fetch-Site: same-origin` (403). On a credentialed row the proxy sends a bearer request's
   `Authorization` as `Bearer <the minted token>`, never the caller's `px_` key, and sends a session request
   without one. Only its presence is read here. The body needs a `Content-Type` its row admits (400):
   `application/json` by default, `multipart/form-data` for an input with a file field (and JSON too while every file
   field is optional), `application/x-www-form-urlencoded` for `http.body: 'urlencoded'`. A `GET` has no body;
8. the rate buckets ([Admission and limits](#admission-and-limits)): each is charged before the body is read and stays
   charged whatever follows (429);
9. read the body within `limits.maxBytes` (413) and its deadline (408), parse it strictly (400), verify each
   signed token in it as it is parsed ([Signed tokens](#signed-tokens)), stage its file parts
   ([Stored files](#stored-files)), run the access form, remove the `from` field, call the handler, project the output
   through its schema (a union through its first branch that accepts the value), answer `{ result }`. The handler's
   `ctx.signal` aborts when the client leaves or `limits.timeoutMs` passed, counted from the last body byte. A
   `file('<kind>')` output answers the stored file the handler returned, and a `redirect()` output answers its target
   ([The HTTP shape](#the-http-shape)). An `attachment()` output answers
   a file instead: the rows the handler returned, encoded as CSV (`text/csv; charset=utf-8`,
   `Content-Disposition: attachment` with the declared name) or, for `format: 'xlsx'`, as one
   sheet of typed cells (`implement/xlsx.ts`), before the invocation's transaction commits; a
   file over its `maxBytes` or `maxRows` is a 500 with no file and no commit. The XLSX is the
   framework's own writer, without a dependency: a ZIP of stored entries (no compression)
   holding the six SpreadsheetML parts, about 3.5 KB before the cells. A number and a boolean
   are typed cells, a string column whose schema is `z.iso.date()` or `z.iso.datetime()` a
   date cell of the 1900 date system (a value before 1900-03-01 stays text), and every other
   value an inline string, which no reader evaluates as a formula, so XLSX needs no `'` escape.
   Characters XML cannot carry are written in SpreadsheetML's `_xHHHH_` escape.

| Form                                 | Hands the handler                                                     | Refuses with                                            |
| ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------- |
| `{ member: true }`                   | nothing                                                               | —                                                       |
| `{ action, over }`                   | `ctx.within`, or `all` for a global grant                             | 403 when no value holds the action, or over 1000 values |
| `{ action, in, from }`               | `ctx.target` with its containment chain                               | 403 not held, 404 missing                               |
| `{ action, on, from }`               | `ctx.target` with its containment chain                               | 404 when missing or not held                            |
| `{ action, creates }`                | `ctx.created`, the value IAM generated                                | 503 without the proxy's delegation grant; IAM's refusal |
| `{ action, app: true }`              | `ctx.app`, the action application-wide                                | 403 (at the proxy) unless the action is a global grant  |
| `{ capabilities: { <name>: … } }`    | `ctx.capabilities.<name>`, one `Ref` or `Within` per named capability | each capability's own refusal, in declared order        |
| `{ public: true }` (RPC mounts only) | no capability of a caller: the handler runs as its own workload       | — (admission only)                                      |

**Several capabilities.** `access: { capabilities: { request: { action, on, from }, records: { action, over } } }`
names at least two capabilities, each an `on`, `in` or `over` form. The proxy checks every requirement, and the runtime
mints each capability as its single form mints it, in declared order; the first refusal answers. Every `from` field is
removed from the input. The handler binds each with `ctx.db.on`, `ctx.db.in` or `ctx.db.over`; `ctx.target`,
`ctx.within` and `ctx.db.app` are an `Unavailable` there. An export, a `creates` form and an `app` form take no
`capabilities`, and no delegation is derived for such an endpoint, so it has no `ctx.members` or `ctx.links`
(`capabilities.test.ts`).

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
Every response carries the header policy of ADR-0022, and the proxy sets it again on the way out,
replacing whatever the application sent (`@fabrika/proxy-core/headers` is the one definition). Both drop a
report-only CSP, `Report-To`, `Reporting-Endpoints` and `NEL`; the proxy strips every header of a `1xx`.

### On Cloudflare

An application environment on Cloudflare runs in one Durable Object
([ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)). The
Worker's `fetch` (`createContractWorker`, `packages/app/src/cloudflare.ts`) removes `X-Fabrika-Tick`, sets
`X-Fabrika-Proxy-Secret` from `FABRIKA_PROXY_SECRET` and forwards the request to the object named `application` of its
`FABRIKA_APPLICATION` binding; its `scheduled` sends the object the minute tick with the controller's `scheduledTime`.

- **The object** (`FabrikaApplication`, `packages/app/src/cloudflare/application.ts`) answers an empty 404 to a request
  without the secret or with another, before anything else. Under `blockConcurrencyWhile` it captures the environment,
  imports the application, applies the framework bundle `fabrika` (`@fabrika/db/migrations-sqlite`) and then the bundle
  `app` (the application's `db/migrations/*.sql`, written in SQLite) to its SQLite, each migration once, in the ledger
  `fabrika_migrations` of the same database with the Postgres runner's identity and checksum rule, and boots it. The
  data layer is `openSqlite` (`@fabrika/db/sqlite`) over `ctx.storage`; the file store is the R2 bucket `FABRIKA_FILES`
  (`cloudflare/r2-files.ts`). An object instance whose boot failed throws that failure on every request; the failed boot is
  not kept, so the next instance boots again.
- **The invocation transaction is `ctx.storage.transaction`.** A request, a public procedure and a webhook delivery run
  from the handler to the commit inside its callback (`Invocation.enclose`), because while it is open the input gate
  also holds back the answers to the object's own I/O made outside it. The object serves no other event meanwhile, so
  the SQLite compiler drops every row lock (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`). Timestamps are UTC ISO text,
  booleans 0 or 1, and the scoped layer answers the same values as on Postgres.
- **The minute tick** starts every job due in its UTC minute, the file sweep among them, and the jobs' check, each past
  the 204 answer. A tick without an integer time is 400.
- **Refused on SQLite.** `boot` refuses a site that declares `sql` (`ctx.sql` itself refuses with `sql_dialect`): the
  classifier reads Postgres's grammar, and a Durable Object has no runtime role to bound raw SQL. It refuses a
  `scan: true` file kind, because no scanner runs on Cloudflare. The Cloudflare deploy refuses both before any effect.
- `cloudflare-runtime.test.ts` of `packages/app` runs the Worker, the object and the bucket in Lopata
  (`lopata/testing`); `@fabrika/db`'s `*-sqlite.test.ts` run the framework's statements on `bun:sqlite`
  (`bunSqliteStorage`, foreign keys on, transactions nested as savepoints, as workerd nests them).

### The staged kit's data handles (`ctx.db`)

A handler of the staged kit (`app.group(…)` with `.handle(…)`, its cron jobs and webhooks) reaches data through
`ctx.db`, which `boot` builds for its site from the capability the access form minted, the site's kind and its
declaration. `serve` puts each site into the handler tree as a `siteHandler(handler, declared)` leaf. The declaration
a site runs with is the approved artifact's (`ContractArtifact.declared`, which the contract's digest covers); a leaf
whose own `declared` differs does not boot. The API matrix:

| Access form        | query                                                                                                                                                                                                                                                                                                                                                  | mutation (adds)                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`               | `ctx.db.target.get()`; child tables `list`/`get`                                                                                                                                                                                                                                                                                                       | `getForUpdate()`, `update(v, { expectVersion })`, `remove({ expectVersion })`; child `insert`/`update`/`remove`                                         |
| `in`               | `ctx.db.target.get()` (the container); `.<table>.list`                                                                                                                                                                                                                                                                                                 | `ctx.db.target.<table>.insert(v)` for a table whose list dimension is the target and whose insert action is the endpoint's                              |
| `over`             | `ctx.db.within.<table>.list({ where, orderBy, limit, after })` (keyset), `count`, `aggregate`; every table whose chain holds the dimension                                                                                                                                                                                                             | — (a list write is not on the road: `unscoped` or `sql`)                                                                                                |
| `creates`          | —                                                                                                                                                                                                                                                                                                                                                      | `ctx.db.created.<table>.insert(v)`: the new scope's own row, then `in`-style inserts into it                                                            |
| `app`              | `ctx.db.app.<table>`: an application table's `list`, `count`, `aggregate` (read action) and `get(id)` (any action it names); every dimension and child table's `list`, `count`, `aggregate`, all rows, where the endpoint's action is its read action or one of its `appRead` (with that action's columns), and `count` only for one of its `appCount` | an application table's `getForUpdate(id)`, `insert(v)`, `update(id, v, { expectVersion })`, `remove(id, { expectVersion })` with the operation's action |
| `member`           | no application data                                                                                                                                                                                                                                                                                                                                    | no application data                                                                                                                                     |
| any                | `ctx.db.reference.<table>` reads; `ctx.principal`; `ctx.members` on, in or below a dimension with members (management for `manage`)                                                                                                                                                                                                                    | —                                                                                                                                                       |
| `on`, `in`, `over` | `ctx.db.app.<table>`: an application table's `list`, `count`, `aggregate` and `get(id)`, every row, where the endpoint's action is its read action                                                                                                                                                                                                     | — (no write: an `app` endpoint writes it)                                                                                                               |
| `capabilities`     | `ctx.db.on(ctx.capabilities.<name>)`, `.in(…)`, `.over(…)`: the handles of each capability's single form                                                                                                                                                                                                                                               | the mutation handles of each capability's single form                                                                                                   |
| `public`           | `ctx.db.app('<action>').<table>` of an application table: `list`, `count`, `aggregate` and `get(id)` under its read action                                                                                                                                                                                                                             | `insert(v)`, which answers only the new key; `update` and `remove` only of a row whose id a verified signed token carries                               |

"Target subtree" is the target's child tables and the dimension tables it contains. An `over` lists every table whose
containment chain holds its dimension, through the stamped chain column: `over: 'org'` lists tasks two levels down by
their `org_id`, with the same keyset pages, projection and hidden columns as the nearest container's tables. A job and a webhook bind the same
handles to a capability they minted or received: `ctx.db.on(ref)`, `ctx.db.in(ref)`, `ctx.db.over(within)`. A
workload site (a job, a webhook bound to `'app'`, a public procedure) acts application-wide by its declared actions:
`ctx.app('<action>')` mints an `AppCapability` of an action the site declares and its IAM token carries (refused
otherwise, `undeclared_action`), and `ctx.db.app('<action>')` is the `app` form's handle over it. A job reads through it
outside its transaction and writes through `tx.db.app('<action>')` inside it. A webhook bound to a dimension acts on its
bound value only: there `ctx.app` and `ctx.db.app` are an `Unavailable`. On a credentialed `{ action, app: true }`
endpoint `ctx.app` stays the capability its access form minted. A member
a site may not use is a type error at its call (`Unavailable`) and, should the types be defeated, a refusal that
names the same fix at runtime.

- **A table action names one action or a list** (`actions: { read: ['crm.read', 'catalog.read'] }`); any one of them
  allows the operation. With several read actions, a column's own read action hides it from the others, and a handle
  reads the columns of its own capability's action. The artifact keeps one action as its text and several as a sorted
  list, so a policy that names one action keeps its digest.
- **A public procedure's reach is narrow.** Its `ctx.db.app('<action>')` reaches application tables only. A read needs
  the table's read action. An insert reads nothing back: it answers the new key, which the data layer generated, and
  takes `onConflict: { do: 'nothing' }` only. An update or a remove needs its action, a versioned table and a row id that
  a verified signed token of the request carries, under `expectVersion`; an update answers only the new version. It
  never locks or claims a row, and `sql`, `unscoped`, `issues`, `connect`, `egress`, `binds`, mail and members do not
  exist there.
- **`insert(values, { onConflict: { columns, do } })`** writes idempotently on every insert handle: `columns` name a
  unique index the migrations create (the checker's `on-conflict-index` verifies it), `'nothing'` needs the insert
  action and writes nothing on a conflict, and `'update'` also needs the update action and updates the table's update
  columns in the same transaction, within the insert's own containment. It answers whether the row was inserted
  (`{ inserted }`).

- **A capability reads its own target.** A `Ref` of any action the table names reads its row and the rows of its
  subtree; every column that declares a read action other than exactly the capability's is left out of the
  statement, as it is out of the row type. A `Within` lists by the table's read action. A `Ref` of an action the
  table does not name reads nothing of it.
- **Application-wide data is the `app` form's.** An application table (`scope: { app: '<why>' }`, key `id` unless
  `key` names another, generated on insert) belongs to no dimension: no chain, no container, every other policy field
  as a dimension table's. Only an `app` endpoint and a workload site write it on the road: the proxy admits an `app`
  endpoint only for a global grant of its action, and a workload holds only the actions IAM signs for its key.
  `ctx.app` is that capability, and `ctx.sql.scope(ctx.app, table)` is every row of
  a table `ctx.db.app` lists for that action, refused for any other.
  The same handle reads every dimension and child table whose read action is the endpoint's, or one its policy names
  in `actions.appRead` (an export, a bulk send), with the columns of that action as a `Ref` of it reads them (a column
  whose own read action is another is left out of the row, its filters and its aggregates), and only counts it
  (`count({ where })`, no aggregate, whose groups would be values), reading no row, under one it names in
  `actions.appCount` (an operations counter); any other action is refused (`checkRecordReach` in
  `packages/db/src/store.ts`). So an audited export of every record is one `app` mutation of its own action that lists
  the records and inserts its log row into an application table whose insert action is the export's, and a global
  holder of only the read action is refused it by the proxy. Each `appRead` and `appCount` action is in the artifact
  (`actions.appRead`, `actions.appCount`), so a new one widens. A reference table stays read-only and
  migration-managed.
- **A scoped site reads an application table by its read action.** On an `on`, `in` or `over` endpoint (a link
  procedure and an export procedure too) `ctx.db.app.<table>` holds every application table: one whose read action is
  the endpoint's reads every row, as a reference table is read (`list`, `count`, `aggregate`, `get(id)`, the columns
  of the read action), and writes nothing; any other is an `Unavailable` that names its read action, and a
  `CapabilityError` at run time (`scopedApplicationRead` in `packages/db/src/store.ts`). The table's read action
  decides who reads it, so a code list an administrator edits is validated by reading it, and a log nobody scoped
  reads keeps an action no scoped endpoint holds.
- **Writes answer `{ id, version }`** (`{ id }` for a table without a version), never row data. A versioned table's
  `update` and `remove` take `{ expectVersion }`: a row that changed since is 409, a missing one 404. `update` takes any
  subset of the columns its action updates; one that sets none writes nothing, not even the version, and answers the
  row's current `{ id, version }`, with the same 404 and 409.
- **A column write action** (`columns: { assignee: { write: 'tasks.assign' } }` in `src/db/tables.ts`) lets a capability
  of that action update exactly those columns through `ctx.db.target.update` (or a child table's `update`); the
  table's update action keeps the rest and does not update them. The action reads its own target like any action the
  table names. It is part of the access snapshot, so a new one, or a column moved under one, widens.
- **A `date` column is `YYYY-MM-DD` text** in the generated types, every handle's rows, filters and writes; `fromRow`
  and `ctx.sql` read a `Date` as its day for a `z.iso.date()` field. A timestamp reads as a `Date` and a write takes a
  `Date` or strict ISO 8601 text with `Z` or an offset; `now`, a locale form or an impossible day is refused. `RowOf<typeof tables, 'tasks', 'tasks.read'>` (`@fabrika/db/tables`) is the row an action
  reads, for a mapper that takes rows.
- **`getForUpdate()`** is `SELECT … FOR UPDATE` on the target's whole chain, in a mutation `on` an object only: a
  precondition read that a concurrent write of the same row waits behind, so of two concurrent "reopen a won deal"
  requests one wins and the other sees the change and answers 409. The guard admits two other locks only: a
  destination's `FOR SHARE` and a claim's `FOR UPDATE SKIP LOCKED` ([Queues and claims](#queues-and-claims)).
- **A list is a keyset page**: at most `limit` rows (50 by default, 500 at most) in the order asked, the table's key
  last as the tiebreak, and `next`, the opaque cursor `after` takes, `null` on the last page. Filters and orderings
  name only the columns the capability reads. The cursor holds each order column as the database prints it, so a timestamp keeps its
  microseconds. Every capability reads the key and the version; a column policy on either is refused.
- **`ctx.db.unscoped.<table>`** exists only for the tables the site declares, in their mode: the scope predicate is
  `true`, every statement is still guarded and runs in the invocation's transaction, `'read'` refuses every write,
  an insert names the containment columns no capability stamps, and no declaration reaches a `fabrika_*` table. A
  reference table has no key, so its `get` is an `Unavailable` (read it with `list`).
  `boot` refuses a declaration of a table outside `src/db/tables.ts` and a query's `'write'`.
- **`fromRow(Schema, row)`** (`@fabrika/app`) turns a row into an output object: snake_case columns become the
  schema's camelCase fields, a `Date` its ISO text, an undeclared column is dropped, and the schema parses the rest,
  so a literal-string field the row types as text is checked.
- **A statement the database refuses** throws `DatabaseError` with its SQLSTATE only: the driver's message and detail,
  which can quote the failing row and its hidden columns, never leave the data layer.
- **Errors come from `@fabrika/app`** (`ConflictError`, `NotFoundError`, `BadRequestError`). `@fabrika/db`'s own
  `ConflictError` and `NotFoundError` stay internal and answer 409 and 404 by name.

**The transaction is the invocation's.** An endpoint request, a webhook delivery and a job's `ctx.transaction` each
run every statement of their handles in one transaction, opened by the first statement; it sets
`idle_in_transaction_session_timeout` (30 s), so a handler that waits on something else while it holds row locks
loses them. It commits after the handler returned, its output passed validation and an attachment's file was
encoded; a throw, a refused output, a file over its limit, a cancelled request or a statement the database refused
rolls it back, and nothing the handler wrote is kept. A request handler's `ctx.signal` aborts when the client leaves
or the handler runs past its `limits.timeoutMs` (10 s by default, at most 60 s, counted from the last body byte); its
transaction then cannot commit (`request_cancelled`). An endpoint the generated tests cover
calls no outside service: it records an outbox row in its transaction and a job makes the call, because the generated
tests boot without the application's variables and a call does not roll back. A call that is the request's whole
purpose lives in a `{ member: true }` endpoint, which they do not cover, and takes `ctx.signal`. No endpoint sends
e-mail: it has no `ctx.mail`, so it records the message and kicks the job that sends it ([Kicks](#kicks)). A query
and an export run in a `READ ONLY` transaction and refuse every write and lock before anything is sent. IAM (a
created scope, a membership change, a share link), object storage and a connector call never roll back: do the data
work first and the external call after. `ctx.sql` (`sql: 'read' | 'write'`) runs in the same transaction.

- **`` ctx.sql(Row)`…` ``** runs only on a site that declares `sql` (a job: `tx.sql`, inside `ctx.transaction`). On any
  other site the types make it an `Unavailable`, and at run time the call is refused (`undeclared_reach`, naming the
  declaration) before anything is sent; so is a job's `ctx.sql` outside `ctx.transaction` (`sql_outside_transaction`).
  `ctx.sql` has no scope predicate of its own: `${ctx.sql.scope(capability, table, alias?)}` interpolates the
  capability's whole predicate on that table, as the handles apply it — a `Ref`'s object and every link of its chain,
  a `Within`'s values, its container grants on their own columns, every row for `all`, none when empty, an `app`
  capability's every row — with each value a bound parameter. A fragment carries the action of its capability, and
  the tag checks it against what its own query block does with its relation. The tag lexes the statement into blocks:
  each `SELECT`, `INSERT`, `UPDATE` and `DELETE` opens one, which ends with the parenthesis it stands in or at the next
  block of its depth, so a subquery, a data-modifying CTE and an `INSERT`'s `SELECT` are blocks of their own, and
  `ON CONFLICT … DO UPDATE` is an `UPDATE` of its `INSERT`'s target. A fragment whose table and alias are the relation
  its block's `UPDATE` or `DELETE` writes (the target's alias, or its name without one) needs that operation's own
  action from the table's policy — for an `UPDATE`, also a column's own write action when every column its `SET`
  assigns declares that action, the rule a handle's `update` follows (a `SET` the tag cannot read to its end with
  certainty is refused to a column's own action) — and an `app` capability writes only application tables and a `Ref` or `Within`
  none. Every other fragment reads, another occurrence of the written table too (`from notes m`, a subquery), with an
  action the handles read
  the table with (any action the table names for a `Ref`, its read action for a `Within`, what `ctx.db.app` lists it
  for with an `app` capability, a scoped site's application table by its read action). A reference table as an
  `INSERT`, `UPDATE` or `DELETE` target is refused. A fragment that reaches its table for no use the site may make
  of it is a type error at the table argument (`FragmentTable`) and is refused by `scope` at run time; a fragment of
  another site is refused. The statement's own tables are not declared: `sql: 'read' | 'write'` stays one declaration
  per site, and an `INSERT` or a write without a fragment is the declared deviation the approver reviews.
  The fragment must be a conjunct: alone, joined by AND, at the top level of a WHERE or JOIN … ON clause whose top
  level holds no OR (`where (<filter>) and ${…}`); any interpolation inside a literal, a quoted name, a dollar body or a
  comment is refused, a fragment with no value included. A reference table needs no fragment.
  Every `${…}` is a bound parameter: the tag reads the template's static text with a `$n` placeholder for each value,
  so a value never becomes SQL, and a value inside a literal, a quoted name or a comment is refused. Before anything
  is sent the text is refused for more than one statement; any statement but `SELECT`, `WITH`, `VALUES` and `TABLE`,
  plus `INSERT`, `UPDATE` and `DELETE` on a `'write'` site (so DDL, transaction control, `SET`, `COPY`,
  `LISTEN`/`NOTIFY`, `LOCK`, `CALL`, `DO` and `MERGE`); a nested statement of another kind and `SELECT … INTO`; a
  qualified name outside the application's schema; any `fabrika_*` or `pg_*` name; a call outside the reviewed
  built-ins of `@fabrika/platform-node/sql` (a function the migrations declare is not one: `ctx.sql` does not know
  them). A `'read'` site also refuses a write anywhere in the statement and a locking clause; a query's transaction
  is `READ ONLY` under it. Values bind as scalars, a `Date` as ISO text, a list of strings or numbers as a Postgres
  array (`= any(${ids})`). Each row is parsed like `fromRow` (snake_case → camelCase, `Date` → ISO) and then by
  `Row`; Postgres sends `bigint` and `numeric` as text, so `count(*)` needs `::int` (or `z.coerce.number()`), and the
  error says so. The name rules are defense in depth; the runtime role (`run_<id>`, DML only) is the privilege
  boundary that bounds what an admitted statement does
  ([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)).

- **A webhook delivery is one transaction.** The delivery key is claimed first, outside it, under a lease (the
  handler's time limit plus 30 s); the handler's transaction completes the claim right before it commits. A handler
  that throws rolls its transaction back and gives the claim back, so the provider's redelivery runs it again from
  nothing. A claim whose lease passed without completion (a process that died before its commit) is taken over by the
  next redelivery; a completion that a takeover fenced out commits nothing (`webhook_claim_lost`).
- **A job reads outside its transaction and writes inside it.** `ctx.db` of a job attempt reads, each statement on its
  own; every write and `tx.sql` runs in `ctx.transaction((tx) => …)`, fenced by the attempt's lease. An attempt
  retries, so its writes are idempotent. There is no `ctx.jobs.enqueue`: work for later is a row a run claims
  ([Queues and claims](#queues-and-claims)). A site that declares `kicks` starts a run once it committed, and the
  schedule picks up the rest. The kick carries no payload, so the row stays the only record of the work
  ([ADR-0060](../decisions/0060-a-handler-kicks-a-declared-job-after-its-commit.md)).
- **Every handle is bound to its invocation.** A handle kept past its handler, called from another live request, from
  a request of another `boot`, or from an ended job attempt is refused (500, one log line) before it reads its
  arguments.

### Stored files

A file is a value in a table column, and the table's policy is the file's authority
([ADR-0061](../decisions/0061-a-file-is-a-value-in-a-table-column.md)). There is no generated file endpoint: an
upload, a list and a download are procedures the application declares.

```ts
// fabrika.contract.ts — a file kind: allowed types, a size bound, the scan. No owner, no actions, no endpoint.
files: { attachments: c.files({ types: ['application/pdf', 'image/png'], maxBytes: 10485760, scan: true }) },

// src/db/tables.ts — the column that holds the file, and the actions that read and write it
deal_attachments: {
	scope: { child: 'deals' },
	actions: { read: 'crm.read', insert: 'deals.write', delete: 'crm.delete' },
	insert: ['file', 'name'],
	files: { file: 'attachments' },
},
```

- **The column.** The application's migration writes `file uuid not null references fabrika_files (id)` (or a nullable
  one) and an index the column leads; the checker's `file-column-migration` refuses a declared file column without
  both. Reading the column under the table's read action is what lets a request serve or open the file, and writing it
  needs the action that writes that column.
- **The storage.** One framework table, `fabrika_files` (`0008_files.sql` of `@fabrika/db`'s migrations): id, kind,
  status (`pending`, `quarantined`, `live`, `rejected`), size, SHA-256, the sniffed type, the name, the object key
  `<kind>/<id>`, the scanned object version and the scan state, the scope value of its first dimensional reference,
  the request that created it, and a `legacy` marker. The bytes live in the object store under the object key; no two
  rows share an object.
- **A file field** is `file('<kind>')`, `z.optional(file('<kind>'))` or `z.array(file('<kind>')).max(n)` at the top
  level of a mutation's input. Such a procedure reads `multipart/form-data`: the first part is named `input`, carries no
  file name and holds the other fields as JSON; each further part is named after its file field, with a file name and a
  `Content-Type` the kind admits. While every file field is optional, the row also admits JSON. A request carries at most
  20 files. The body limit defaults to 64 KiB plus each field's files at its kind's `maxBytes`, at most 48 MiB, and
  must arrive within `max(30 s, maxBytes at 16 KiB/s)`. The `input` part takes up to the whole body limit; it is read,
  parsed and checked (strict input, honeypot, challenge) before any file byte. The whole body, each part's headers and
  delimiter included, holds at most the body limit plus 8 KiB and 128 bytes per part: a declared `Content-Length` past
  that is refused unread, and a body streamed without one is cut off once it passes it (413 `too_large` either way). A broken body is 400 `multipart`, a connection closed before
  its end 400 `aborted` (the sender's, never a reported failure), a body not complete in time 408. In the handler a
  file field is a file reference; on the typed client it is a `Blob`.
- **Staging.** An incoming file and `ctx.files.put('<kind>', bytes, { type, name })` are staged the same way. A
  `pending` row is committed first, on a connection of its own, never the handler's transaction; it is the cleanup
  intent. Then the object is written: its first bytes must be the declared type (415), it is bounded by the kind's
  `maxBytes` (413), and its size and SHA-256 are recorded. A text type (`text/plain`, `text/csv`, `text/markdown`,
  `application/json`, `image/svg+xml`) must be UTF-8 without NUL bytes or a binary signature. The name is cut at 255
  code points and loses its control characters. A `scan: true` kind refuses an empty file (400 `empty`). `put` exists
  in a mutation, a job, a public mutation and a webhook, never in a query; it works inside a transaction too, and its
  connection counts against the pool. A job puts a large file before its transaction, so the upload holds no row lock.
  After a known rollback the request deletes what it staged and nothing claimed; after an uncertain outcome (a lost
  commit answer, a crash) it deletes nothing, and the sweep decides.
- **Writing a column.** A file column takes exactly four values: an incoming file of this request's input, a file a
  `put` of this request created, a file reference this request read from another file column under that table's read
  action, or `null`. A string id is refused. The file must be of the column's kind, and its row is locked `FOR SHARE`
  while the write checks its status, so a file being deleted gains no reference. The first write claims a staged file:
  still `pending`, of this request and kind, within the pending grace (one hour). It becomes `quarantined` for a
  scanning kind, else `live`. The first reference from a table scoped by a dimension stamps the file's top-level scope
  value; a later reference from another top-level scope is refused. A reference from an application table stamps
  none. A handover writes the new reference before it deletes the old row, in one transaction.
- **Reading.** A row read through the data layer carries a file reference in each file column: `{ id, name, type,
  size, status }`, loaded for every row of the read in one statement. A reference read under an action that does not
  read the file (a `getForUpdate` under `update`) carries the metadata only: it can be neither served, opened nor
  written into another column. A file list is a query of the table that holds the column.
- **Serving.** `ctx.files.open(ref, { maxBytes? })` reads a file whole (`{ id, name, type, size, bytes }`), at most the
  kind's `maxBytes` unless the site asks for less (413 `too_large`). A procedure whose output is `file('<kind>')`
  answers the file its handler returned: a query is a `GET` by default, its input read from flat URL parameters, and a
  mutation is a `POST` that answers the file after its commit (a download that writes an audit row). The handler
  returns the reference, never a `Response`, and a file of another kind is a 500. Every byte consumer (a file answer,
  `open`, a mail attachment) reads only a reference the request holds and may read, and only a `live` file, by its
  scanned object version: a `pending` or `quarantined` file is 409 `file_not_ready`, a `rejected` one 409
  `file_rejected`, and one the sweep deleted since the read 404. Downloads always go through the application: there
  are no presigned URLs.
- **The file treatment** is on every answer of a row with the file-response profile (`response: 'file'`), its denials
  and errors included: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`,
  `Cache-Control: private, no-store` (or the row's `cache`, [The HTTP shape](#the-http-shape)), and a
  `Content-Disposition` whose type follows the exact `Content-Type` (`attachment` unless an inert image). The proxy
  applies the same treatment to the answer of the row it selected. The file itself gets `Content-Type` from the
  recorded type, `Content-Disposition: inline` only for PNG, JPEG, GIF and WebP, the file name as RFC 8187 `filename*`,
  and `Accept-Ranges: none`: a `Range` request gets the whole file.
- **Removing.** Clearing the column or deleting the row removes the reference. The framework's sweep job
  (`fabrika-file-sweep`, `FILE_SWEEP_JOB`, a reserved name, hourly at minute 41) first finishes the deletions a crash
  interrupted, then adopts the legacy files a declared column references, then deletes, in batches, every file past the
  pending grace that no declared column references. Each in three steps: one transaction deletes the file's row and
  records its object key in `fabrika_file_deletions` (the foreign key refuses the delete while a reference exists, and
  a write that holds the row `FOR SHARE` makes it wait); then the object is deleted; then the record. A failed sweep
  fails the run (`file_sweep_failed`), and the next run finishes it. The grace counts from the file's creation. On
  Zerops the crontab runs the sweep when the contract declares a file kind; on Cloudflare the object runs it on the
  Worker's minute tick.
- **Legacy files.** `0008_files.sql` copies the held files of every file collection of framework 0.6 and earlier into
  `fabrika_files` with their ids, marked `legacy`; the old `fabrika_files_<collection>` tables stay. The sweep never
  deletes a legacy file, and drops the marker once a declared column references it. The application adopts the files
  with its own migration and releases the collection with `fabrika_files_release('<collection>')`
  ([framework migrations](framework-migrations.md)).
- **`scan: true` holds every file until a clean malware verdict.** A claimed file is `quarantined` instead of `live`.
  The framework's scan job (`fabrika-file-scan`, a reserved name no `app.cron` job can take) runs every minute under
  its lease in `fabrika_job_leases`. It takes the due quarantined files of every scanning kind that waited longest first
  (at most 20 and 256 MiB; a file that failed before is scanned alone), so neither a busy kind nor a stream of new files
  holds an older file back. It reads each object whole with its version (an S3 ETag), checks its size and SHA-256
  against the staged ones, checks it as an archive, and hands the batch to one `clamscan` run in a private temporary
  directory, all under one five-minute deadline. Each verdict is written in a transaction fenced by the lease.
  - **Only a clean verdict over verified bytes promotes**, while the file is still quarantined, with the same digest;
    the row records the scanned object's version.
  - **ClamAV's OK does not vouch for an archive**: it skips entries it cannot decode (an LZMA entry, a
    damaged deflate stream) and still answers OK. So the framework reads every ZIP itself — Office Open
    XML documents are ZIPs — and rejects one with an entry other than stored or deflated, an encrypted
    entry, ZIP64, a CRC or size that does not match, bytes outside every entry, more than 1000 entries
    or 256 MiB unpacked, or a ZIP nested deeper than one level. Any other archive (gzip, bzip2, xz, 7z,
    rar, cab, zstd, lzip, lzma, tar), at the top or inside a ZIP, is rejected. ClamAV also finds a ZIP
    by its local header at any offset, so the check is coarse and fails closed: a ZIP-based type must
    start with its local header at offset 0, and a file of any other type — or an entry of a ZIP — that
    holds a ZIP local-header, central-header or end-record signature anywhere is rejected
    (`embedded_archive`). Random binary data holds one by chance about once per 1400 MB, so a rare
    compressed PDF or image is falsely rejected; that is the accepted cost. The end record must be the
    only one in the last 64 KiB, and its comment must end exactly at the end of the file and hold no ZIP
    signature (`ambiguous_directory`). A `scan: true` kind may not admit `application/gzip`.
    PDFs and images are ClamAV's to parse; an archive embedded inside a PDF's streams is a residual
    limit of ClamAV's own coverage.
  - **A rejection** (a `FOUND`: EICAR, an encrypted file, a file past ClamAV's size, recursion or time
    limits; a refused archive; a missing object) deletes the object, then marks the row `rejected`. A
    failed delete leaves the row quarantined and unserved and waits like a retry (one minute, doubled
    up to an hour), so failing deletes never fill every batch.
  - **No verdict** — a scanner error or timeout, a file the scanner skipped, bytes that differ from the
    staged ones — counts a try: the file waits one minute, doubled per try up to an hour, is then scanned
    alone, and is rejected after five tries. Missing or stale (older than three days) signatures and a
    missing scanner count no try. Every outcome is reported to Operations under a fixed code.
  - **A byte consumer reads only the scanned version**: one conditional read (`If-Match` on the recorded
    ETag) answers the bytes, so a replaced object answers 409 without a byte, and the file is quarantined
    again for the next pass; so is a live file without a recorded version. A new object key is written
    once: the store refuses a key that already holds an object.
  - A `scan: true` kind admits at most 100 MiB per file, the most the scanner reads in full. Turning `scan` off widens
    in the approval diff; a file left quarantined stays unserved.
- `boot` refuses a kind that admits a type the framework cannot sniff, and file kinds without object storage or
  without the `scoped(tables)` data layer. `serveContract` opens the storage (path-style S3, `@fabrika/platform-node`'s
  `S3BlobStore`) from `FABRIKA_APP_STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`; a partial
  set stops the boot. On Zerops the platform writes all four into the generated run section as `${<host>_…}`
  references to the application's one `object-storage` service, which must be a bucket the platform created for it. A
  job run (`fabrika job run`) gets ClamAV's `clamscan` from `PATH` as its scanner; on Zerops the build installs it for
  a contract with a `scan: true` kind (see [Zerops platform](zerops-platform.md)). On Cloudflare the store is the
  environment's R2 bucket (`FABRIKA_FILES`), and a `scan: true` kind is refused at deploy and at boot: no scanner runs
  there.
- A public procedure with a file field also needs `admission.rate.bytesPerHour`, a challenge and scanning kinds
  ([Public procedures](#public-procedures)). `stored-files.test.ts`, `files-handle.test.ts`, `files-removal.test.ts`
  and `file-scan.test.ts` of `packages/app` cover the runtime; `packages/db`'s `stored-files.test.ts` the data layer.

### Queues and claims

A table policy declares `queue: { attempts: '<column>', due: '<column>', maxAttempts? }` and a `version` column; it
needs an update action, and `<due>` is a timestamp column. The migration gives `<due>` a default of `now()` and allows
`null`. An insert may set `<due>`; `attempts` is the layer's. A row is waiting while `<due>` is set and done when it
is `null`.

- **A claim is a lease.** A job calls `claim({ limit, where? })` (`limit` at most 500) on `ctx.db.app('<action>').<table>`
  for an application table or on `ctx.db.over(ctx.within('<action>', '<dimension>')).<table>` for a dimension-scoped
  one, with the table's update action. It runs in a short transaction of its own, fenced by the attempt's lease, and
  commits: it selects rows with `<due> <= now()` (the database's clock) and attempts below `maxAttempts` (10 by
  default), `for update skip locked`, adds one attempt and moves `<due>` by the backoff: the job's schedule period (60 s
  without one), doubled per earlier claim, at most 30 days. It answers each row with the columns of its action, its new
  `version` and `ref`, a capability bound to that row.
- **The job finishes a row through `tx.db.on(row.ref)`** inside `ctx.transaction`: `.update(values, { expectVersion,
  done: true })` writes and clears `<due>` in one statement, `.remove({ expectVersion })` deletes the row with the
  table's delete action, and `.requeue({ at? })` sets `<due>` (now by default) and the attempts to zero.
- **The work runs after the lease, one transaction per row.** A failure or a crash leaves the row as the claim left it,
  due again after the backoff. Attempts count claims, so a job claims only what its run will reach. ADR-0060's lease
  keeps two runs of one job off one row.
- `claim` is refused inside `ctx.transaction`, in a request and in a query. A row past `maxAttempts` stays in the
  table, not due, for the application to show or requeue (`packages/db`'s `queue.test.ts`).

A `Ref` and a `Within` are classes with private fields, bound to their request with
`AsyncLocalStorage`. Each `boot` makes its own issuer: a mint, held only by that
call, and the `CapabilityAuthority` of `@fabrika/db` that its data layer, file
stored files and `deps` are bound to. The authority refuses a capability its runtime
did not mint, one whose request has ended and one from another live request. Each
resolution returns a fresh frozen copy of the facts fixed at mint, so changing a
returned chain changes nothing the data layer sees. An application that loads
`capability.ts` by URL, or boots a second runtime with IAM keys of its own, mints
only what the served runtime's stores refuse. This hardening stops mistakes and makes
a bypass conspicuous; application code stays trusted in-process
([ADR-0012](../decisions/0012-fabrika-app-runtime.md) §8 says what it does not stop).

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
  carries one grant, so it makes one membership change. Its `list` answers each member's
  `email` and `lastSignInAt`: IAM records a person's last sign-in to the application when
  its proxy redeems the handoff code (`app_sign_ins`), and answers it only to a holder of
  `members.manage`, as personal data like the address.
- On every other endpoint `on` or `in` a dimension that declares members, or one below it,
  `ctx.members` is a read-only directory of the nearest such dimension, at the value the
  `Ref`'s chain holds: a deal endpoint reads its org's. The artifact records each endpoint's
  reach (`directories`, derived by `directoryReach` and read by `endpointDirectory` of
  `@fabrika/auth-core`). `ctx.members.get(principalId)` answers that member (`principalId`,
  `label`, `disabled`, `affiliation`) or `null`; IAM's `findMember` requires the endpoint's own action, one
  of the dimension's reconciled `lookups`, held on the org itself (a grant on a company does
  not count), so an assignment validates the person it stores without a second action.
  `ctx.members.list()` (with `roles`) exists only where the action is the directory's
  `members.list`, and IAM checks that action live on the directory's value, so a caller who
  holds it only below (on a company) is refused 403. No delegation grant, no email, no
  invitation. `label` is `null` unless the dimension declares `directory: 'labels'` in
  the vocabulary (a user's label spells its address); that declaration is in the contract,
  and adding it widens for closer review. Under it the type is `string`, and the framework
  refuses an IAM answer without a label (`iam_answer_unlabelled`, 500).
- **The application's own people.** A vocabulary that declares `members: { manage, list }` (and optionally
  `directory: 'labels'`) has people of its own: every principal holding one of its roles, globally or in a value. An
  `app: true` endpoint whose action is that `members.list` gets `ctx.members.list({ after? })`, a page of at most 100
  `{ principalId, label, email, lastSignInAt, roles: [{ role, scope }], disabled, affiliation }`, and `next`; IAM's
  `listAppMembers` checks the action live, held globally. Labels by the vocabulary's `directory` or to its
  `members.manage`; `email` and `lastSignInAt` only to `members.manage`. A holder of `members.manage`, globally,
  grants and revokes the application's global roles in IAM's console (`appPeople.*` of IAM's administration API),
  within its own actions and audited by IAM; the application builds no role management. Any other endpoint's
  `ctx.members` is unavailable for the application's people, and the approval reads a new `members` or
  `directory` as a widening for closer review.
- `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` exist on an endpoint
  that declares `issues: '<mount>'` and whose `Ref` carries the mount's `issuedBy` for its
  dimension. IAM binds the key to the object's whole chain; the answer is
  `{ id, url: '<prefix>/#<key>', expiresAt }`. The issuer, or a holder of `members.manage`
  on the chain, revokes it; a token minted from it still works until it expires (300 s).
- A cron job that declares `issues: '<mount>'`, with the mount's `issuedBy` and every grant
  among its actions, gets the same `ctx.links`. It issues for
  `await ctx.ref('<issuedBy>', '<dimension>', id)` and asks IAM with its own token; IAM
  admits a job only for the mount the approved schema records with it, and the job revokes
  only links it issued. The job is app-wide for that mount: the link is bound to one object,
  the job is not. A webhook issues nothing. The `url` is a path: the job prepends the
  application's public origin from its own configuration before it e-mails the link.
- **A terminal** ([ADR-0067](../decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md)). A
  vocabulary that declares `terminal: { identify: '/path' }` names its identification page: an absolute path that a
  public SPA mount serves, where IAM sends an enrolled terminal's browser with `?identification=<id>`. Its RPC and
  public procedures get `ctx.terminals`: `inspect(id)` answers the terminal and the expiry, or `null`;
  `assert(id, principalId)` answers `{ ok: true, callbackUrl }`, which the page navigates to, or `{ ok: false, reason }`
  (`not_found`, `invalid_principal`); `cancel(id)` ends an abandoned one. They ask IAM over the membership transport with
  the request's credential, a public procedure's workload token. IAM refusing the application's own credential is a 500
  (`terminal_refused`), IAM out of reach a 503. The application throttles guesses per terminal and signs the person out
  at `/__fabrika/auth/signout?redirect=<path>`. `boot` refuses such a contract without the transport; the test kit
  answers every identification `not_found` unless `options.terminals` replaces it. Elsewhere `ctx.terminals` is
  unavailable.
- **The public intake recipe** (a public page, a public procedure, a cron job, a link mount). A public procedure
  inserts a registration into an application table and answers `{}`; the job claims the registrations, creates the
  records, then delivers each record's
  link. It is the skill's outbox recipe: a run takes bounded batches (50, oldest first) and
  each record is its own work, in its own transactions. A record's failure adds one to its
  `attempts`, keeps a fixed step code in `last_failure`, and the run goes on; a delivery's
  failure also sets `next_attempt_at` one minute ahead, doubled per attempt up to an hour, so
  kicks seconds apart cannot spend its attempts during a short outage. A record that failed
  five times is dead (a registration left in its table, no longer due; a delivery `failed`), and so is a
  delivery whose send `ctx.mail.mayRetry` refuses; it is logged once by id and left to an
  operator, and a resend revives a dead delivery. A failure after the
  attempt ended is the attempt's, never the record's, so each e-mail has its own deadline
  inside the attempt's and a hanging one fails its record. Each registration is claimed
  (`claim`, [Queues and claims](#queues-and-claims)) in a short transaction of its own, and the job removes it and
  inserts the record in one transaction under the version the claim answered, so a row another session
  holds waits for a later run and blocks nothing behind it. A job's statements carry no
  scope fragment (a job is app-wide). IAM and the e-mail do not roll back with a
  transaction, so a delivery keeps four invariants:
  1. **It charges the budget first.** One transaction reserves an e-mail of the recipient's
     daily budget (a counter and a window in the row) before any effect, so a delivery that
     fails after its e-mail left still counts; without one left, the row waits for the next
     window as it is.
  2. **It records each step before the next effect**: revoke a superseded link → record it;
     issue → record the link id and its URL sealed (AES-GCM under the application variable
     `LINK_SEAL_KEY`, never in plain text) (`issued`); e-mail → record `sent` and drop the
     seal. The next run finishes a stopped delivery: a link in state `issued` may have been
     e-mailed, so it is sent again from its seal, never replaced; a link issued but not
     recorded was never e-mailed (its key existed only in the job) and expires with its
     `days`; IAM's `issue` takes no idempotency key, so that window stays. Before the
     e-mail the row is `sending`: a run that finds it so (a crash, a lost answer) sends it
     again only over a transport that deduplicates a key, and otherwise makes it dead,
     because the e-mail may have arrived.
  3. **An effect starts only while the attempt is live**: `ctx.signal.throwIfAborted()`
     before each revoke, issue and e-mail, and `ctx.mail.send` aborts with `ctx.signal`. The
     runner aborts the signal before a replacement attempt starts, and `ctx.links` and
     `ctx.mail` of an ended attempt call nothing, so no effect of a stale attempt follows its
     replacement's.
  4. **The link is the delivery's identity**: the e-mail's key is `intake-link-<link id>`,
     behind the application environment's prefix, and a retry sends the same message under
     it, so an idempotent transport sends one e-mail per link even when its answer or the
     commit after it was lost.

  A resend (a second public procedure, `{ email }`) records a request that marks an unverified record due while its
  budget has an e-mail left; the job revokes the sent link before it issues the next. The recipe's test
  e-mail is an outbox of its own: a mutation (`access: { action: 'mail.test', app: true }`,
  `kicks: ['testMails']`) records a `test_mails` row for the caller's address, and the
  `testMails` job sends it under the same rules. Verification is
  application state: a link mutation sets `verified_at` once under `getForUpdate`, and every
  later call answers the same; the link itself is not single use, and IAM's revocation is
  the stop, which a warm proxy cache honours for at most 270 s (the token's 300 s less the
  30 s refresh skew). `packages/app`'s `intake.test.ts` holds each stop, the replaced
  attempts and the budget, and `packages/iam`'s `visitor-link.test.ts` the recipe against
  the real IAM through the proxy.
- A link mount serves its share SPA at `GET <prefix>/*` with
  `<script src="<prefix>/__fabrika-share.js">` inserted as the document's first script.
  That bootstrap takes the key out of the fragment, removes the fragment with
  `history.replaceState` and keeps the key in a closure that `shareKey()` of
  `@fabrika/app/client` reads. A link procedure admits only a key of its own mount and
  re-reads where the object lies on every request: a key whose chain differs, because
  the note moved, is 404.
- An SPA mount below the root also has a row for its bare prefix, `GET <prefix>` (id `<mount>.prefix`), under the
  mount's own access: the application answers it with a 308 to `<prefix>/`, the query kept. Without it `/admin` would
  be the root SPA's path (`/*`) and open another mount's page.
- `c.spa(prefix, { dir, access: { public: true } })` serves the SPA at `GET <prefix>/*`
  to anyone: the row is the anonymous kind `public-spa`, so the proxy reads no credential,
  forwards no token and never bounces to login. The page reaches only the anonymous endpoints
  (a public procedure); every other call still needs a session. `{ public: true }` takes no other key.
- Revocation takes effect within the token lifetime: a removed member or revoked link
  keeps access until its cached token expires, at most 300 s (ADR-0022 rule 6).

## Public procedures

A procedure that anyone may call declares `access: { public: true }` and the `actions` its handler holds
([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)):

```ts
const stats = app.group({}, (r) => ({
	cta: r.mutation({
		input: CtaClick,
		output: Empty,
		access: { public: true },
		actions: ['stats.click'],
		admission: { rate: { perClient: 300, perEndpoint: 300 } },
		limits: { maxBytes: 1024 },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('stats.click').cta_clicks.insert({
			campaign: input.campaign,
		})
		return {}
	}),
}))
```

- **Where.** Only a procedure of an RPC mount (`app.group`) may be public. A group whose procedures are all public
  declares no callers (`app.group({}, …)`); a group's `callers` applies to its credentialed procedures. A mount takes
  the callers of its credentialed groups, `[]` when every group is public. The row is the anonymous kind `public`: no
  callers, no requirement, no delegation, and the proxy forwards no credential that arrives on it. A proxy that does
  not know the kind refuses the manifest instead of serving it without the admission rules.
- **Its own workload.** The handler holds what IAM signs for the endpoint's own key, as a job and a webhook do. The
  workload is named by the full endpoint id (`api.stats.cta`), so one group mounted twice is two workloads.
  `schemaFromContract` hands IAM `{ kind: 'public', name, actions }`; IAM refuses a schema in which any role grants a
  public action, so a role change cannot widen it. Control issues one key per public procedure of the approved
  contract and writes it as `FABRIKA_PROCEDURE_<ID>_<8 hex of the id's SHA-256>_KEY`, rotated and revoked like a job
  key. `boot` exchanges it at IAM's workload token path, checks `ptype: 'public'` and the workload name, and keeps the
  token until shortly before it expires. With IAM down and the cached token expired the call is 503. On Cloudflare the
  key is a Worker secret.
- **What the handler gets.** `ctx.principal` is `{ kind: 'public', endpoint }`. `ctx.app('<action>')` and
  `ctx.db.app('<action>')` mint only for a declared action the token carries
  ([The staged kit's data handles](#the-staged-kits-data-handles-ctxdb) says what the handle reaches). `ctx.files` puts
  and opens stored files, `ctx.kick` and `ctx.tokens` exist where `kicks` and `signs` declare them, and `ctx.client`,
  `ctx.url` and `ctx.signal` are there as on every procedure. A public procedure declares no other reach: `sql`,
  `unscoped`, `connect`, `issues`, `binds` and `egress` are refused at build.
- **`ctx.client`** is `{ ip, userAgent }` on every procedure. `ip` is the proxy's `X-Fabrika-Client-Ip` where the
  runtime adapter vouches that the proxy saw the visitor (Cloudflare and the test kit); on Bun, and so on Zerops, it is
  `null` until [backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md) settles the balancer's trusted range.
  `userAgent` is cut at 256 characters. It is information, never a check.
- **The honeypot** is a helper: `if (honeypot(input.website)) return {}` (`@fabrika/app`) answers what a real
  submission answers and does nothing.

**The order of a public request**, with the answer of each refusal:

1. The proxy: the row, the body codec, the origin rule (403).
2. The proxy secret and the endpoint header (403, 503).
3. The in-flight share (503), then every bucket the procedure has, charged before the body is read and kept whatever
   follows (429).
4. The bounded body and the strict input, signed tokens verified as it is parsed (413, 408, 400).
5. The workload token, before the challenge spends a token (503).
6. The challenge (400).
7. The file parts, staged as pending files ([Stored files](#stored-files)), so a refused visitor stores nothing.
8. The handler, the output, the commit and the kicks, in one transaction.

`public-procedure.test.ts`, `public-admission.test.ts` and `public-kick.test.ts` of `packages/app` cover it.

### Admission and limits

Every procedure takes `admission: { origins?, rate?, challenge? }` and `limits: { maxBytes?, timeoutMs? }`. The
artifact records each procedure's effective rules (`procedures[<id>]`), and the approval prints them
([ADR-0050](../decisions/0050-approved-access.md)).

| Bound                       | Default                                                                                    | Ceiling         |
| --------------------------- | ------------------------------------------------------------------------------------------ | --------------- |
| `limits.maxBytes`, no files | 64 KiB                                                                                     | 1 MiB           |
| `limits.maxBytes`, files    | 64 KiB + each file field's count × its kind's `maxBytes`                                   | 48 MiB          |
| the body's deadline         | `max(30 s, maxBytes at 16 KiB/s)`: a 10 MiB body gets about 11 min (408 past it)           | —               |
| `limits.timeoutMs`          | 10 s, counted from the last body byte                                                      | 60 s            |
| files per request           | each field's `.max(n)` together                                                            | 20              |
| `admission.rate`            | public mutation: `perClient` 10 and `perEndpoint` 100 a minute; anything else: no bucket   | 10 000 a minute |
| `rate.bytesPerHour`         | required with a public file field                                                          | 64 GiB          |
| public in-flight share      | a quarter of `FABRIKA_APP_DATABASE_CONNECTIONS` (10 by default), for all public procedures | —               |

- **Buckets.** `perClient` counts by the client address and exists on public procedures; `perCaller` counts by the
  verified principal and exists on credentialed and link procedures; `perEndpoint` counts every call. A declared `rate`
  merges into the default, and `null` turns a default bucket off. Each bucket is a counter per database minute in the
  framework's `fabrika_form_admissions`, shared by every instance, and taken with its own statement before the body is
  read. A bucket is a database write, so a public query has none unless it declares one. An IPv6 client counts by its
  /64, and a request without the address header shares one `unknown` client; on Zerops that is every request until
  backlog 05, so there `perClient` counts one client and the approval says so.
- **`bytesPerHour`** is charged the body's declared `Content-Length`, at most the body limit, or the body limit without
  one, before the body is read (`fabrika_form_bytes`, 429 once it no longer fits). A browser declares the length of a
  string, a form or a `Blob` body, so an honest request is charged what it sends; a body streamed without a length
  (chunked) is charged the whole limit. The test kit's `fetch` declares the length of such a body too, and leaves a
  `ReadableStream` body without one.
- **The challenge**, on a public procedure only, by provider. The input carries the widget's token as the string field
  `challengeToken`. `action` is the widget's action, at most 32 letters, digits, `_` and `-` (what Turnstile admits,
  and a path segment); by default the endpoint id with `_` for `.`, and the build refuses a default longer than that
  and an action two procedures share. The artifact records the effective one. A passed token is recorded under the
  action in `fabrika_form_challenges` as long as it could pass again, so a second use is a replay whatever the provider
  answers.
- **ALTCHA**: `challenge: { provider: 'altcha', secret: '<VARIABLE>', action?, cost?, maxAgeMs? }`. The application
  issues and verifies it itself, with the HMAC key the variable holds, and asks no one. The build adds a row of its own
  (source `challenge`, id `<endpoint>.challenge`): `GET /__fabrika/challenge/<action>`, anonymous, from the procedure's
  `crossOrigin`, no body, with buckets of its own (`CHALLENGE_ISSUE_RATE`: 30 per client and 600 a minute, each at
  least twice the procedure's; where the procedure turned one off, the issuer keeps its own, since every issue costs a
  derivation), under the reserved prefix
  `/__fabrika/challenge`, so a path below it no row serves is 404; the artifact refuses a challenge without exactly
  that row. It answers a fresh PBKDF2/SHA-256 challenge signed over its parameters: `cost` iterations per attempt
  (5000 by default, 1000 to 18 000), a counter drawn from 1 to 10 000 that the browser counts up to (from 1, so no
  solver can skip attempts the widget makes), the action and the request's host, and an expiry `maxAgeMs` away (ten
  minutes by default, a minute to an hour). The build refuses a `cost` whose worst draw a slow phone (2 million
  iterations a second over its workers) would not solve within the widget's 90 s or half of `maxAgeMs`
  (`altchaSolvable`). `boot` refuses a key under 32 characters: every challenge publishes a signature made with it. The server knows the attempt that solves it and signs that attempt's key
  with a second key derived from the variable, so verifying is two HMACs and no proof of work. A payload of another
  shape (the widget's `test` mode, a server-signed one), another host or action, an expired or forged one is 400
  `challenge_failed`; nothing is 503, since nothing remote can be down. The replay record keys on the challenge's
  signature, not the token, so a solution re-encoded as other JSON is the same replay. The test kit and
  `fabrika app dev` issue the cheapest challenge (`MINIMAL_CHALLENGE_WORK`, `BootOptions.challengeWork`) and verify it
  as production does; `kit.solveChallenge(api.<procedure>)` fetches one through the kit's proxy and solves it. The page
  fetches it from `challengeUrl(api.<procedure>)` of `@fabrika/app/client`, and `@fabrika/ui/challenge` renders the
  widget, bundled with the page. Its workers start from `blob:` URLs, so the CSP gains `worker-src 'self' blob:`
  (`csp.workerSrc`, which only the build writes) and no origin.
- **Turnstile**: `challenge: { provider: 'turnstile', secret: '<VARIABLE>', siteKey?: '<VARIABLE>', action? }`.
  Turnstile's siteverify
  checks it (5 s, a 16 KiB answer, the request's host, the procedure's `action`, a token at most
  300 s old), and the token's digest is the replay record. A failed or replayed
  token is 400 `challenge_failed`, an unreachable provider or a refused secret 503. Only `fabrika app dev` admits one
  token again (`BootOptions.repeatableChallengeToken`), the one Turnstile's always-passing test widget hands out. The
  secret is the application variable the contract names; without it the application does not boot. Every SPA mount
  serves the site key in its browser config ([Browser error reporting](#browser-error-reporting)), and Turnstile's
  origin joins `script-src` and `frame-src`.
- **A public file field** requires `bytesPerHour`, a challenge and scanning file kinds.
- **`origins`** is `'same-origin'` by default. `'listed'` admits the origins the environment lists
  ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) "Cross-origin endpoints"): on a credentialed
  procedure with a `px_` key only, never a session. `'any'` admits every origin, on a public procedure only. The row
  records it as `crossOrigin: 'environment'` or `'any'`.

### The HTTP shape

`http: { method?, query?, body?, cache?, path? }` describes the wire independently of the output:

| Field    | Rule                                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method` | `POST` by default. A query may declare `GET`, and is `GET` by default when its output is a file or it declares `cache`. A mutation is `GET` only when it is public and its input holds a required `signedToken`; it then answers `redirect()` or a schema, never a file. An export is always `POST`. |
| `query`  | a `POST` only: a flat schema of URL parameters, handed to the handler as `query` beside the body's `input`.                                                                                                                                                                                          |
| `body`   | `json` by default; `multipart/form-data` when the input has a file field; `urlencoded` for flat scalar fields without files.                                                                                                                                                                         |
| `cache`  | a public `GET` query only: `{ maxAgeSeconds }` (1 s to a year) or `'immutable'` (a year, for an input that names a value that never changes, such as a file id).                                                                                                                                     |
| `path`   | a public procedure only: a literal path of its own (`'/register'`) instead of `<prefix>/<dotted.path>`, for a caller on another origin or a published URL. Not under `/__fabrika`, and not equal to or under any mount's prefix or path but the root SPA's. The endpoint id stays the procedure's.   |

- **URL parameters.** A `GET` input and a `query` are flat scalar fields in their canonical spelling (a number as
  `String(n)`, `true`/`false`, `null`). A name sent twice and an unknown name are refused (400); a URL over 8192
  characters is 414.
- **`cache`.** A successful (200) answer gets `Cache-Control: public, max-age=<n>`, or `public, max-age=31536000,
  immutable`, in place of `no-store`; an error or a redirect keeps `no-store`. The framework, the Cloudflare proxy
  Worker and Caddy apply it from the row (`@fabrika/proxy-core/headers`). Every other answer is `no-store`.
- **`redirect({ origins? })`** is an output: the handler returns `{ to }`, and the framework answers 303 after a `POST`
  and 302 after a `GET`. A target is a path of the application's own origin, a URL of an origin `origins` lists, or an
  `http(s)` URL a verified signed token of this request carries. Any other target is a 500 and a log line, never an
  open redirect, and the transaction rolls back. A request whose `Accept` names JSON and not HTML (the typed client's)
  gets `200 { result: { to } }` instead, and the caller decides whether to navigate.
- **A `GET` mutation** changes state on a navigation, which a link scanner may trigger; the approval says so. A session
  mutation is never `GET`: a top-level navigation carries the session cookie.
- **Browser admission.** The proxy enforces it per row ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)):
  a session request that is not a `GET` needs `Sec-Fetch-Site: same-origin`; a session `GET` reaches a query only; a
  bearer from another origin needs the row's `'listed'` origins and its preflight; a public `multipart/form-data` or
  `urlencoded` body (no preflight) needs an `Origin` of the application itself or one its row admits, where a request
  without `Origin` passes and `Origin: null` does not. A public `GET` mutation is admitted by the application: a valid
  signed token in its input.

## Kicks

A mutation (of an RPC, link or public procedure), a webhook or a cron job declares `kicks: ['<job>']` and calls
`ctx.kick('<job>')` ([ADR-0060](../decisions/0060-a-handler-kicks-a-declared-job-after-its-commit.md)).

- `ctx.kick` is request-bound and accepts only the declared names. A kick carries no payload: the row it looks at is
  the only record of the work.
- Kicks are deduplicated per job and sent after the output validated and the transaction committed. A thrown handler,
  a refused output, a cancelled request and a failed commit kick nothing. A procedure without a transaction kicks once
  its answer is built. A job's kicks are sent after its lease is released.
- The serving process starts one run in the background (`waitUntil` where the runtime has one, detached otherwise)
  under the job's own key, never the request's. A kick waits for no lock, so it never holds a connection requests
  need: when it cannot take the lease at once it sets the shared flag `fabrika_job_kicks.pending`, and the run holding
  the lease runs the job once more after it succeeded. Every run clears the flag when it starts, so at most one run is
  active and one is pending whatever the number of kicks and instances; after a failed run the flag waits for the
  schedule.
- The schedule stays the recovery path: a kicked run that dies before its commit leaves its rows to the next scheduled
  run (`public-kick.test.ts`, `mutation-kick.test.ts`). On SIGTERM a Bun server first aborts the kicked runs in flight:
  a stopped run frees its lease as failed with the code `stopped`, logs that its schedule runs it again, and reports
  nothing to Operations. It then stops accepting requests and waits at most 10 s for the rest of its background work
  before it closes the database.
- The build and the checker refuse `kicks` on a query, a read-only site and an export, a name that is no cron job of
  the contract, and a cycle of kick edges between jobs. The artifact records the edges as
  `declared[<site>].kicks`, absent unless declared. The approval shows a new edge; from a public procedure it widens
  with closer review, because anyone who calls it then decides when the job runs.

## Webhooks

```ts
export const stripe = app.webhook('/hooks/stripe', {
	scheme: 'stripe',
	boundTo: 'app',
	actions: ['billing.record'],
	input: StripeEvent,
}).handle(({ input, ctx }) =>
	ctx.db.app('billing.record').payments.insert(
		{ stripe_id: input.data.object.id, state: input.type },
		{ onConflict: { columns: ['stripe_id'], do: 'update' } },
	)
)
```

`app.webhook(path, { scheme, boundTo, actions, input, limits?, kicks?, signs?, egress?, sql?, unscoped? })` answers
`POST <path>/:bindingId`.

- **The verifier** is `scheme`, computed by the framework with the binding's secret; a verifier is never application
  code.

  | `scheme`                                                | What the delivery carries                                                                                   |
  | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `'github-sha256'`                                       | `X-Hub-Signature-256: sha256=<hex>` over the body                                                           |
  | `'stripe'`                                              | `Stripe-Signature: t=<s>,v1=<hex>` over `<t>.<body>`; any `v1` of a rotated secret                          |
  | `'standard-webhooks'`                                   | `webhook-signature: v1,<base64>` over `<webhook-id>.<webhook-timestamp>.<body>`, with a `whsec_` secret     |
  | `'slack'`                                               | `X-Slack-Signature: v0=<hex>` over `v0:<X-Slack-Request-Timestamp>:<body>`                                  |
  | `'twilio'`                                              | `X-Twilio-Signature`: base64 HMAC-SHA1 of the public URL and a form's sorted parameters                     |
  | `{ hmac: { header, algorithm, encoding, prefix?, … } }` | the declared header: `sha1`, `sha256` or `sha512`, `hex` or `base64`, over the body or `<timestamp>.<body>` |
  | `{ basic: true }`                                       | `Authorization: Basic …` whose password is the secret; the user name is not checked                         |
  | `{ bearer: true }`                                      | `Authorization: Bearer <secret>`                                                                            |

  A signed timestamp must be within five minutes. A `slack` or `twilio` row admits an urlencoded form as well as JSON,
  read into the input as a procedure's form is (a repeated name is 400). Slack's `url_verification` request is answered
  `{ challenge }` once its signature verifies, and no handler runs. Twilio's public URL is `FABRIKA_APP_ORIGIN` with the
  request's path and query, and a JSON body is covered by its `bodySHA256` parameter; a `twilio` delivery where the
  environment has no `FABRIKA_APP_ORIGIN` is a 500 `webhook_unverifiable`. A `basic` or `bearer` row declares `authorization: 'forward'`,
  so the proxy passes the sender's `Authorization` on without reading it, unless it carries a `px_` key
  ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 3).
- **`boundTo`** is a dimension or `'app'`. A webhook bound to a dimension gets `ctx.refs`, a `Ref` of the bound value
  for each declared action. One bound to `'app'` has one binding for the whole application, and its handler mints
  `ctx.app('<action>')` and reaches `ctx.db.app('<action>')` as a job does.
- **Binding.** A credentialed RPC mutation that declares `binds: '<webhook>'` gets `ctx.webhooks('<webhook>')`:
  `bind(capability, account)`, `setSecret(capability, id, secret)` and `unbind(capability, id)` take this request's
  `Ref` of the bound dimension or its `AppCapability` for `'app'`, and write in the mutation's transaction. `bind`
  answers the URL and a generated secret once (`WebhookSecret`). A provider that issues its own secret (Stripe, Slack,
  Twilio) shows it after the URL is registered; `setSecret` replaces the generated one with it and answers `false` when
  the value has no binding of that id. A secret is 1 to 512 printable characters without spaces, a `standard-webhooks`
  one is `whsec_` and base64, and a `basic` or `bearer` one never contains `px_` (400 otherwise). The framework keeps
  the bindings in its `fabrika_*` tables.
- **A delivery** is checked in order: the binding (404), the signature (401), for `github-sha256` the account its
  payload names (403), the input, parsed with its schema after every undeclared field is dropped (400), and the
  webhook's credential (503 when IAM refuses its key, cannot be asked, or signs a token without a declared action; a
  delivery that cannot run is one the provider must redeliver). Then the delivery key, `sha256(bindingId ‖ raw body)`,
  is claimed under a lease ([The staged kit's data handles](#the-staged-kits-data-handles-ctxdb)): a key the binding
  completed in the last 30 days, or one another delivery holds, is answered 200 and not run again, whatever the
  provider's unsigned delivery header says. The handler gets `ctx.delivery.key`, and `ctx.files` to put and open
  stored files. **It runs at least once**, so it writes idempotently: `insert(…, { onConflict })` needs no `sql`.
- **Limits.** `limits.maxBytes` is 1 MiB by default and at most 48 MiB, so an inbound mail can carry its attachments
  for `ctx.files.put` (each within its kind's `maxBytes`); the body is read within the deadline it derives.
  `limits.timeoutMs` is 10 s by default and at most 60 s.
- A webhook has a key of principal kind `webhook` (`FABRIKA_WEBHOOK_<NAME>_KEY`), one per webhook declaration. Not
  covered: a provider that validates its URL with a `GET`, or that needs an answer body of its own other than Slack's
  challenge.

## Signed tokens

A purpose is declared once, in the kit's options, with its claims and its longest lifetime:

```ts
// src/app-kit.ts
export const app = defineApp(vocabulary, tables, {
	tokens: { unsubscribe: token(Recipient, { maxDays: 400 }) },
})
```

- **Verifying.** `signedToken('<purpose>')` is a top-level field of a procedure's input or its `http.query`. The
  framework verifies it as it parses the input: an HMAC-SHA256 over the key id, the purpose, the expiry and the claims,
  then the claims parsed again by the purpose's schema. The handler receives the typed claims. An invalid token and an
  expired one are 400, and the answer says nothing about the keys. A token in an export or a webhook input, anywhere
  but at the top level, or of an undeclared purpose is refused at build.
- **Signing.** A procedure of an RPC mount, a job or a webhook declares `signs: ['<purpose>']` and calls
  `ctx.tokens.sign('<purpose>', claims, { days })`, with `days` at most the purpose's `maxDays` (3650 at most). An
  export and a link procedure never sign.
- **Keys.** Control keeps each environment's keys in its vault (`app_env_token_keys`) and writes them as
  `FABRIKA_TOKEN_KEYS`, the signing key first; `boot` refuses a contract with purposes when it is not set. A token
  carries its key's id. `apps.environments.rotateTokenKey` asks the next deploy of one environment to rotate. A
  retired key keeps verifying until its retirement plus the largest `maxDays` the contract had while it signed, so a
  400-day unsubscribe link survives a rotation; a key no token can carry any more is deleted. On Cloudflare
  `FABRIKA_TOKEN_KEYS` is a Worker secret, never a plain variable.
- A token is single-purpose and no credential: it opens no mount. Single use and revocation are the application's
  state. The artifact records `tokens` (claims and `maxDays`) and `declared[<site>].signs`; the approval shows a new
  purpose, a lifetime change and a site that starts signing (`signed-tokens.test.ts`).

**Links to the application's own procedures.** `ctx.url('<endpoint id>', { input?, query? })` exists on every site
(a procedure, a webhook, a job). It answers the environment's canonical origin (`FABRIKA_APP_ORIGIN`, which Control
writes on every deploy), the procedure's path, and the parameters its HTTP shape reads from the URL: the input of a
`GET`, the `query` of a `POST`. An unknown endpoint, a parameter the shape does not read and an environment without an
origin are refused; a malformed origin refuses the boot. The checker's `url-endpoint` refuses a literal endpoint id
that names no procedure.

## Outbound calls

`egress: ['https://api.example.com']` on a credentialed procedure, a webhook or a job declares the exact HTTPS origins
its code calls: no path or wildcard, at most 16, each once. `boot` wraps the global `fetch` once; while a staged-kit
site's handler runs, a call to an origin the site does not declare is refused (`capability_refused`,
`undeclared_egress`). A site that declares none, a public, link or export procedure included, reaches no origin. The
framework's own requests (mail, connectors, IAM, workload tokens, the object store, the JWKS) run outside the site's
scope. The guard stops mistakes and makes a bypass conspicuous; it is no sandbox: code that kept the `fetch` it found
before boot, or opens its own sockets, escapes it ([ADR-0012](../decisions/0012-fabrika-app-runtime.md) §8). The
checker's `cross-app-fetch` accepts an absolute URL whose static prefix is an origin some site declares, and the
approval lists every origin (`egress.test.ts`).

## A mount's compatibility promise

`c.rpc('/api/v1', groups, { compatibility: 'backward' })` promises the export's rule to the callers of an RPC mount
(`'unchecked'` is the default). Control refuses a publication that removes a procedure, makes its input or `http.query`
accept less, or changes its output, its HTTP shape (method, path, body codec), its file answer or its access, and one
that removes or moves the mount (`MountCompatibilityRefused`), whoever approves it. A breaking change is a new mount
beside the old one. The approved side's promise binds, so a deploy that drops it is still held to it; the next one is
free (`mount-compatibility.test.ts`).

## Jobs

An `app.cron` job takes its handler beside it, and the contract mounts it under `jobs`:

```ts
// src/notes/endpoints.ts
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.read', 'notes.delete'],
	limits: { timeoutMs: 300000 },
	retries: 2,
})
	.handle(async ({ ctx }) => {
		const trashed = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes
			.list({ where: [['trashed', '=', true]] })
		await ctx.transaction(async (tx) => {
			for (const note of trashed.items) {
				await tx.db.on(await ctx.ref('notes.delete', 'note', note.id)).remove({
					expectVersion: note.version,
				})
			}
		})
	})

// fabrika.contract.ts
export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	jobs: { purge },
}))
```

On Cloudflare the Worker's one `* * * * *` cron trigger forwards the minute tick to the environment's Durable Object,
which starts every job due in that UTC minute and the jobs' check, each past its answer; the leases live in the
object's SQLite. On Zerops each crontab entry runs `fabrika job run <name>` in the application's container, and the
lease lives in the application's Postgres schema. The command boots
the application exactly as `serveContract` does — the framework variables leave the
process first — and runs one job:

1. The run takes the job's lease in `fabrika_job_leases` (a framework table of
   `fabrika db migrate`). While another run holds it, this run does not start. Every
   lease time is the database's clock, so containers whose clocks disagree still agree.
   A run clears the `fabrika_job_kicks.pending` flag a kick leaves when it starts,
   and runs once more when the flag is set again by the time it succeeded.
2. Each attempt holds one generation of the lease and a deadline (its `limits.timeoutMs`,
   15 minutes by default, at most 24 hours). Every insert, update and delete of the data layer checks the
   generation and the deadline inside its own transaction, before the write and again
   just before `COMMIT`, with `statement_timeout` set to the time left. When an attempt
   ends, the runner cancels the statements it still has running. An attempt that timed
   out, failed or lost the lease commits nothing more (`LeaseLostError`). A staged-kit
   job writes only in `ctx.transaction((tx) => …)`, one fenced transaction for every
   write in it; its `ctx.db` outside reads only.
3. An attempt that outlives its `limits.timeoutMs` is cancelled (`ctx.signal` aborts, its
   capabilities are refused) and fails. A failed attempt is retried up to `retries`
   times with jittered exponential backoff, under a new generation each time, except an
   attempt that failed with `mail_failed` the one retry rule refuses and a `stopped` one.
4. Failures are fixed codes: `timeout`, `lease_lost`, `handler_failed`,
   `query_refused` and `capability_refused` (a framework refusal, chosen by class as a
   request's 5xx is, with the refusal's catalog reason in the result, the log line and the
   report's `reason` tag), `mail_failed` (a send error the handler did not catch, with the
   `EmailDeliveryError` code as its reason), `driver_failed`, `crashed`, `unauthorized` (IAM
   refused the job's key), `iam_unavailable` (IAM could not be asked for its token),
   `stopped` (a kicked run the process aborted while it shut down; not reported), and
   `boot_failed` from the CLI. An application error's name and message are never logged;
   the report carries them scrubbed (below). A `mail_failed` report carries no error, only
   its code and reason.
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
Operations treats the `fabrika-job-*` fingerprints like any other. The job's workload
key exists, but Operations' ingest cannot verify a `px_` key without asking IAM per
event, so it does not authenticate the reports yet (backlog 96).

A job has no caller. It has a **workload key** of principal kind `job` (ADR-0022
"Principal kinds"): Control issues it at IAM for each job of the approved contract,
seals it in its vault, and writes it as `FABRIKA_JOB_<NAME>_KEY`. At the start of every
attempt the runner exchanges the key at IAM's public `POST /auth/workload/token` for a
token, which carries the actions IAM's reconciled schema declares for the job. Its
`ctx` mints a capability only for an action the contract declares **and** the token
carries: `ctx.within(action, dimension)` reaches every value (a job is application-wide), `ctx.app(action)` mints an
`AppCapability` for `ctx.db.app(action)`, and
`ctx.ref(action, dimension, id)` locates one object, 404 when it is missing; `tx.ref` inside `ctx.transaction` locates
it in that transaction, so it finds an object the transaction wrote. On a first
deploy IAM's reconcile runs after the new version is active, so an attempt that starts
before it gets no capability. The principal of its writes is `job:<name>`. A job cannot
create scopes or manage members, issues share links only for a mount it declares in `issues`, and no mount accepts its
key. A job may kick another job (`kicks`, [Kicks](#kicks)), claim the rows of a queue table
([Queues and claims](#queues-and-claims)), put files, sign tokens and call declared origins.
`boot` refuses a job without `@fabrika/db`, a job without its key or without a token exchange, a schedule that
is not a five-field cron expression, and a missing or undeclared job handler. A webhook
has a key of principal kind `webhook` the same way (`FABRIKA_WEBHOOK_<NAME>_KEY`), one
per webhook declaration: its `ctx.refs` exist only when the token carries every declared
action. A public procedure has one of principal kind `public` ([Public procedures](#public-procedures)). On
Cloudflare every workload key is a Worker secret.

### E-mail from a job

A cron job of a kit contract that declares `mailer: 'installation' | 'own'` gets `ctx.mail` (`AppMail`,
`packages/app/src/jobs/mail.ts`); no other site does. On an endpoint, a link procedure, an export and a webhook
`ctx.mail` is an `Unavailable` that names the outbox, and on a job without `mailer` one that names the declaration.
`mailer` is declared reach (`ContractArtifact.declared['job:<name>'].mailer`), which the runtime reads from the approved
artifact; the approval diff shows a new `installation` for closer review and a new `own` as a widening. A
`defineContract` contract cannot declare it. On Cloudflare Control holds no installation transport, so a
`mailer: 'installation'` job there gets `FABRIKA_EMAIL_PROVIDER=none` and every send fails `mail_not_configured`;
`mailer: 'own'` sends through the application's own sender.

- `ctx.mail.send(message, signal?)` takes `{ to, subject, text, html?, idempotencyKey, replyTo?, fromName? }` and
  answers `{ status: 'accepted', provider, messageId }`. It aborts with the attempt's `ctx.signal` and with `signal`,
  and refuses once the attempt ended (`capability_refused`). The key is 1 to 200 visible ASCII characters, or the send
  fails `invalid_message` before any I/O. The transport gets it behind `mailKeyPrefix`: `fabrika:`, the first 32 hex
  characters of `sha256('<FABRIKA_IAM_ISSUER>\n<FABRIKA_IAM_APP_ID>')` and `:`, so two installations, applications or
  environments on one provider account never share a key. Renaming IAM's origin changes every prefix once.
  `transportMailKey(scope, key)` of `@fabrika/app/testing` computes the transport's key.
- `attachments: [fileRef]` (at most 20) sends stored files: each is read through the attempt's `ctx.files.open`, so
  only a `live` file whose reference the attempt holds goes out; a pending or quarantined one fails with 409
  `file_not_ready`, a rejected one with `file_rejected`. All attachments together stay within the transport's
  `maxAttachmentBytes`, else the send fails `invalid_message`, which is final; a transport without the capability
  refuses a message that has any, on the send. The attachments are part of the content a repeated idempotency key must
  match.
- `unsubscribe: { url }` hands the transport an exact `https` URL; a transport with the `listUnsubscribe` capability
  writes `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and one
  without it refuses the message. There are no free headers. The URL is usually
  `ctx.url('<endpoint id>', { query: { t: token } })` of a public procedure that takes the signed token
  ([Signed tokens](#signed-tokens)).
- `broadcast: true` marks one message of a send to many recipients, as opposed to mail the recipient's own action
  triggers. It needs `unsubscribe`. The transport sends it on the provider's channel for broadcast mail (Postmark's
  broadcast stream, Lettermint's broadcast route); one without `capabilities.broadcast` refuses it as
  `invalid_message`, on the relay already at the handoff when Control's own transport sends none. Under the relay
  `capabilities.broadcast` is true whatever Control's transport is, so that first refusal is how a job learns it.
  `jobMail` checks the capability itself before the sender sees the message, so a sender written before the field
  cannot send it as transactional mail. It is part of the content a repeated idempotency key must match.
- `ctx.mail.available` is false where the installation has no transport: Control handed `FABRIKA_EMAIL_PROVIDER=none`,
  a local installation configures none, or the kit runs with `mail: 'none'`. Control never hands `none` to an
  application on the relay: the relay holds what it cannot send, so `available` is true there and an accepted message
  waits for an operator. Every send then fails
  `mail_not_configured`, outcome `not_sent`, with no I/O. An outbox checks it first and leaves its rows queued without
  spending an attempt; they leave on the first run after a transport is added and the application is deployed again.
- `ctx.mail.capabilities` are the transport's (`idempotent`, `confirmation`, `maxBatch`, `listUnsubscribe`,
  `maxAttachmentBytes`); over the relay they are `PLATFORM_MAIL_CAPABILITIES`: idempotent, `queued`, one message a
  call, `listUnsubscribe`, 10 MiB of attachments. `ctx.mail.mayRetry(error)`
  is `mayRetryDelivery` over them ([outbound email](outbound-email.md)). A send rejects with `EmailDeliveryError`; any
  other rejection of an application's own transport becomes `provider_unavailable`, its message dropped unread.
  `@fabrika/app/implement` re-exports `EmailDeliveryError`, `mayRetryDelivery` and the email types, so an application
  needs no `@fabrika/email` dependency.
- A send error the handler does not catch fails the attempt as `mail_failed`, with the error's code as its `reason`;
  the runner retries the attempt only where `mayRetryDelivery` holds. Nothing logs or reports a message field, a key,
  a transport's message, a credential or a `messageId`.
- `boot` resolves each transport once (`resolveMailTransports`). `installation` reads the framework's `FABRIKA_EMAIL_*`,
  which Control hands a deploy ([outbound email](outbound-email.md#applications)). `FABRIKA_EMAIL_PROVIDER=platform`
  builds a `PlatformEmailSender` to Control's relay from `FABRIKA_PLATFORM_MAIL_URL` and `FABRIKA_PLATFORM_MAIL_KEY`
  ([outbound email](outbound-email.md#the-relay)) and needs no `FABRIKA_EMAIL_FROM`; a missing or invalid URL or key
  refuses the boot as `invalid_configuration`, naming the variables. Any other provider is read against
  `BootOptions.emailProviders` (the built-in providers by default). `own` calls `serve(contract, { mail: (env) => EmailSender | null })` once with
  the application's variables. `FABRIKA_EMAIL_PROVIDER=none` resolves to no mail, and boot logs it once per job. Boot
  refuses an `own` job without `mail`, a `mail` that no `own` job uses, an invalid installation configuration (its
  message names variables, never values), an absent `FABRIKA_EMAIL_PROVIDER` for an `installation` job (Control writes
  it on every such deploy), a `mail` that throws `EmailDeliveryError` or answers no `EmailSender`, and an `own` `mail`
  that answers `null`.
- A local installation, one whose `FABRIKA_IAM_ISSUER` is a loopback origin, treats a missing transport as no mail,
  and boot logs it once per job. Only there does boot add `BootOptions.localEmailProviders`,
  which `@fabrika/app/bun` sets to the `directory` provider (`FABRIKA_EMAIL_DIRECTORY`), the local stack's capture.
  Anywhere else that name is an unknown provider.
- `testKit` and `devKit` pass a `MemoryEmailSender` as `BootOptions.mailStandIn` (`TestKitOptions.mail`, a new one by
  default) for every mailer job; boot then reads neither `FABRIKA_EMAIL_*` nor `mail` (below). `mail: 'none'` passes
  `'none'` instead, an installation without a transport.

## Connectors

An application reads another's data through a connector: the owner exports queries, the consumer imports
them. v1 is read-only.

```ts
// the owner: an export with its handlers, mounted by the contract under `exports: { products }`
export const products = app.export({
	version: 1,
	consumers: ['shop'],
	audience: 'any consumer user',
	procedures: (e) => ({
		get: e.query({ input: BySku, output: z.nullable(Product), access: { action: 'catalog.product.read', over: 'catalog' } })
			.handle(async ({ input, ctx }) => {
				const [row] = (await ctx.db.within.products.list({ where: [['sku', '=', input.sku]], limit: 1 })).items
				return row === undefined ? null : fromRow(Product, row)
			}),
	}),
})

// the consumer: `fabrika connect add catalog/products@1 --consumer=shop --env=prod`
// writes fabrika/connect/catalog.products.v1.ts with catalogProductsV1 and its digest;
// the kit (src/app-kit.ts) imports it, and the endpoint that calls it declares `connect`
const app = defineApp(vocabulary, tables, { imports: { catalog: { snapshot: catalogProductsV1, procedures: ['get'] } } })
show: r.query({ input: BySku, output: Shown, access: { action: 'shop.view', over: 'shop' }, connect: ['catalog'] })
	.handle(async ({ input, ctx }) => {
		const product = await ctx.connect.catalog.get({ sku: input.sku })
		return product.outcome === 'ok' ? { name: product.value?.name ?? null } : { name: null }
	}),
```

The owner side:

- Each procedure is `POST /__fabrika/connect/<export>.v<version>.<procedure>`, and the export's
  description — its schemas and `exportDigest` — is `POST /__fabrika/connect/<export>.v<version>`. The
  description has the callers and the requirement of the procedures it describes; in v1 every procedure of
  an export declares the same action in the same dimension.
- Their callers are the consumers' `app:<id>` and nothing else; no other endpoint may name `app:<id>`.
  The owner's schema declares each consumer as an `app` workload holding the actions of the export rows it
  may call, so the consumer's key at the owner carries exactly those, app-wide (ADR-0022 "Principal kinds").
- An export handler runs read-only. The data layer refuses every write and lock in its request, whatever
  capability it carries, and reads in `READ ONLY` transactions — the access check's own reads included. An export may not declare an action a
  table writes with, nor one that manages members. Its context has no `ctx.connect` and no membership or file API.

The consumer side:

- `boot` checks each import against its vendored snapshot: same app, export and version, the import's
  digest, and schemas that still describe to that digest. It reads the owner's origin from
  `FABRIKA_CONNECT_<IMPORT>_URL` and the key from `FABRIKA_CONNECT_<IMPORT>_KEY` (`catalog` →
  `CATALOG`, `productCatalog` → `PRODUCT_CATALOG`). Both are framework variables, so no application
  module reads them, and nobody sets them: Control writes them when it deploys the consumer.
- `ctx.connect.<import>.<procedure>` exists only on the endpoints that declare the import in `connect` (the
  contract's `imports` section records them as its `usedBy`), and only for the
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
- On Cloudflare the deployer binds `FABRIKA_CONNECT_<IMPORT>` to the owner's proxy Worker, which carries the
  call, its URL naming the owner's host; a binding routes by the binding, not by the URL. Elsewhere the call
  goes to the owner's public origin with `fetch`. The Zerops balancer forwards `Authorization` unchanged
  (verified live, [zerops-platform.md](zerops-platform.md)).

Control joins the two sides (ADR-0022 "Principal kinds"):

- An edge is a consumer environment's import of an owner's export in the environment of the same name,
  computed from both approved snapshots. `fabrika connect add` and `pull` read the description from Control
  (`connectors.describe`), which answers the owner's approved export to its consumer only.
- A consumer deploy issues one key per owner it imports from, at `<owner>@<env>` naming the consumer, kept and
  rotated like a job key, and writes it under each import of that owner with the owner environment's
  `https://<domain>`. An owner environment without a domain fails the deploy.
- A publication that breaks an edge fails, approved or not. A consumer import must name the owner's approved
  export exactly, digest included (`run fabrika connect pull`). An owner deploy may not remove an export version
  an approved consumer imports, stop naming that consumer, remove an imported procedure, accept less input,
  change an output or change the audience; a breaking change is a new version served beside the old one. A new
  procedure and a new optional input field are compatible; an output may not gain a field, because the consumer
  parses every answer strictly.

## Who enforces each guarantee

What the paved road promises an application, and which layer keeps each promise. The layers: **types** (tsc, at the
line that breaks it), **checker** (`fabrika-check`, a refusal fails the build), **boot** (`boot` refuses to start),
**runtime** (the call is refused before anything is sent), **proxy** (the one enforcement decision, ADR-0022) and
**review** (a line of the approval diff, `packages/control/src/approval/diff.ts`, that a human approves on a protected
environment, ADR-0050). The data layer runs in the application's process: it stops honest mistakes and makes a bypass
conspicuous, and the checker's refusal of casts, `any` and suppression comments
(`packages/check/src/rules/types.ts:25`, `:29`, `:57`) keeps the types honest. The lift column names the declarations
that step past a row; each is a closer-review line of the approval diff when it is new or its reach grows
(`diff.ts:251`). A `sql` statement is bounded only by the runtime role, so where `sql` lifts a row, the approver's
review is what holds. "None" means no declaration lifts it; a migration is then the only way, and its database code is
reviewed too (`diff.ts:292`).

| Guarantee                                                                                                                                                                                                                                                                                                                     | Enforced by                  | Lifted by                                                                                             | Enforcing code or approval line                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A handler runs only for a caller the proxy admitted for its endpoint, and reads who it is from the verified token                                                                                                                                                                                                             | proxy, runtime               | none (an anonymous kind is declared as one: review)                                                   | `packages/auth-core/src/requirement.ts:14`; `packages/auth/src/iam.ts:136`; `packages/app/src/implement/dispatch.ts:372`; "Endpoint … becomes public" `diff.ts:361`                                                      |
| An `app` endpoint runs only for a global grant of its action                                                                                                                                                                                                                                                                  | proxy                        | none                                                                                                  | `packages/auth-core/src/requirement.ts:21`; "the endpoint's audience (app-wide: a global grant)" `diff.ts:651`                                                                                                           |
| The handles reach rows only through the capability: every statement they build carries its scope predicate as the top-level conjunct                                                                                                                                                                                          | types, runtime               | `unscoped: { <table>: 'read' \| 'write' }`; `sql: 'read' \| 'write'` (a statement without a fragment) | `packages/db/src/guard.ts:110`; `packages/db/src/orm.ts:575`; "declares table `…` unscoped" `diff.ts:255`; "declares raw SQL" `diff.ts:253`                                                                              |
| A handle's operation needs the table's action for it (insert, update, delete; a column's own write action)                                                                                                                                                                                                                    | types, runtime               | `sql: 'write'` (a statement without a fragment); `unscoped: { <table>: 'write' }`                     | `packages/db/src/orm-types.ts:236`; `packages/db/src/store.ts:161`                                                                                                                                                       |
| A handle reads a column with its own read action only under exactly that action                                                                                                                                                                                                                                               | types, runtime, review       | `sql: 'read' \| 'write'` (an `unscoped` read still omits it)                                          | `packages/db/src/orm-types.ts:219`; `packages/db/src/policy.ts:596`; "Column … loses its read policy" `diff.ts:745`                                                                                                      |
| The key, the containment chain, `version` and `createdBy` are stamped, never written by a handle                                                                                                                                                                                                                              | types, runtime               | `unscoped: { <table>: 'write' }` takes the chain; `sql: 'write'` (a statement without a fragment)     | `packages/db/src/store.ts:665`; `packages/db/src/policy.ts:825`                                                                                                                                                          |
| Every action is the vocabulary's, and a containment column is a foreign key to its container                                                                                                                                                                                                                                  | types, boot, checker         | none                                                                                                  | `packages/db/src/policy.ts:368`, `:448`, `:1099`; the checker reads `src/db/tables.ts` through the same parse                                                                                                            |
| A handle writes an application table only from an `app` endpoint, by the table's action for the operation                                                                                                                                                                                                                     | types, runtime               | `sql: 'write'` (a statement without a fragment); `unscoped: { <table>: 'write' }`                     | `packages/db/src/orm-types.ts:428`; `packages/db/src/store.ts:538`                                                                                                                                                       |
| `ctx.db.app` lists a dimension or child table under its read action or an `appRead` one, with the columns of that action, and only counts it (no aggregate) under an `appCount` one                                                                                                                                           | types, runtime, review       | `actions.appRead`, `actions.appCount` in the policy; `unscoped`, `sql` read it too                    | `packages/db/src/orm-types.ts:405`; `packages/db/src/store.ts:461`; `packages/db/src/orm.ts:427`; "is read app-wide with" `diff.ts:765`; "is counted app-wide with" `diff.ts:766`                                        |
| A scoped site reads an application table only under its read action, and never writes it                                                                                                                                                                                                                                      | types, runtime               | `unscoped: { <table>: 'read' \| 'write' }`; `sql: 'read' \| 'write'` (a statement without a fragment) | `packages/db/src/orm-types.ts:457`; `packages/db/src/store.ts:565`                                                                                                                                                       |
| A reference table is read-only: no handle and no statement writes it                                                                                                                                                                                                                                                          | types, runtime               | none (a migration)                                                                                    | `packages/db/src/orm-types.ts:492`; `packages/db/src/orm.ts:136`, `:625`                                                                                                                                                 |
| A query and an export write nothing                                                                                                                                                                                                                                                                                           | types, runtime               | none                                                                                                  | `packages/db/src/database.ts:200`                                                                                                                                                                                        |
| A job writes only inside its fenced transaction, while it holds its lease                                                                                                                                                                                                                                                     | types, runtime               | none                                                                                                  | `packages/db/src/orm-types.ts:236`; `packages/db/src/store.ts:647`                                                                                                                                                       |
| `ctx.sql` exists only on a site that declares it, in that mode                                                                                                                                                                                                                                                                | types, boot, runtime, review | `sql: 'read' \| 'write'`                                                                              | `packages/app/src/contract/context.ts:128`; `packages/app/src/implement/invocation.ts:313`; "declares raw SQL (`…`)" `diff.ts:253`                                                                                       |
| Every `ctx.sql` value is a bound parameter; one statement, the application's schema, no DDL, no `fabrika_*` or `pg_*` name                                                                                                                                                                                                    | runtime, checker             | none (a migration)                                                                                    | `packages/db/src/sql.ts:192`, `:591`; the runtime role (ADR-0017); raw SQL outside `ctx.sql` `packages/check/src/rules/runtime.ts:303`                                                                                   |
| A scope fragment carries its action into its query block: on the relation the block's `UPDATE`, `DELETE` or `ON CONFLICT … DO UPDATE` writes (same table, same alias) it needs that operation's action (an UPDATE also a column's own write action every assigned column declares); elsewhere an action the handles read with | types, runtime               | `sql: 'write'` (a statement without a fragment)                                                       | `packages/db/src/orm-types.ts:591`; `packages/db/src/sql.ts:433`; `packages/db/src/store.ts:348`, `:401`                                                                                                                 |
| A site's declared reach is the approved contract's, not the handler module's                                                                                                                                                                                                                                                  | boot                         | none                                                                                                  | `packages/app/src/implement/invocation.ts:137`                                                                                                                                                                           |
| Another application is called only through a declared import                                                                                                                                                                                                                                                                  | types, runtime, review       | `connect: ['<import>']`                                                                               | `packages/app/src/contract/context.ts:310`; "calls connector `…`" `diff.ts:258`                                                                                                                                          |
| A share link is issued only from a site that declares its mount                                                                                                                                                                                                                                                               | types, runtime, review       | `issues: '<link mount>'`                                                                              | `packages/app/src/contract/context.ts:297`; "issues share links of mount `…`" `diff.ts:262`                                                                                                                              |
| An endpoint sends no e-mail; a job sends only through the transport it declares, under a key prefixed per installation and application environment                                                                                                                                                                            | types, boot, runtime, review | `mailer: 'installation' \| 'own'` (a cron job)                                                        | `packages/app/src/contract/context.ts:414`; `packages/app/src/jobs/runner.ts:747`, `mail.ts:37`; "sends e-mail through the installation's mail transport" `diff.ts:278`                                                  |
| A public procedure's handler holds only its declared actions, on application tables: an insert reads nothing back, a read needs the table's read action, an update or a remove needs an id a verified signed token carries; no role holds a public action                                                                     | types, runtime, review       | none                                                                                                  | `packages/db/src/orm-types.ts` (`PublicApplicationRows`); `packages/app/src/implement/dispatch.ts` (`#publicInvocation`); `packages/auth/src/app-schema.ts` (an app schema whose role grants a public action is refused) |
| A public procedure's file body is challenged, budgeted, and admitted only from an origin its row admits; its files are scanned before any byte is served                                                                                                                                                                      | build, proxy, runtime        | none                                                                                                  | `packages/app/src/contract/build.ts`; `packages/proxy-core/src/authorize.ts` (`admitFormOrigin`); `packages/app/src/files/kinds.ts`                                                                                      |
| A stored file is served, opened or written into a column only through a reference the request holds and may read, of the column's kind, and served only when `live`                                                                                                                                                           | types, runtime               | `sql: 'write'` (a statement can write any file id)                                                    | `packages/db/src/file-columns.ts`; `packages/app/src/files/kinds.ts`                                                                                                                                                     |
| A site's `fetch` reaches only the origins it declares                                                                                                                                                                                                                                                                         | runtime, checker, review     | `egress: ['https://…']`                                                                               | `packages/app/src/implement/egress.ts`; `packages/check/src/check.ts` (`cross-app-fetch`)                                                                                                                                |
| The framework's binding of the data layer and its test kit stay out of application code                                                                                                                                                                                                                                       | checker, runtime             | none                                                                                                  | `packages/check/src/rules/modules.ts:58`, `:108`; `packages/check/src/rules/framework.ts:149`; `packages/db/src/production.ts:22`                                                                                        |
| The application reads no environment variable and no other application's origin itself                                                                                                                                                                                                                                        | checker                      | none                                                                                                  | `packages/check/src/rules/runtime.ts:326`, `:131`                                                                                                                                                                        |

The generated isolation and endpoint access tests (`fabrika db test-scaffold`) catch a handler that breaks one of
these rows in a way the layers above cannot see, such as a cache keyed by nothing; they are not an enforcer.

## Runtime boundary

Dispatch, RPC, validation, and the client use Web Fetch API types. A
`FetchService<Env>` (a type from `@fabrika/app`) is `{ fetch(request, env, exec) }`;
`serveService` returns one. Runtime adapters add process lifecycle without changing
request behavior:

- `@fabrika/app/cloudflare` exports `createCloudflareWorker()`. It builds a
  Worker-shaped `{ fetch, scheduled?, queue? }` module from a `FetchService`.
  Minimal structural types for the execution context, cron, and queues remain in
  this entrypoint. `createContractWorker()` is the Worker of a contract application: its
  `fetch` forwards every request to the environment's Durable Object, `FabrikaApplication`,
  with the proxy secret, and its `scheduled` forwards the minute tick. The object boots the
  application with its environment, verifying tokens through the `IAM` binding and serving
  the SPA from `ASSETS` ([On Cloudflare](#on-cloudflare)).
- `@fabrika/app/bun` exports `createBunHandler()`. It binds one `FetchService` to
  its process dependencies and returns `fetch()` plus `drain()`. It tracks every
  `waitUntil()` promise, reports rejected background tasks through a required
  callback, and drains all pending work during shutdown. A service that already
  owns a supervised execution context may inject it; that service remains
  responsible for draining the context. `serveContract()` boots a contract
  application on `PORT`, reads IAM's key set from the issuer's
  `/.well-known/jwks.json`, serves each SPA from its build directory and stops on
  SIGTERM: it aborts the kicked runs, stops accepting requests, drains the rest of
  its background work for at most 10 s, then closes the database.

Provider authoring remains separate: an app's `fabrika.config.ts` imports its
selected provider package. Portable request code imports `@fabrika/app`; only the
deployment entrypoint imports its runtime adapter.

## Runtime conformance tests

The installation's services prove that a request answers the same on every runtime.
A private test fixture, `packages/app/src/__tests__/fixtures/runtime-conformance.ts`,
runs an equivalent fresh request through a direct `fetch()` of the `FetchService`,
the Bun adapter, and the Cloudflare adapter. It normalizes the response status,
headers, and text body and asserts that all three values match. The
`runtime-conformance.test.ts` suites of IAM, Control and Operations use it. It is
not part of `@fabrika/app/testing`.

Each execution receives fresh environment state and a fresh `Request`. Use these
tests for rows that are intentionally portable. Keep composition-specific
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
  a public procedure's own `http.path`, and `<prefix>/api/<dotted.path>` for a link mount
  (`procedurePath`). A procedure without input sends `{}`.
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
- **The HTTP shape.** A procedure whose `http` declares `GET` (or a query that answers a file or declares `cache`) is
  called with `GET`, its input in the URL. The client sends no `http.query`: such a procedure is for a native form or
  a link that `ctx.url` builds.
- **Files.** An input whose fields hold a `Blob` goes as `multipart/form-data`: the JSON of the other fields first,
  then each file under its field's name; an input with none stays JSON. A file field's type is a `Blob` on the client.
  A procedure whose output is a file (or an `attachment()`) is no function: `download(api.x, input)` fetches it with
  the caller's credential and answers a `DownloadedFile` (a `File` with `blob()`, `stream()` and `save()`), and a `GET`
  one also has `api.x.url(input)`, the URL a same-origin page links to (`<img src>`, `<a download>`). A client with a
  key has no `url`: a key never goes into a URL, so a link page downloads.
- **`redirect()`.** The client sends `Accept: application/json`, so a `redirect()` procedure answers it `{ to }`
  instead of a redirect that `fetch` would follow; the caller decides whether to navigate.
- `ResultOf<F>` and `InputOf<F>` name a client procedure's answer and its input as the caller writes it.

## Testing a contract application

`@fabrika/app/testing` exports `testKit(app, options?)`. It boots the application as
its generated entrypoint would, for the audience `<app>@test`, behind the production
proxy decision and a stand-in for IAM; it has no test-runner dependency. An
application on `@fabrika/db` passes its connection as `options.database`, which the kit
hands to `boot` as a runtime adapter does; without one it does not boot. A test of the
author's that boots the application on a database runs beside the generated endpoint
access test only under `bun test --isolate`: the data layer binds once per process. The
template's `test` script passes it.

```ts
const kit = testKit(app, { database: postgres.database }) // app: the default export of src/app.ts
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
  callers present a key. A `link` caller's key is bound to one object with
  `{ kind: 'link', link: { mount, chain } }`: the object first, then each value containing it.
- The kit boots with a stand-in for IAM's membership transport (`kitMembership`,
  `packages/app/src/testing/membership.ts`), whatever the contract declares, so an application that creates scopes,
  manages members or issues share links tests them without a transport of its own, and so does the policy isolation
  kit's probe. It answers a member directory (`ctx.members.list()` and `get`) from the kit's callers: each caller's
  membership roles in the scope, labels only to a `members.manage` holder or where the dimension declares
  `directory: 'labels'`, `lastSignInAt` (`testCaller`'s option) only to a `members.manage` holder, the application's own directory from every caller holding a role of the contract, and `not_allowed` to a caller without the dimension's `members.list` there (a list) or the
  endpoint's action on the chain (a lookup). It answers the writes under IAM's rules for the caller's grants: a
  single-use delegation grant per request, `members.manage` on the value itself, an assigning role (`assignableBy`)
  there or, an application-wide one, globally, every action of the role assigned, a link mount's `issuedBy` and grants
  on its chain, the last creator's revoke (`last_creator`), IAM's input bounds, a credential of another application,
  an expired token and a connector. A role it assigns or revokes, and the creator role of a value it creates, is live
  as in IAM: the directory, its own checks and the next token the kit signs for that principal read it.
  `kit.acceptInvitation(invitationId, person?)` is IAM's onboarding as a test step: the invitation closes, and
  `person`, or a new person labelled by the invited address (`external` for an external role), holds the invited
  role from then on. As IAM, it first refuses an external `person` for a role not declared external (`not_eligible`)
  and an invitation whose inviter can no longer give the role, by its live roles and permissions (`not_allowed`),
  and leaves the invitation open. `options.membership` replaces the stand-in with the test's own `IamMembershipRpc`; that kit
  accepts no invitation.
- `kit.runJob(name)` runs a cron job once, as `fabrika job run <name>` does: under its lease in
  `fabrika_job_leases`, with the actions IAM signs for its key, its writes fenced. It answers the run's result
  (`{ status: 'succeeded', attempts }`). It first waits for the runs a `ctx.kick` started through
  `kit.fetch`. `kit.drain()` waits for them without running a job, and each method of the generated endpoint access
  kit drains before it answers, so no test closes the database under a kicked run. `FILE_SCAN_JOB` runs the scan of
  `scan: true` file kinds with the kit's `scanner`, and `FILE_SWEEP_JOB` the sweep of stored files.
- `kit.mail` is the stand-in transport of every job that declares `mailer` (a `MemoryEmailSender` of
  `@fabrika/email/memory`, re-exported by `@fabrika/app/testing`; `TestKitOptions.mail` replaces it, for example with
  `capabilities: { idempotent: false, confirmation: 'queued' }`). `accepted` is what reached the inbox, once per key,
  and `handoffs` every send that passed validation, with its answer; `refuse`, `unavailable`, `unreachable`,
  `loseAnswers`, `during` and `heal` inject and clear faults. Each message carries the transport's key,
  `transportMailKey(kit.mailKeyScope, key)`.
- An SPA mount whose built directory exists under `options.root` (the working directory when omitted) is served from
  it as the Bun deploy serves it (`diskAssets`): a file by its path, every other path of the mount by its
  `index.html`; a mount not built is an empty HTML document, and `options.assets` replaces both.
- `fabrika app dev` (`packages/cli/src/app-dev.ts`) serves the application through this kit (`devKit`, the kit with
  its stand-in IAM) on a loopback port, to click through its screens: a throwaway schema of
  `FABRIKA_TEST_POSTGRES_URL` migrated from `db/migrations/` and dropped on exit, the SPAs from their built
  directories, file objects in memory, and the application's variables from `dev/dev.env` over the environment without
  the `FABRIKA_*` names. A public procedure's challenge passes (`passingChallenge`). A job's mail goes to the kit's stand-in
  (`kit.mail`), and the mail view lists it with the invitations the stand-in IAM sent, newest first, at most 200: the
  recipient, the subject, the job's key, the time and the transport's answer. A job's message opens at
  `/__fabrika/dev/mail/<id>` with every field, its text, and its HTML in a `sandbox=""` `srcdoc` frame under the page's
  `default-src 'none'` policy, so it runs no script and loads nothing. Every request the process sends to
  `https://outbox.invalid` (`DEV_OUTBOX_ORIGIN`, the dev outbox, for another outside service) is captured, answered
  200 and listed in a section of its own. A `ctx.kick` starts its job; cron schedules do not run.
  What the seed or a job's handler throws is printed with its stack. A seed module (`--seed`, or `dev/seed.ts`)
  default-exports a `DevSeed`: it gets the kit and `DevOutside`, whose `outbox()` reads the dev outbox and `mails()`
  the jobs' mail (`DevMail`, oldest first), writes through the endpoints, and answers personas (a person the kit made), link pages (a URL `ctx.links` answered) and labelled scope
  values. `/__fabrika/dev` picks the caller: a persona, a role of the vocabulary held app-wide or in one scope value,
  or anonymous; a cookie keeps the choice, which never reaches the application, and the kit's own session never leaves
  the process. A sign-in the proxy answers (a redirect to the kit's IAM, a 401's `loginUrl`) points to the picker.
  Every SPA page it serves gets a same-origin toolbar script (the kit's `script-src 'self'` admits it; `app dev`
  changes no policy): who the browser is, a persona switch, the link pages, the invitations the stand-in IAM sent, each
  with a link that accepts it as IAM's onboarding does, the jobs' mail, and the dev outbox's messages. The stand-in IAM signs no password, so there is no reset
  mail. It listens on `127.0.0.1`, `::1` or `localhost` only, answers no request addressed to another host name, and
  prints its address and nothing of the environment.
- The kit's stand-in IAM mints for the key of a share link it issued through `ctx.links`, as IAM resolves a link key:
  the mount's grants on the link's object, bound to its chain, until the link is revoked. A job's own key, and the
  tokens the kit signs for it, are its credential at the stand-in's link operations, as at IAM's: its declared actions
  app-wide, its declared `issues` mount only, and only links it issued; so a job's `ctx.links` works in a plain kit and
  under `fabrika app dev`.
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
- `options.connect` wires each import: the owner's origin, the key, and the `fetch`
  that reaches the owner — usually another kit's `fetch`, so a connector call meets the
  owner's own proxy decision. The owner kit issues the consumer's key with
  `testCaller(grants, { kind: 'app', app: '<consumer>' })`, an `app` token as IAM signs it.

### The generated tests

**What they are for.** The generated tests catch the **mistakes** of an application's author,
who is usually an agent: a handler that serves another scope's rows, a cache keyed by
nothing, a policy that does not hold. They do not stop a deliberately hostile author, who
runs in the same process and can always subvert them. The data layer (`@fabrika/db`, A8–A10)
is the enforcement.

`fabrika db test-scaffold` writes two kinds of test and deletes a generated test it no
longer writes. Both run only for an application on `@fabrika/db`, and both open a test
database with `@fabrika/db/testing`'s `testDatabase`: a fresh schema `app_test_<hex>`
that the real migration runner fills with the framework's tables and then `db/migrations/`, as
`fabrika db migrate` does. Without
`FABRIKA_TEST_POSTGRES_URL` it prints the standard skip message and the file registers no
test; `FABRIKA_TEST_POSTGRES_REQUIRED=1` turns that into a failure.

- **Throwaway schemas.** A schema is held by a session-level advisory lock derived from its
  name, taken before it exists and kept for its whole life. Every test database first drops
  the `app_test_*` schemas whose lock it can take (a run that crashed or was killed) and
  never one whose lock is held (a live run, in any process). A schema is dropped again when
  its migrations fail, and `close` runs every cleanup step. Every application plan refuses a
  migration that names `public`, an `app_…` or a `fabrika…` schema, quoted or not, so neither
  the test run nor `fabrika db migrate` can reach a live schema; names resolve through the
  runner's `search_path`. A file is classified before any SQL runs (ADR-0017): tables,
  indexes, enum types, renames, drops, truncates, comments and backfills are paved; functions,
  triggers, views, rules, policies, `DO` and an expression that calls
  anything but a paved built-in are deviations the approver reviews; what escapes the schema,
  the transaction or the platform (another schema, a framework `fabrika_*` table, `COPY`,
  `GRANT`, a domain, a `serial` column or sequence, a routine overload, `SECURITY DEFINER`, a foreign language, dynamic `EXECUTE`, a call outside the
  function allowlist) is refused. A check before each commit rolls back a file that leaves an
  escape or an object no migration declares in the schema.
- **Seeding.** Every seeded row lies in one of two containment chains that share no value,
  with each container row a table owns. A column with a database default keeps it unless a
  seed sets it, and a value a seed sets, `null` included, is written as given. Otherwise a
  foreign key outside the chain holds `null` where
  its columns admit it; a required one holds the key of an existing row of the referenced
  table, or of one the fixture inserts, when that table is a reference, application or
  unpoliced table, and is refused when it is a dimension or child table, whose row would lie
  in another chain. A column a CHECK names holds the first value of a one-column `IN` list,
  or `null` where it admits it. Every other text column the fixture fills, nullable or not,
  holds a distinct marker; a required column of another type gets a sample of its type. A
  CHECK or a foreign key the seeded values still fail, and a required key to a scoped table,
  are generator limits (`SeedLimitError`, `@fabrika/db/testing`) that name the constraint or
  the column, never a failure of the policy or the handler.
- **Policy isolation tests**, `src/db/__tests__/<table>.policy-isolation.test.ts` for
  every dimension, child and application table, from the policies alone. They prove that the data
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
  answers 404 for an object that does not exist yet. An application table's probe
  (`appPolicyIsolationKit`) uses `app` endpoints: a holder of the table's actions as
  global grants gets, lists, inserts, updates and removes a seeded row; a holder of the
  same actions in one scope only is 403 for each; a capability of the read action is
  refused by an update or a remove of another action.
- **Endpoint access tests**, one file `src/__tests__/endpoint-access.test.ts`, from the
  contract. `endpointAccessKit` boots the application's own `src/app.ts` (its default
  export, `serve(…)`) through the test kit, on the application's own data layer, once: that layer
  binds once per process. It boots with the kit's stand-in IAM (above), which records each write it allowed and
  seeds the invitations and links a case names. A case's caller of an endpoint that manages members holds, on its target's
  value, the action, one assigning role of each role the input names (every membership role of the dimension when it
  names none) and those roles' actions; one of an endpoint that issues links also holds the actions the links grant.
  Each case asks as new callers, so no write of another case reaches them. The cases:
  - **Denial.** For every procedure with an `on` or `in` access form, a caller holding the action in one scope names
    the other scope's object or value and gets 404 (`on`) or 403 (`in`), exactly.
  - **Leak.** For every `on` and `over` procedure, and every `in` procedure that declares `sql`, a caller of the other
    scope asks first, then a caller of one scope asks for its own (`in`: for the scope value of every table that lies
    in the dimension). Each own answer must be one the application gave — a 2xx, or a 4xx other than 401, 403 and 404,
    so a precondition's 409 passes — and hold no key, scope value or text marker of the other scope's rows
    (`{ answered: true, leaked: [] }`). The scanned values are every key, parent, dimension value of the row's chain and
    text marker of the other scope. An endpoint that declares `unscoped` reaches across scopes by design and has no
    leak case; it keeps its denial.
  - **App form.** For every `app` procedure, a caller holding the action in one scope only is 403 (the proxy refuses
    it), and a caller holding it as a global grant gets an answer of the application: anything but 401, 403 or a 5xx,
    so a handler's 404 for the sampled id passes.
  - **Creates.** For every `creates` procedure the same two cases: a caller holding the action in one value of the
    dimension only is 403 (IAM creates a value only for a global holder), and a global holder gets an answer.
  - **Own target.** For every `on` procedure whose action is not the read action of the table that owns its dimension
    (a write-only role), a caller holding only that action, plus what IAM requires of a member manager or a link's
    issuer (above), asks for its own object and gets 200: the capability reads its own target. A link mount's procedure gets the same case for the holder of a link bound to its object.
  - **Several capabilities.** For every endpoint of several capabilities, one denied case per capability: the caller
    holds every other one, and the named one is refused (`kit.capability`).
  - **Public.** For every public procedure, anyone with no credential, from a page of its own origin, gets an answer
    of the application: anything but 401, 403, a 5xx or a 400 `challenge_failed` (`kit.anyone`). Behind a challenge
    the case is that 400 instead: the kit's challenge never passes. The case name carries the actions the procedure runs with.
  - **Files.** A file field's sample is `fabrika:file:<kind>`, and the kit sends a generated file of the kind in a
    multipart body; a `GET` procedure's input goes into its URL. The kit serves each seeded file as an empty object, in
    memory. The policy isolation fixture seeds a live, empty file into each file column, so its probes write file
    columns too.

  `deps` runs with an empty environment.
- **Inputs.** A case sends a fixed literal written into the test: a sample of the input
  schema, or, where the scaffold cannot sample one (a `regex`), the author's literal from
  `src/__tests__/endpoint-access.fixtures.ts` (`export const fixtures = { '<endpoint id>':
  { … } }`, plain literals only, read statically within the reader's budget). A missing
  fixture and a fixture of no tested endpoint are `endpoint-fixture` findings; an input the
  endpoint's schema refuses fails its cases. The access form's `from` field is replaced by
  the seeded value.
- **Seeds.** A precondition (`restore` only a note in the trash) is the author's seed in the same file:
  `export const seeds = { '<endpoint id>': { <column>: <value> } }`, the state of the row of the table that owns the
  endpoint's dimension, written into both scopes' rows. It adds a second, seeded leak case beside the unseeded one,
  which always runs, so a seed meets a precondition without setting aside the state that leaks, and it reaches the
  own-target case; the denial runs unseeded. A seed may not set a column that places the row in its scope, nor a text
  column that holds a marker the leak cases look for (a text column a CHECK lists the values of, or a foreign key, it
  may). A seed of no `on` or `in` endpoint is an `endpoint-fixture` finding.
- **Rows.** A handler that addresses a row lying in its object by id (a note's comment) finds no row for a sampled id,
  so the author names the field and the row's table: `export const rows = { '<endpoint id>': { <field>: '<table>' } }`.
  The scaffold writes `GENERATED_ROW_PREFIX` and the table there (`'fabrika:row:note_comments'`), and the kit seeds one
  row of the table in each scope's object (`seedUnder`) and sends, per case, the key of the row in the object the case
  names: the other scope's in the denial, each scope's own in the leak case, which also looks for the other row's key
  and markers, and the own in the own-target case, a link holder's included. A field of an endpoint that is not `on` an
  object a table owns, one that is no string field, and a table whose rows do not lie directly in that object (a
  child table of the table that owns it, or a dimension table it contains) are `endpoint-fixture` findings: the kit
  seeds no container between, so a task row of an org endpoint, whose project it would need, is refused.
- **Members.** A handler that validates a picked person with `ctx.members.get` refuses a sampled id, so the author
  names the field in the same file: `export const members = { '<endpoint id>': ['<field>'] }`. The scaffold writes
  `GENERATED_MEMBER` (`'fabrika:member'`, `@fabrika/app/contract`) there, and the kit replaces it, per case, with a new
  caller holding a membership role of the directory's dimension at the value the case's object lies in. A case of an
  endpoint whose action is the directory's `members.list` holds the action on the directory's value, where IAM checks a
  list. A field of an endpoint with no directory, or that is no string field, is an `endpoint-fixture` finding.
- **Invitations and links.** A handler that cancels an invitation or revokes a share link by its id gets a 404 from IAM
  for a sampled id, so the author names the field: `export const invitations = { '<endpoint id>': ['<field>'] }` (an
  endpoint with its dimension's `members.manage`) or `export const links = { … }` (an endpoint that issues a link
  mount). The scaffold writes `GENERATED_INVITATION` or `GENERATED_LINK` there, and the kit replaces it, per case, with
  an invitation its stand-in IAM holds open in the target's value, or a link of the endpoint's mount bound to the
  target's chain and issued by the case's caller. The stand-in answers a repeated invitation with the open one, a
  resend with a new 7 days, and an organization's mailbox for an external role with `internal_mailbox` when its
  `OrganizationMailboxes` name one (none in the generated cases).
- **Registration.** The generated files take `test`, `describe`, `expect` and `afterAll` from
  `@fabrika/app/testing/isolation`. The platform run preloads `@fabrika/app/testing/preload`,
  which captures Bun's own functions before any application module loads, and a case that
  ran no `expect` fails. The checker refuses `mock.module` of `bun:test`, of `@fabrika/*`, of a
  generated test and with a computed specifier (`mock-module`). The kits refuse to load or
  run in a process the generated entrypoint started (`markProductionProcess`, one
  non-configurable property of `globalThis` that every installed package copy reads).
- **What neither kind catches:** an application bug that needs other data or another
  order of requests, such as a cache keyed by something the test does not vary.
- `@fabrika/check` regenerates every generated test from the contract, the policies and the
  fixtures it reads statically and compares the files byte for byte: a missing, edited or
  replaced one (header or not) and a generated test the scaffold no longer writes are
  `generated-test-hash` findings. `bunfig.toml` may not set `[test] root`,
  `pathIgnorePatterns` or `retry` (`skipped-test`).
- **The platform runs them** at container start on Zerops, after `fabrika db migrate`
  and `fabrika db codegen --verify` (the build has no database), which also fails on a
  schema that holds database code no migration declares, such as one created at runtime: `fabrika db
  test-isolation` runs exactly the generated files with an empty `bunfig.toml` and the
  platform's preload, against a throwaway schema of the application's database, and fails
  unless every case name the scaffold wrote is reported as passed, with an assertion, in the
  JUnit report. It prints none of the tests' output, only the counts and the failed case
  names, because a dependency may write a credential into it; `--verbose`, which the start
  script never passes, prints the output locally. A failure leaves nothing to answer the
  readiness check.

## The agent skill

`@fabrika/app`'s `skill/` (the skill `fabrika-app`) is the one text that tells a coding agent how to write an
application. `SKILL.md` leads with the paved road in code, the declared steps off it, the loop (migrate, codegen,
test-scaffold, typecheck, `fabrika-check`, the tests) and when to ask the human; `references/<topic>.md` holds one topic
each: `start`, `app-setup`, `table-and-migration`, `endpoint`, `jobs`, `files`, `public-intake`, `spa`,
`webhooks-links-connectors`, `tests`, `dev` and `errors`. Its frontmatter `version` is the package's. Three places carry it, all read through
`@fabrika/app/agent-skill`:

- `fabrika builder init` installs every file verbatim as `.claude/skills/fabrika-app/` and
  `.agents/skills/fabrika-app/`, from the `@fabrika/app` the application installed (`installedAppAgentSkill`), else
  from the builder's own copy;
- Control's MCP server answers it from the read-only tool `get_app_rules`, which its `instructions` name: the body, or
  one reference file by `topic`, headed by the version, with a warning when the workspace given as `workspaceId` pins
  an `@fabrika/app` range the version is outside;
- the template's `AGENTS.md` is `renderAgentsFile`: the body and every reference file under a generated-file marker.
  The template is `examples/zerops-app`, and `packages/app`'s `agent-skill.test.ts` fails when its `AGENTS.md` is not
  the rendered file.

Every code block names its file and is checked: `skill-code.test.ts` compiles the blocks as one application with the
skill's own `tsconfig.json`, classifies its migrations as the runner does, and on Postgres migrates them. Change the
rules in `skill/` only, and keep them to what is built.

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

A deploy of an approved contract with a job that declares `mailer: 'installation'` also writes the mail transport
([outbound email](outbound-email.md#applications)). An application on framework 0.7 on Zerops gets the relay:
`FABRIKA_EMAIL_PROVIDER=platform`, `FABRIKA_PLATFORM_MAIL_URL` (Control's public origin, plain) and
`FABRIKA_PLATFORM_MAIL_KEY` (its environment's transport key, sensitive). An older release gets every `FABRIKA_EMAIL_*`
name Control holds, sensitive on Zerops, or `FABRIKA_EMAIL_PROVIDER=none` when Control has no transport; with an
invalid one, Control refuses that deploy before any effect. A deploy after the contract stops declaring it removes
them. An application cannot set a `FABRIKA_EMAIL_*` or `FABRIKA_PLATFORM_*` variable of its own: both families are
framework-only.

Every deploy also writes `FABRIKA_APP_ORIGIN`, the environment's public origin that `ctx.url` builds links on (`null`
removes it from an environment without one), and `FABRIKA_TOKEN_KEYS`, the environment's signed-token keys, `null`
unless the approved contract declares a token purpose. Each workload of the approved contract gets its key: a job
`FABRIKA_JOB_<NAME>_KEY`, a webhook `FABRIKA_WEBHOOK_<NAME>_KEY` and a public procedure
`FABRIKA_PROCEDURE_<ID>_<8 hex>_KEY`.

On Cloudflare the identities, origins and the release (`isPublicManagedVariable`, `provider-cloudflare/src/managed-secrets.ts`)
are Worker vars, and every other managed value, `FABRIKA_PROXY_SECRET` among them, is a Worker secret uploaded with the
version (`wrangler deploy --secrets-file`). The deploy then deletes the framework secrets it no longer writes.

A name whose value the installation cannot supply is REMOVED from the service rather than left stale —
an app verifying against a previous installation's issuer is worse than one that fails to boot.

Everything else an app needs per environment is its own `pipeline.vars`, which are inputs to the app's
CONFIGURATION rather than its runtime environment: the deploy makes each declared name available while
the app's config is compiled, and the config decides what to do with it. A variable the artifact does
not declare is refused where it is set.

## Who calls

A handler's `ctx.principal` comes from the verified token. A `human` caller is
`{ kind: 'user', id, label, email }`: `email` is the token's `email` claim, the mailbox IAM
recorded for the person (lower-cased), and `label` the spelling IAM displays. The signature
authenticates that IAM recorded it; it does not prove the person controls the mailbox beyond
what the login method checked. A `machine` caller is `{ kind: 'service', id, label }` and has
no address, and neither has a link holder or a connector. A person an application asserted at a terminal also has
`terminal: { id, label }`, from the token's `terminal` claim; every other principal has none. `boot` refuses (401) a `human` token
without the claim: upgrade IAM first, and an application to this version only once 300 s (the
token lifetime) have passed, and roll an application back before IAM
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 6).

Every member SPA serves `<prefix>/__fabrika-me.json` to the person its access admitted, from
the same token and without asking IAM:

```json
{
	"label": "Ann@Example.com",
	"email": "ann@example.com",
	"actions": {
		"app": ["positions.read"],
		"scopes": [{ "type": "org", "value": "acme", "actions": ["tasks.read"] }]
	}
}
```

`app` holds the actions granted globally, `scopes` each value with its own, sorted by
dimension and value; a pattern grant (`*`, `tasks.*`) is listed as the contract's actions it
covers. `parsePageCaller` (`@fabrika/app/client`) reads it. It is information for the page,
never a check: every endpoint decides again. A public SPA answers it 401, because the proxy
forwards no token to an anonymous kind. The test kit serves it for a test caller, whose
`email` is `<kind>-<n>@<app>.test` or the `email` option, lower-cased.

## Browser error reporting

Fabrika supplies an application's Operations ingest settings as three managed
runtime values:

- `FABRIKA_OPERATIONS_DSN` is a browser-safe public DSN scoped to one application
  environment.
- `FABRIKA_RELEASE` is the current deploy-scoped release name.
- `FABRIKA_ENVIRONMENT` is the environment's name.

Every SPA mount of a contract application (`c.spa`, member or public) serves
`<prefix>/__fabrika-config.json` with these three values, `{ "dsn": …, "release": …, "environment": … }`
(`null` when unset), and under `public` (present only when there is one) the public values the contract names: each
public procedure challenge's `siteKey` on every SPA mount, and the variables the mount lists in
`c.spa(prefix, { browserConfig: […] })` on that mount only, by variable name. Nothing else of the environment reaches it. A named variable
that is not set refuses the boot, and the contract refuses a variable that is both a challenge's
secret and public; a member SPA's answer needs a
member's session like every file of its mount.

`FabrikaProvider` (`@fabrika/app/react`, `src/client/error-reporting.ts`) reads that file
when it mounts. With a DSN, it sends every uncaught error and unhandled rejection of the
page to the ingest as one Sentry error event: the exception's type, message and stack
frames, the release, the environment, and the page's address without its query and
fragment. It sends a simple request (the DSN's key in the query, a `text/plain` body), so
the proxy's `connect-src`, which admits the ingest origin, is all it needs. It drops an
error equal to the one just sent and stops after 20 per page; `reportErrors={false}` turns
it off, and a missing or DSN-less config (local development, a test) installs nothing.
`tests/browser/operations-sdk-ingest.test.ts` proves the round trip on the local stack.

An SPA build writes each script's source map beside it (`sourcemap: 'external'`), and no
SPA or share-link mount serves a `.map` file (404): the platform build uploads the maps to
Operations for the release the page reports
([operations errors](operations-errors.md#release-source-maps)).

A request that answers 5xx is one error event too (`RequestFailed`, logger
`fabrika.requests`): the endpoint id, the proxy's request id, a fixed failure code and the
release, at most `MAX_FAILURE_REPORTS_PER_MINUTE` (30) per process and minute. A framework refusal adds
its reason from a closed catalog — `@fabrika/db`'s `QUERY_REFUSALS` and `CAPABILITY_ERRORS`,
the runtime's `CAPABILITY_REFUSALS` and `SERVER_FAULTS` — and the log line adds that reason's
fixed text. The log line never carries the error's name or message.

A request's and a job's event also carries what was thrown, before the framework's own
exception: its type, its message, its stack frames and its causes
([ADR-0059](../decisions/0059-application-server-errors-carry-their-stack-and-message.md)).
A framework refusal sends its reason and catalog text instead of its message. Every text is
scrubbed in the process first (`jobs/scrub.ts`): the values of the secret `FABRIKA_*`
variables and of application variables named as secrets, JWTs, authorization schemes,
credential headers, URL userinfo and credential query parameters. The event never carries the
input, a header or row data. With a DSN, a Bun process also reports a startup that throws, and
once it serves, its first uncaught exception or unhandled rejection, then fails as Bun does; a
Worker reports an isolate's first failed boot and its unhandled rejections. Operations' side of
these events: [operations errors](operations-errors.md#application-server-reports).

The tested compatibility profile is deliberately narrow. Fabrika accepts the
envelope authentication query and an `event` item for a captured browser
exception. It parses the exception, JavaScript stack frames, release,
environment, level, tags, and optional SDK fingerprint used for grouping.
Non-event items are not processed; bounded item types such as `client_report`
are ignored when an envelope also contains an event. Tracing, sessions, replay,
logs, metrics, and general Sentry protocol compatibility are not supported by
this witness.
