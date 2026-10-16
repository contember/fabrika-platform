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
- A handler that needs more than the handles give declares it on its endpoint — `sql`, `unscoped`, `connect` or
  `issues` — and the approver sees the declaration. Jobs (`app.cron`), webhooks (`app.webhook`), share links
  (`app.link`) and exports (`app.export`) take their handlers the same way.
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
have no public or link caller, `from` names a string field of the input, and loose
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
  rules — kind, method, path, callers, requirement, admission — with its delegation and
  `requirementDigest`, the reserved prefixes, and the contract digest as `snapshot`. The
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
own; nothing reaches the database until `boot` binds it. An application without tables (on Cloudflare, which has no
data layer yet) writes `defineApp(vocabulary)` and `serve(contract, { database: null })`; its handlers have no
`ctx.db`, and its `sql` declaration is a type error. `serve` takes only the object `app.contract` returned: a copy
loses what the kit keeps beside it (the handlers, whether it has tables) and is refused. The mirrored handler tree of `implement` is the framework's own test entry, not on the application surface.

`fabrika app build` writes `fabrika/entry.generated.ts` for an application with a
`fabrika.contract.ts`: `serveContract(() => import('../src/app'), process.env)` on
Zerops, `createContractWorker(() => import('../src/app'))` on Cloudflare. The adapter
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
Without a connection (the data layer runs on Bun with Postgres only, so on Cloudflare),
with a copy or a wrapper of the layer, or with a layer bound before boot, `boot` refuses
to start. `boot` verifies tokens for the audience
`FABRIKA_IAM_APP_ID` (`<app>@<env>`, whose application must be the contract's), reads
`FABRIKA_IAM_ISSUER` and `FABRIKA_OPERATIONS_DSN`, and refuses to start when
`FABRIKA_CONTRACT_DIGEST` is missing or is not `contractDigest` of the compiled contract
(ADR-0022 rule 5), when the contract
declares something this version cannot serve yet (a webhook bound to the whole
application), when a job cannot run (see Jobs), when an
import has no matching snapshot or no owner, when a file collection
cannot be served (below), when an `on` dimension or a link mount's dimension has no
table, when an access form reaches a dimension that lies in a container no table can
locate it in, when a form or a webhook has no `scoped(tables)` layer (a form's input
field must be a column of its inbox), when an SPA or a link mount has no asset server,
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
   scope, and under the `app` form that action held as a global grant (403);
7. admission: a request without `Authorization` that is not a `GET` needs
   `Sec-Fetch-Site: same-origin` (403), and RPC needs `Content-Type: application/json`
   (400);
8. parse the body strictly (400), run the access form, remove the `from` field, call
   the handler, project the output through its schema (a union through its first
   branch that accepts the value), answer `{ result }`. An `attachment()` output answers
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

| Form                    | Hands the handler                         | Refuses with                                            |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `{ member: true }`      | nothing                                   | —                                                       |
| `{ action, over }`      | `ctx.within`, or `all` for a global grant | 403 when no value holds the action, or over 1000 values |
| `{ action, in, from }`  | `ctx.target` with its containment chain   | 403 not held, 404 missing                               |
| `{ action, on, from }`  | `ctx.target` with its containment chain   | 404 when missing or not held                            |
| `{ action, creates }`   | `ctx.created`, the value IAM generated    | 503 without the proxy's delegation grant; IAM's refusal |
| `{ action, app: true }` | `ctx.app`, the action application-wide    | 403 (at the proxy) unless the action is a global grant  |

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

"Target subtree" is the target's child tables and the dimension tables it contains. An `over` lists every table whose
containment chain holds its dimension, through the stamped chain column: `over: 'org'` lists tasks two levels down by
their `org_id`, with the same keyset pages, projection and hidden columns as the nearest container's tables. A job and a webhook bind the same
handles to a capability they minted or received: `ctx.db.on(ref)`, `ctx.db.in(ref)`, `ctx.db.over(within)`. A member
a site may not use is a type error at its call (`Unavailable`) and, should the types be defeated, a refusal that
names the same fix at runtime.

- **A capability reads its own target.** A `Ref` of any action the table names reads its row and the rows of its
  subtree; every column that declares a read action other than exactly the capability's is left out of the
  statement, as it is out of the row type. A `Within` lists by the table's read action. A `Ref` of an action the
  table does not name reads nothing of it.
- **Application-wide data is the `app` form's.** An application table (`scope: { app: '<why>' }`, key `id` unless
  `key` names another, generated on insert) belongs to no dimension: no chain, no container, every other policy field
  as a dimension table's. Only an `app` endpoint reaches it on the road, because the proxy admits that endpoint only
  for a global grant of its action; `ctx.app` is that capability, and `ctx.sql.scope(ctx.app, table)` is every row of
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
  requests one wins and the other sees the change and answers 409. It is the one lock the guard admits besides a
  destination's `FOR SHARE`.
