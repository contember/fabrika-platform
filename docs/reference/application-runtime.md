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

Until the proxy reads endpoint tables (B2), the artifact compiles to what today's proxy
and IAM consume, and `fabrika.config.ts` hands both to its provider: the Zerops
`target.proxy.gates` and `schema`, or the Cloudflare `createCloudflareProxyWorker({ gates })`
and `schema`.

- `gatesFromContract(artifact)` emits one rule per endpoint path and kind, most specific
  path first: `human` is a `human` rule; `machine`, `link` and `app:<id>` a `service`
  rule, before the `human` one; an anonymous kind a `public` rule, last. A gate knows no
  method, so a path also admits the kinds of the rows the other method can select
  through it: with a form at `POST /contact`, `GET /contact` still reaches the SPA for a
  signed-in person. A path with no endpoint has no rule, so the proxy denies it. The
  gates are coarser than the table: an absent key falls through to a broader path's
  rules, and an unknown procedure under an RPC prefix is admitted with the SPA's kind.
  The framework refuses both (caller kind 403, unknown endpoint 404).
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
`boot(app, { environment, iam, assets, database })`. For an application on `@fabrika/db`,
`serveContract` loads the data layer before the application and opens its connection on
`FABRIKA_APP_DATABASE_URL`, in the schema `app_<FABRIKA_APP_ID>` its migrations created;
`boot` binds the layer to it and to `requestCapabilities`, once, and keeps the locator the
bind answers; the application receives neither. Only an object `scoped` created is bound.
Without a connection (the data layer runs on Bun with Postgres only, so on Cloudflare),
with a copy or a wrapper of the layer, or with a layer bound before boot, `boot` refuses
to start. `boot` verifies tokens for the audience
`FABRIKA_IAM_APP_ID` (`<app>@<env>`, whose application must be the contract's), reads
`FABRIKA_IAM_ISSUER` and `FABRIKA_OPERATIONS_DSN`, and refuses to start when the contract
declares something this version cannot serve yet (link, form and webhook mounts,
files, jobs, exports, imports, `creates`), when an `on` dimension has no table, or
when a handler is missing or undeclared.

Per request, in this order:

1. refuse a non-canonical path (400) and select the endpoint with `planEndpoint`; no
   endpoint is 404, never the SPA;
2. verify the proxy-injected token with the shared verifier, for this application in
   this environment: none, invalid, or minted for another environment or application
   is 401, an unreachable IAM is 503;
3. the token's caller kind must be one of the mount's callers: a user token is
   `human`, a service token `machine`, an anonymous token (a share link) `link` (403);
4. the requirement: `member` is any permission, an action is that action in some
   scope (403);
5. admission: a request without `Authorization` that is not a `GET` needs
   `Sec-Fetch-Site: same-origin` (403), and RPC needs `Content-Type: application/json`
   (400);
6. parse the body strictly (400), run the access form, remove the `from` field, call
   the handler, project the output through its schema (a union through its first
   branch that accepts the value), answer `{ result }`.

| Form                   | Hands the handler                         | Refuses with                       |
| ---------------------- | ----------------------------------------- | ---------------------------------- |
| `{ member: true }`     | nothing                                   | —                                  |
| `{ action, over }`     | `ctx.within`, or `all` for a global grant | 403 when no value holds the action |
| `{ action, in, from }` | `ctx.target` for the value                | 403 not held, 404 missing          |
| `{ action, on, from }` | `ctx.target` with its containment chain   | 404 when missing or not held       |

Errors share one envelope, `{ error: { type, message, issues? } }`: 400, 401, 403,
404, 409, 500 and 503. Every 5xx and every refused capability answers a fixed message
with no metadata; the server log gets one short line without the error object.
Every response carries the header policy of ADR-0022.

A `Ref` and a `Within` are classes with private fields, bound to their request with
`AsyncLocalStorage`. `requestCapabilities` — the `CapabilityAuthority` of
`@fabrika/db` — refuses one the framework did not mint, one whose request has ended
and one from another live request. Each resolution returns a fresh frozen copy of the
facts fixed at mint, so changing a returned chain changes nothing the data layer sees.

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
its generated entrypoint would, for the audience `<app>@test`, behind a stand-in for
the proxy and IAM; it has no test-runner dependency.

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
  for `@fabrika/app/testing`, or a test module, loaded from any other file.
- The proxy decision runs first, and by default it is production's: proxy-core's
  verify service over the gates `gatesFromContract` generates, with the kit's IAM
  (`kit.iam`) behind it. A denial or a login answer reaches the test as the proxy
  sends it. So a `px_` key on a mount whose only caller is `human` gets the login
  answer, because the human gate reads the session only.
  `proxy: 'endpoints'` opts into ADR-0022's per-endpoint decision instead: canonical
  path (400), `planEndpoint` (no endpoint is 403), a `px_` key whose caller kind must
  be a caller (401 unknown, 403 wrong kind) or the session (401 when `human` is not a
  caller, the login URL when there is none), and the requirement (403).
- A request loses every `X-Fabrika-*` header, `X-Request-Id` and the forwarding
  headers before the decision, and the `__Host-px_*` cookies before the application.
  It carries the proxy's token, signed by the kit the way IAM signs, and the real
  verifier and dispatcher answer it.

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
