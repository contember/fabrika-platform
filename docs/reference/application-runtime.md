# Application runtime

`@fabrika/app` is the first-party server framework for applications deployed by
Fabrika. It combines Fetch-based HTTP routing, middleware, typed RPC, structural
error handling, object-level authorization, and a typed browser client.

## Request pipeline

`defineApp()` builds the runtime-neutral request application. For each request it:

1. builds the caller-owned context;
2. runs global middleware in declaration order;
3. matches an HTTP or RPC route;
4. runs route-scoped middleware;
5. invokes the handler or RPC dispatcher;
6. maps thrown structural errors to a response;
7. serves the optional asset fallback for an unmatched `GET`.

Middleware may mutate context, short-circuit with a response, or wrap the
downstream response. `@fabrika/auth` owns the canonical `Middleware` type;
`@fabrika/app` consumes and re-exports it.

HTTP route patterns support typed `:segment` parameters and one optional terminal
wildcard such as `/public/*path`. The wildcard captures the decoded remaining
path. `route.all()` mounts a Fetch-style handler for every method. It is the
compatibility seam for an established REST surface that joins the shared
application pipeline without changing its wire contract.

IAM, Delivery, and Operations are first-party reference applications. They
dispatch through the same application on Cloudflare and Bun while retaining the
protocol surfaces required by their platform roles. See
[`core-application-composition.md`](core-application-composition.md) for their
RPC, authorization, persistence, compatibility, and environment boundaries.

`@fabrika/auth` reads application identity from `FABRIKA_APP_ID` and the IAM
origin from `FABRIKA_IAM_URL`. The deprecated `PROPUSTKA_APP_ID` and
`PROPUSTKA_URL` names remain canonical-first fallbacks under ADR-0018. A shared
runtime-neutral reader in `@fabrika/platform` applies the precedence rule and
emits at most one value-free warning per legacy name in a process.

## Authorization boundary

Proxy gates and procedure requirements are complementary:

- The proxy evaluates the ordered static gate list and prevents unauthorized
  requests from reaching the private app service.
- App auth middleware verifies the proxy-injected token and builds the canonical
  `AuthContext` from `@fabrika/auth`.
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

- request: `{ method, input }` or `{ batch: [...] }`;
- response: `{ result }`, `{ error }`, or `{ batch: [...] }`.

Browser-safe contract packages describe the named procedure surface without
importing a server runtime. `RpcRouterFor<Context, Contract>` checks the server
implementation against that contract, and `createRpcClient<Contract>()` derives
the browser call surface from it. No code generation is required.

## Runtime boundary

Routing, middleware, RPC, validation, and the client use Web Fetch API types.
Runtime adapters add process lifecycle without changing request behavior:

- `@fabrika/app/cloudflare` exports `createCloudflareWorker()`. It builds a
  Worker-shaped `{ fetch, scheduled?, queue? }` module from a `FabrikaApp`.
  Minimal structural types for the execution context, cron, and queues remain in
  this entrypoint.
- `@fabrika/app/bun` exports `createBunHandler()`. It binds one `FabrikaApp` to
  its process dependencies and returns `fetch()` plus `drain()`. It tracks every
  `waitUntil()` promise, reports rejected background tasks through a required
  callback, and drains all pending work during shutdown. A service that already
  owns a supervised execution context may inject it; that service remains
  responsible for draining the context.

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