- **A list is a keyset page**: at most `limit` rows (50 by default, 500 at most) in the order asked, the table's key
  last as the tiebreak, and `next`, the opaque cursor `after` takes, `null` on the last page. Filters and orderings
  name only the columns the capability reads. The cursor holds each order column as the database prints it, so a timestamp keeps its
  microseconds. Every capability reads the key and the version; a column policy on either is refused.
- **`ctx.db.unscoped.<table>`** exists only for the tables the site declares, in their mode: the scope predicate is
  `true`, every statement is still guarded and runs in the invocation's transaction, `'read'` refuses every write,
  an insert names the containment columns no capability stamps, and no declaration reaches a `fabrika_*` table. A
  reference table and a form's inbox have no key, so their `get` is an `Unavailable` (read them with `list`).
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
or the request runs past `REQUEST_BUDGET_MS` (10 s, `Bun.serve`'s default `idleTimeout`, which closes such a
connection anyway); its transaction then cannot commit (`request_cancelled`). An endpoint the generated tests cover
calls no outside service: it records an outbox row in its transaction and a job makes the call, because the generated
tests boot without the application's variables and a call does not roll back. A call that is the request's whole
purpose (the recipe's test e-mail) lives in a `{ member: true }` endpoint, which they do not cover, and takes
`ctx.signal`. A query
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

- **A webhook delivery is one transaction.** The delivery key is recorded first, outside it; a handler that throws
  rolls its transaction back and forgets the key, so GitHub's redelivery runs it again from nothing. A process that
  dies between the record and the commit keeps the key and loses the delivery.
- **A job reads outside its transaction and writes inside it.** `ctx.db` of a job attempt reads, each statement on its
  own; every write and `tx.sql` runs in `ctx.transaction((tx) => …)`, fenced by the attempt's lease. An attempt
  retries, so its writes are idempotent. There is no `ctx.jobs.enqueue`: jobs are cron only, so work for later is a row
  the next run picks up.
- **Every handle is bound to its invocation.** A handle kept past its handler, called from another live request, from
  a request of another `boot`, or from an ended job attempt is refused (500, one log line) before it reads its
  arguments.

### File collections

A `c.files` collection serves four generated endpoints, for signed-in people only, through
the same pipeline:

| Endpoint                               | Access                                       | Behaviour                                                                                                                             |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/files.<name>.upload/:owner` | `write` `on` the owner's dimension, `:owner` | the body is the file; `Content-Type` must be a declared type; `?name=` is the file name, metadata only. Answers `{ result: { id } }`  |
| `GET /api/files.<name>/:fileId`        | `read` `on` `file:<name>`, `:fileId`         | streams a `live` file with the file treatment; a `quarantined` one answers 409 `quarantined`, a `rejected` one 404                    |
| `POST /api/files.<name>.list`          | `read` `on` the owner's dimension, `owner`   | the owner's files, oldest first: `{ items: [{ id, name, type, size, status, createdAt }], next }`, `limit` 1–100 (50), `after` an id  |
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
  an upload in progress; a failed delete is retried on its next pass. A remove and an upload sweep their collection
  (20 files at most), and the framework's sweep job (`fabrika-file-sweep`, `FILE_SWEEP_JOB`, a reserved name like the
  scan job's) sweeps every collection hourly, batch by batch until nothing removable is left: an orphaned or removed
  object leaves storage within the hour without any request, in a collection that does not scan too. A collection
  whose sweep failed fails the run (`file_sweep_failed`), after the others were swept. On Zerops the crontab runs it
  when the contract declares a collection (`ZeropsContractRun.files`).
- **The upload is checked while it streams.** A `Content-Length` over `maxBytes` is 413
  before the body is read; otherwise the object store stops reading past `maxBytes`, keeps
  nothing and the answer is 413. The first 512 bytes must be the declared type (415):
  each binary type by its signature, a text type (`text/plain`, `text/csv`,
  `text/markdown`, `application/json`, `image/svg+xml`) as UTF-8 without NUL bytes or a
  binary signature. `maxPerOwner` is counted before and again once the file is live (409),
  so concurrent uploads never leave more; a quarantined or rejected file counts until it is
  removed. The file name (`?name=`) is cut at 255 code points and loses its control characters.
  A `scan: true` collection refuses an empty upload (400 `empty`) and keeps nothing: the scanner
  gives no verdict a file of no bytes needs, and no exception to the scan exists.
- **`scan: true` holds every upload until a clean malware verdict.** The upload ends
  `quarantined` instead of `live`. The framework's scan job (`fabrika-file-scan`, a reserved name
  no `c.cron` job can take) runs every minute under its lease in `fabrika_job_leases`. It takes the
  due quarantined files of every scanning collection that waited longest first (at most 20 and
  256 MiB; a file that failed before is scanned alone), so neither a busy collection nor a stream of
  new uploads holds an older file back. It reads each object whole with its version (an S3 ETag), checks its
  size and SHA-256 against the upload's, checks it as an archive, and hands the batch to one
  `clamscan` run in a private temporary directory, all under one five-minute deadline. Each verdict
  is written in a transaction fenced by the lease.
  - **Only a clean verdict over verified bytes promotes**, while the file is still quarantined, neither
    removed nor orphaned, with the same digest; the row records the scanned object's version.
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
    signature (`ambiguous_directory`). A `scan: true` collection may not admit `application/gzip`.
    PDFs and images are ClamAV's to parse; an archive embedded inside a PDF's streams is a residual
    limit of ClamAV's own coverage.
  - **A rejection** (a `FOUND`: EICAR, an encrypted file, a file past ClamAV's size, recursion or time
    limits; a refused archive; a missing object) deletes the object, then marks the row `rejected`. A
    failed delete leaves the row quarantined and unserved and waits like a retry (one minute, doubled
    up to an hour), so failing deletes never fill every batch.
  - **No verdict** — a scanner error or timeout, a file the scanner skipped, bytes that differ from the
    upload — counts a try: the file waits one minute, doubled per try up to an hour, is then scanned
    alone, and is rejected after five tries. Missing or stale (older than three days) signatures and a
    missing scanner count no try. Every outcome is reported to Operations under a fixed code.
  - **The download serves only the scanned version**: one conditional read (`If-Match` on the recorded
    ETag) answers the bytes, so a replaced object answers 409 without a byte, and the file is quarantined
    again for the next pass; so is a live file without a recorded version. A new object key is written
    once: the store refuses a key that already holds an object.
  - The pass ends with the sweep, which deletes removed and orphaned files in every state. A
    `scan: true` collection admits at most 100 MiB per file, the most the scanner reads in full.
    Turning `scan` off widens in the approval diff; a file left quarantined stays unserved. An existing
    collection that turns `scan` on needs `fileScanSql(name)` of `@fabrika/db` in a new migration (the
    checker's `file-scan-migration` names it): the earlier `fileTableSql` checked for `pending` and
    `live` only and had no scan columns.
- **The file treatment** is on every answer of the download endpoint, its denials and errors
  included: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
  default-src 'none'` and `Cache-Control: private, no-store`, and a `Content-Disposition`
  whose type follows the exact `Content-Type` (`attachment` unless an inert image). The proxy
  applies the same treatment to the answer of the endpoint it selected. The file itself gets `Content-Type` from the recorded type,
  `Content-Disposition: inline` only for PNG, JPEG, GIF and WebP, the file name as RFC 8187
  `filename*`, and `Accept-Ranges: none`: a `Range` request gets the whole file.
- **Link holders' files** (`link: true`, or `link: ['<mount>', …]`). Every link mount bound to
  the owner's dimension, or each one the list names (a mount it does not name has no file
  row and need not grant the collection's actions: the proxy denies its path as no endpoint, 403, and
  the dispatcher, reached without the proxy, answers 404), gets `POST <prefix>/api/files.<name>.upload`, `POST <prefix>/api/files.<name>.list`
  (`{ after?, limit? }`, no owner) and `GET <prefix>/api/files.<name>/:fileId`,
  caller `link`, `on` the owner's dimension with no parameter: the owner is the link's
  object. Each checks the key's mount and the object's current chain as a link procedure
  does (a key of another mount is 403, an object that moved 404), and a download resolves
  `:fileId` beneath that object, so another object's file is 404. Uploads keep the
  collection's limits.
- **Server code reaches a collection through `ctx.files(<name>)`** (`src/files/handle.ts`): every staged-kit
  endpoint and link procedure (not an export), a job's `ctx`, and its `ctx.transaction`'s `tx`. `list(owner, page?)`
  answers the owner's held files as the list endpoint does (`createdAt` a `Date`); `open(owner, id, { maxBytes })`
  reads one live file whole (`{ id, name, type, size, bytes }`), as the download reads it: a scanning collection's
  only as the scanned version, a quarantined file 409 `quarantined`, a rejected one, another owner's or a removed one
  404, one over `maxBytes` 413 `too_large` before any byte is read. `removeAll(owner)` marks every file of the owner
  removed. Each takes a `Ref` of the owner's dimension for one of the collection's actions — `read` for `list` and
  `open`, `delete` for `removeAll` — of the work running now, and refuses any other (`CapabilityRefusedError`
  `wrong_capability`): a file reaches what its owner reaches, as through the endpoints, and a write capability alone
  reads no name or byte of it. A handler that must see the uploads holds the collection's `read`. `open` locates the file
  now, requires it beneath the owner where the `Ref` says, and reads it under a `file:<name>` `Ref` the runtime mints
  for the same principal and action. The statements run in the site's session: the invocation's transaction (`READ
  ONLY` for a query), a job's statement-at-a-time reads, or its fenced transaction. `removeAll` runs only where the
  site writes, a mutation or `tx.files` (`QueryRefusedError` `read_only` elsewhere, and a type error). A name the
  contract does not declare is a `ServerFault` `file_collection_unknown`: the name is not typed, because the groups
  and jobs type themselves before the contract that declares the collections exists. A job mints the `Ref` with
  `ctx.ref`. The owner is a table
  with a dimension scope, never an application table, and there is no total of bytes per owner: `maxPerOwner` ×
  `maxBytes` bounds what one owner holds.
- **One table per collection**, `fabrika_files_<name>`, created by an application migration
  with `fileTableSql(name, { table, key, chain })` of `@fabrika/db`, where `chain` lists the
  owner's containment columns, nearest first; the owner table needs `UNIQUE (<key>, <chain
  columns>)`, as a child table's parent does. Codegen leaves the table out; only the
  framework reads it (`@fabrika/db/framework`'s `fileTablesOf`).
- `boot` refuses a collection whose name is not lowercase snake_case of at most 39
  characters, which admits a type the framework cannot sniff, or which has no object storage
  or no `scoped(tables)` data layer; the contract refuses `link: true` without a link mount
  bound to the owner's dimension, a named mount that is no link mount bound to it, and a
  serving mount that does not grant the collection's write and read actions. `serveContract` opens the
  storage (path-style S3, `@fabrika/platform-node`'s `S3BlobStore`) from
  `FABRIKA_APP_STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`; a
  partial set stops the boot. On Zerops the platform writes all four into the generated run
  section as `${<host>_…}` references to the application's one `object-storage` service,
  which must be a bucket the platform created for it. Downloads always go through the application: there are no
  presigned URLs. A job run (`fabrika job run`) gets ClamAV's `clamscan` from `PATH` as its scanner; on Zerops the
  build installs it for a `scan: true` contract (see [Zerops platform](zerops-platform.md)).

A `Ref` and a `Within` are classes with private fields, bound to their request with
`AsyncLocalStorage`. Each `boot` makes its own issuer: a mint, held only by that
call, and the `CapabilityAuthority` of `@fabrika/db` that its data layer, file
collections and `deps` are bound to. The authority refuses a capability its runtime
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
- **The public intake recipe** (a form, a cron job, a link mount). A form appends a row and
  answers a constant; the job drains the inbox into records, then delivers each record's
  link. It is the skill's outbox recipe: a run takes bounded batches (50, oldest first) and
  each record is its own work, in its own transactions. A record's failure adds one to its
  `attempts`, keeps a fixed step code in `last_failure`, and the run goes on; a record that
  failed five times is dead (a registration left in its inbox, a delivery `failed`), logged
  once by id, and left to an operator; a resend revives a dead delivery. A failure after the
  attempt ended is the attempt's, never the record's, so each e-mail has its own deadline
  inside the attempt's and a hanging one fails its record. Each record is claimed
  `for update skip locked` in the transaction that consumes it, so a row another session
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
     `days`; IAM's `issue` takes no idempotency key, so that window stays.
  3. **An effect starts only while the attempt is live**: `ctx.signal.throwIfAborted()`
     before each revoke, issue and e-mail, and the e-mail transport takes `ctx.signal`. The
     runner aborts the signal before a replacement attempt starts, and `ctx.links` of an
     ended attempt asks IAM nothing, so no effect of a stale attempt follows its
     replacement's.
  4. **The link is the delivery's identity**: the e-mail's `Idempotency-Key` is
     `intake-link-<link id>`, and a retry sends the same message under it, so the provider
     sends one e-mail per link even when its answer or the commit after it was lost.

  A resend (a second form, `{ email }`) marks an unverified record due while its budget has
  an e-mail left; the job revokes the sent link before it issues the next. Verification is
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
  (a form); every other call still needs a session. `{ public: true }` takes no other key.
- `c.form` appends one row of its declared fields to its inbox table and answers
  `{ result: { received: true } }`: it reads nothing and runs no handler. The body limit
  is the framework's (413). Admission is two counters per database minute in
  `fabrika_form_admissions`, shared by every instance (429 for either): the requests one client
  sends (`rate.perClient`, 10 by default), taken before the body is read, and the submissions the
  form accepts in all (`rate.perForm`, 100 by default), taken in the insert's own transaction, so a
  request refused before it (bad input, a filled honeypot, a failed challenge) or a row the database
  refuses never empties it. The client
  is `X-Fabrika-Client-Ip`, the one address header the proxy deletes and sets itself; an IPv6 client
  counts by its /64, and a request without the header shares one `unknown` client. On Zerops the
  header is the balancer until [backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md) settles the trusted range, so there the per-client limit
  is a second per-form one; the challenge is the defense that does not depend on the address.
  `honeypot: '<field>'` names an input string field that must stay empty: a filled one gets the
  same answer and writes nothing. `challenge: { provider: 'turnstile', secret: '<VARIABLE>' }`
  verifies the input field `challengeToken` with Turnstile's siteverify before the insert (5 s, a
  16 KiB answer, the request's host and the form's name as `action`, a token at most 300 s old),
  then records its digest in `fabrika_form_challenges`, so a second use is a replay: a failed or
  replayed token is 400, an unreachable provider or a refused secret 503, and neither writes a row.
  Only `fabrika app dev` admits one token again (`BootOptions.repeatableChallengeToken`): the one
  Turnstile's always-passing test widget hands out for every submission.
  The secret is the application variable the contract names; without it the application does not
  boot. `siteKey: '<VARIABLE>'` names the widget's public site key, which every SPA mount's
  `__fabrika-config.json` serves (Operations, below). Turnstile's origin joins `script-src` and `frame-src` (`frame-src 'self' <origins>`, so a
  declared frame origin only extends the same-origin frames `default-src 'self'` allows).
- `then: '<job>'` on `c.form` names a cron job of the same contract (the build, the checker and the
  compiler refuse any other name). Once a submission's row committed, the form kicks that job: the
  answer is the same constant and does not wait. The serving process starts one run in the background
  (`waitUntil` where the runtime has one) under the job's own key, never the request's. A kick waits
  for no lock, so it never holds a connection requests need while a run writes: when it cannot take
  the lease at once it sets the shared flag `fabrika_job_kicks.pending`, and the run holding the lease
  runs the job once more after it succeeded. Every run clears the flag when it starts, so at most one
  run is active and one is pending whatever the number of submissions and instances; after a failed
  run the flag waits for the schedule. A refused, honeypotted
  or challenge-failed submission kicks nothing. The schedule stays the recovery path: a kicked run
  that dies before its commit leaves its rows to the next scheduled run (`form-kick.test.ts`). On
  SIGTERM the server drains the runs in flight before it closes the database. A kick carries no
  payload; it is not a queue.
- `c.webhook` (GitHub) answers `POST <path>/:bindingId`. A holder of the bound
  dimension's `members.manage` creates a binding with the generated
  `POST /api/webhooks.<name>.bind` (`{ scope, account }`, where `account` is
  `installation:<id>` or `repository:<id>`); the framework generates the secret and
  answers it once with the URL. `webhooks.<name>.unbind` removes one. A delivery is
  checked in order: the binding (404), `X-Hub-Signature-256` over the raw body with that
  binding's secret (401), the payload's account (403), the input, parsed with its
  schema after every undeclared field is dropped (400), the webhook's credential (503
  when IAM refuses its key, cannot be asked, or signs a token without a declared action;
  nothing is recorded, so GitHub redelivers), and the delivery key,
  `sha256(bindingId ‖ raw body)`: a key the binding already received in the last 30 days
  is answered 200 and not run again, whatever its unsigned `X-GitHub-Delivery` says (the
  framework reads that header for nothing, not even the log). The handler gets `ctx.refs`, a `Ref` of the
  bound value for each declared action, and `ctx.delivery.key`. **It runs at least
  once**: a failing handler forgets the key so GitHub's redelivery runs it again. A
  delivery runs in one transaction (above), so the failed run kept nothing. Bindings and delivery keys live in the framework's `fabrika_*`
  tables, which `fabrika db migrate` applies.
- Revocation takes effect within the token lifetime: a removed member or revoked link
  keeps access until its cached token expires, at most 300 s (ADR-0022 rule 6).

## Jobs

An `app.cron` job takes its handler beside it, and the contract mounts it under `jobs`:

```ts
// src/notes/endpoints.ts
export const purge = app.cron('0 3 * * *', {
	actions: ['notes.read', 'notes.delete'],
	scope: 'app',
	timeout: '5m',
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

Each crontab entry runs `fabrika job run <name>` in the application's container
(Zerops only: the lease lives in the application's Postgres schema). The command boots
the application exactly as `serveContract` does — the framework variables leave the
process first — and runs one job:

1. The run takes the job's lease in `fabrika_job_leases` (a framework table of
   `fabrika db migrate`). While another run holds it, this run does not start. Every
   lease time is the database's clock, so containers whose clocks disagree still agree.
   A run clears the `fabrika_job_kicks.pending` flag a form's kick leaves when it starts,
   and runs once more when the flag is set again by the time it succeeded.
2. Each attempt holds one generation of the lease and a deadline (its `timeout`,
   default 15 minutes). Every insert, update and delete of the data layer checks the
   generation and the deadline inside its own transaction, before the write and again
   just before `COMMIT`, with `statement_timeout` set to the time left. When an attempt
   ends, the runner cancels the statements it still has running. An attempt that timed
   out, failed or lost the lease commits nothing more (`LeaseLostError`). A staged-kit
   job writes only in `ctx.transaction((tx) => …)`, one fenced transaction for every
   write in it; its `ctx.db` outside reads only.
3. An attempt that outlives its `timeout` is cancelled (`ctx.signal` aborts, its
   capabilities are refused) and fails. A failed attempt is retried up to `retries`
   times with jittered exponential backoff, under a new generation each time.
4. Failures are fixed codes: `timeout`, `lease_lost`, `handler_failed`,
   `query_refused` and `capability_refused` (a framework refusal, chosen by class as a
   request's 5xx is, with the refusal's catalog reason in the result, the log line and the
   report's `reason` tag), `driver_failed`, `crashed`, `unauthorized` (IAM refused the
   job's key), `iam_unavailable` (IAM could not be asked for its token), and `boot_failed`
   from the CLI. An application error's name and message are never logged; the report
   carries them scrubbed (below).
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
carries: `ctx.within(action, dimension)` reaches every value (`scope: 'app'`), and
`ctx.ref(action, dimension, id)` locates one object, 404 when it is missing. On a first
deploy IAM's reconcile runs after the new version is active, so an attempt that starts
before it gets no capability. The principal of its writes is `job:<name>`. A job cannot
create scopes, manage members or issue share links, and no mount accepts its key.
`boot` refuses a job scoped to a dimension (per-binding jobs are not built), a job
without `@fabrika/db`, a job without its key or without a token exchange, a schedule that
is not a five-field cron expression, and a missing or undeclared job handler. A webhook
has a key of principal kind `webhook` the same way (`FABRIKA_WEBHOOK_<NAME>_KEY`), one
per webhook declaration: its `ctx.refs` exist only when the token carries every declared
action. A Cloudflare deploy refuses a workload key, because a Worker runs neither.

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

| Guarantee                                                                                                                                                                                                                                                                                                                     | Enforced by                  | Lifted by                                                                                             | Enforcing code or approval line                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A handler runs only for a caller the proxy admitted for its endpoint, and reads who it is from the verified token                                                                                                                                                                                                             | proxy, runtime               | none (an anonymous kind is declared as one: review)                                                   | `packages/auth-core/src/requirement.ts:14`; `packages/auth/src/iam.ts:136`; `packages/app/src/implement/dispatch.ts:372`; "Endpoint … becomes public" `diff.ts:361`               |
| An `app` endpoint runs only for a global grant of its action                                                                                                                                                                                                                                                                  | proxy                        | none                                                                                                  | `packages/auth-core/src/requirement.ts:21`; "the endpoint's audience (app-wide: a global grant)" `diff.ts:651`                                                                    |
| The handles reach rows only through the capability: every statement they build carries its scope predicate as the top-level conjunct                                                                                                                                                                                          | types, runtime               | `unscoped: { <table>: 'read' \| 'write' }`; `sql: 'read' \| 'write'` (a statement without a fragment) | `packages/db/src/guard.ts:110`; `packages/db/src/orm.ts:575`; "declares table `…` unscoped" `diff.ts:255`; "declares raw SQL" `diff.ts:253`                                       |
| A handle's operation needs the table's action for it (insert, update, delete; a column's own write action)                                                                                                                                                                                                                    | types, runtime               | `sql: 'write'` (a statement without a fragment); `unscoped: { <table>: 'write' }`                     | `packages/db/src/orm-types.ts:236`; `packages/db/src/store.ts:161`                                                                                                                |
| A handle reads a column with its own read action only under exactly that action                                                                                                                                                                                                                                               | types, runtime, review       | `sql: 'read' \| 'write'` (an `unscoped` read still omits it)                                          | `packages/db/src/orm-types.ts:219`; `packages/db/src/policy.ts:596`; "Column … loses its read policy" `diff.ts:745`                                                               |
| The key, the containment chain, `version` and `createdBy` are stamped, never written by a handle                                                                                                                                                                                                                              | types, runtime               | `unscoped: { <table>: 'write' }` takes the chain; `sql: 'write'` (a statement without a fragment)     | `packages/db/src/store.ts:665`; `packages/db/src/policy.ts:825`                                                                                                                   |
| Every action is the vocabulary's, and a containment column is a foreign key to its container                                                                                                                                                                                                                                  | types, boot, checker         | none                                                                                                  | `packages/db/src/policy.ts:368`, `:448`, `:1099`; the checker reads `src/db/tables.ts` through the same parse                                                                     |
| A handle writes an application table only from an `app` endpoint, by the table's action for the operation                                                                                                                                                                                                                     | types, runtime               | `sql: 'write'` (a statement without a fragment); `unscoped: { <table>: 'write' }`                     | `packages/db/src/orm-types.ts:428`; `packages/db/src/store.ts:538`                                                                                                                |
| `ctx.db.app` lists a dimension or child table under its read action or an `appRead` one, with the columns of that action, and only counts it (no aggregate) under an `appCount` one                                                                                                                                           | types, runtime, review       | `actions.appRead`, `actions.appCount` in the policy; `unscoped`, `sql` read it too                    | `packages/db/src/orm-types.ts:405`; `packages/db/src/store.ts:461`; `packages/db/src/orm.ts:427`; "is read app-wide with" `diff.ts:765`; "is counted app-wide with" `diff.ts:766` |
| A scoped site reads an application table only under its read action, and never writes it                                                                                                                                                                                                                                      | types, runtime               | `unscoped: { <table>: 'read' \| 'write' }`; `sql: 'read' \| 'write'` (a statement without a fragment) | `packages/db/src/orm-types.ts:457`; `packages/db/src/store.ts:565`                                                                                                                |
| A reference table is read-only: no handle and no statement writes it                                                                                                                                                                                                                                                          | types, runtime               | none (a migration)                                                                                    | `packages/db/src/orm-types.ts:492`; `packages/db/src/orm.ts:136`, `:625`                                                                                                          |
| A query and an export write nothing                                                                                                                                                                                                                                                                                           | types, runtime               | none                                                                                                  | `packages/db/src/database.ts:200`                                                                                                                                                 |
| A job writes only inside its fenced transaction, while it holds its lease                                                                                                                                                                                                                                                     | types, runtime               | none                                                                                                  | `packages/db/src/orm-types.ts:236`; `packages/db/src/store.ts:647`                                                                                                                |
| `ctx.sql` exists only on a site that declares it, in that mode                                                                                                                                                                                                                                                                | types, boot, runtime, review | `sql: 'read' \| 'write'`                                                                              | `packages/app/src/contract/context.ts:128`; `packages/app/src/implement/invocation.ts:313`; "declares raw SQL (`…`)" `diff.ts:253`                                                |
| Every `ctx.sql` value is a bound parameter; one statement, the application's schema, no DDL, no `fabrika_*` or `pg_*` name                                                                                                                                                                                                    | runtime, checker             | none (a migration)                                                                                    | `packages/db/src/sql.ts:192`, `:591`; the runtime role (ADR-0017); raw SQL outside `ctx.sql` `packages/check/src/rules/runtime.ts:303`                                            |
| A scope fragment carries its action into its query block: on the relation the block's `UPDATE`, `DELETE` or `ON CONFLICT … DO UPDATE` writes (same table, same alias) it needs that operation's action (an UPDATE also a column's own write action every assigned column declares); elsewhere an action the handles read with | types, runtime               | `sql: 'write'` (a statement without a fragment)                                                       | `packages/db/src/orm-types.ts:591`; `packages/db/src/sql.ts:433`; `packages/db/src/store.ts:348`, `:401`                                                                          |
| A site's declared reach is the approved contract's, not the handler module's                                                                                                                                                                                                                                                  | boot                         | none                                                                                                  | `packages/app/src/implement/invocation.ts:137`                                                                                                                                    |
| Another application is called only through a declared import                                                                                                                                                                                                                                                                  | types, runtime, review       | `connect: ['<import>']`                                                                               | `packages/app/src/contract/context.ts:310`; "calls connector `…`" `diff.ts:258`                                                                                                   |
| A share link is issued only from a site that declares its mount                                                                                                                                                                                                                                                               | types, runtime, review       | `issues: '<link mount>'`                                                                              | `packages/app/src/contract/context.ts:297`; "issues share links of mount `…`" `diff.ts:262`                                                                                       |
| A form writes only the declared columns of its inbox                                                                                                                                                                                                                                                                          | boot, runtime                | none                                                                                                  | `packages/app/src/implement/boot.ts:487`; `packages/db/src/store.ts:1559`                                                                                                         |
| The framework's binding of the data layer and its test kit stay out of application code                                                                                                                                                                                                                                       | checker, runtime             | none                                                                                                  | `packages/check/src/rules/modules.ts:58`, `:108`; `packages/check/src/rules/framework.ts:149`; `packages/db/src/production.ts:22`                                                 |
| The application reads no environment variable and no other application's origin itself                                                                                                                                                                                                                                        | checker                      | none                                                                                                  | `packages/check/src/rules/runtime.ts:326`, `:131`                                                                                                                                 |

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
  this entrypoint. `createContractWorker()` boots a contract application with the
  first request's environment, verifying tokens through the `IAM` binding and serving
  the SPA from `ASSETS`.
- `@fabrika/app/bun` exports `createBunHandler()`. It binds one `FetchService` to
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
- **File collections** (`client/files.ts`). The client of an RPC mount whose callers include `human` has
  `files.<name>` for every collection: `upload(owner, blob, { name? })` (the blob's `type` is the `Content-Type`,
  a `File`'s name the `?name=`), `list({ owner, after?, limit? })`, `download(id)` and `remove({ id })`. A link
  mount's client has `files.<name>` for every `link: true` collection and every one whose `link` names the mount,
  without the owner: `upload(blob)`, `list()` and `download(id)`. The paths are `fileCollectionPaths` of `contract/defaults.ts`, the ones the artifact's rows
  carry; a collection bound to another link mount's dimension answers 404 there. `download` answers a `File` named
  by the answer's `filename*` and saves nothing; the list answer is parsed with the list endpoint's schema. A mount
  whose procedures hold a group named `files` refuses the client where collections apply.
- `ResultOf<F>` and `InputOf<F>` name a client procedure's answer (a `File` for an attachment procedure) and its
  input as the caller writes it.

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
  (`{ status: 'succeeded', attempts }`). It first waits for the runs a form's `then` kicked through `kit.fetch`.
- An SPA mount whose built directory exists under `options.root` (the working directory when omitted) is served from
  it as the Bun deploy serves it (`diskAssets`): a file by its path, every other path of the mount by its
  `index.html`; a mount not built is an empty HTML document, and `options.assets` replaces both.
- `fabrika app dev` (`packages/cli/src/app-dev.ts`) serves the application through this kit (`devKit`, the kit with
  its stand-in IAM) on a loopback port, to click through its screens: a throwaway schema of
  `FABRIKA_TEST_POSTGRES_URL` migrated from `db/migrations/` and dropped on exit, the SPAs from their built
  directories, file objects in memory, and the application's variables from `dev/dev.env` over the environment without
  the `FABRIKA_*` names. A form's challenge passes (`passingChallenge`), and every request the process sends to
  `https://outbox.invalid` (`DEV_OUTBOX_ORIGIN`, the dev outbox: point a mail provider's URL at it) is captured, answered
  200 and listed in the mail view. What the seed or a job's handler throws is printed with its stack. A seed module
  (`--seed`, or `dev/seed.ts`) default-exports a `DevSeed`: it gets the kit and the dev outbox, writes through the
  endpoints, and answers personas (a person the kit made), link pages (a URL `ctx.links` answered) and labelled scope
  values. `/__fabrika/dev` picks the caller: a persona, a role of the vocabulary held app-wide or in one scope value,
  or anonymous; a cookie keeps the choice, which never reaches the application, and the kit's own session never leaves
  the process. A sign-in the proxy answers (a redirect to the kit's IAM, a 401's `loginUrl`) points to the picker.
  Every SPA page it serves gets a same-origin toolbar script (the kit's `script-src 'self'` admits it; `app dev`
  changes no policy): who the browser is, a persona switch, the link pages, the invitations the stand-in IAM sent, each
  with a link that accepts it as IAM's onboarding does, and the dev outbox's messages. The stand-in IAM signs no password, so there is no reset
  mail. It listens on `127.0.0.1`, `::1` or `localhost` only, answers no request addressed to another host name, and
  prints its address and nothing of the environment. Cron jobs do not run there.
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
  - **Files.** A file collection's endpoints get the same cases
    over a file the kit uploads in each scope (`kit.file`, objects in memory): upload,
    download and remove of an own file pass, of the other scope's are 404, and a caller
    holding only the collection's `read` action is 403 for upload and remove. Those case
    names carry the actions, so a changed action makes the committed test stale.

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
- **`move` has no case yet.** An access form hands a handler one capability, and a move
  needs the source and the target `Ref`, so no handler can call `t.move`.
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
each: `app-setup`, `table-and-migration`, `endpoint`, `jobs`, `files`, `webhooks-links-connectors`, `tests` and
`errors`. Its frontmatter `version` is the package's. Three places carry it, all read through
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
no address, and neither has a link holder or a connector. `boot` refuses (401) a `human` token
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
(`null` when unset), and under `public` (present only when there is one) the public values the contract names: each form challenge's
`siteKey` on every SPA mount, and the variables the mount lists in `c.spa(prefix, { public: […] })`
on that mount only, by variable name. Nothing else of the environment reaches it. A named variable
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
