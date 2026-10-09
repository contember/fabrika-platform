# Core application composition

IAM, Delivery, and Operations are the installation's own first-party services. They
share the `@fabrika/app` service dispatcher (`serveService`), typed RPC transport,
IAM SDK integration, runtime adapters, and process-side database wiring. Their product roles still
require additional protocol-specific HTTP surfaces.

## Shared shape

| Plane        | Server application                    | Typed browser contract                                    | RPC endpoint | Authentication                                                                     | Postgres bundle |
| ------------ | ------------------------------------- | --------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | --------------- |
| Access / IAM | `@fabrika/iam` `createIamApp()`       | `IamAdminRpcContract` in `@fabrika/iam-contract`          | `/admin/rpc` | IAM resolves its own sessions, API keys, provisioning caller, and bootstrap caller | `iam`           |
| Delivery     | `@fabrika/control` `controlApp`       | `ControlRpcContract` in `@fabrika/control-contract`       | `/api/rpc`   | `serveService` row handler over `@fabrika/auth` `iam.authenticate()`               | `control`       |
| Operations   | `@fabrika/operations` `operationsApp` | `OperationsRpcContract` in `@fabrika/operations-contract` | `/api/rpc`   | `serveService` row handler over `iam.authenticate()`, plus IAM principal lookup    | `operations`    |

`@fabrika/auth` ships no middleware. Each service writes the handful of lines that
call `iam.authenticate(request)` in its credentialed row handlers and shape its own
error envelope.

Each service declares a service contract with `defineServiceContract`
(`@fabrika/app/service`): IAM's in `packages/iam/src/service.ts`, Control's in
`packages/control/fabrika.service.ts`, Operations' in
`packages/operations/src/service.ts`. `serveService` dispatches the contract's rows
to one handler each and returns a runtime-neutral `FetchService`; a typed RPC row's
handler calls `dispatchRpcRequest`. The proxy decides from the same table, as an
installation entry. The Cloudflare Worker and Bun process entrypoints bind runtime
services to that same `FetchService` through `@fabrika/app/cloudflare` and
`@fabrika/app/bun`; they do not maintain a second route tree.

The contract packages are browser-safe and contain the named procedure shapes.
Server routers implement those shapes through `RpcRouterFor`; the dashboard,
IAM UI, and Operations UI derive their call surfaces with
`createRpcClient<...>()`. The shared client sends same-origin credentials,
normalizes transport failures, and preserves an IAM `loginUrl` carried by an
authentication error.

The unified console reaches the three applications as follows:

- Delivery calls `/api/rpc` on Control directly.
- Access calls `/iam/admin/rpc`; Control forwards it to IAM's private admin
  surface.
- Operations calls `/operations/api/rpc`; Control forwards it to Operations'
  private operator surface.

The two gateways preserve the nested RPC error envelope. They may add the public
IAM login URL to an authentication error, but they do not reinterpret domain
results. They preserve the browser's `Origin` and the proxy-injected token because
the downstream service authenticates and authorizes the **browser's** principal,
not the control plane's. The IAM gateway translates that signed token to a bearer
and removes all console cookies before the private hop; IAM resolves IAM permissions
live rather than trusting Control's permission snapshot.

Neither gateway checks the origin. The console's proxy admits a session's state
change only with `Sec-Fetch-Site: same-origin`, which stops a confused-deputy
attack: a hostile page POSTing to the console's own origin with the victim's
cookies is refused before Control, and so the downstream service, is asked.

IAM's `/admin/*` does not rely on that check: it accepts only a bearer — the
console token the gateway forwards in place of the browser's cookie, or a `px_`
key — and a browser never attaches a bearer on its own.

### The proxy's surface is not the management surface

The proxy never calls `IamRpc`. On the Bun composition it calls `/auth/mint/*` —
`POST /auth/mint/session`, `/auth/mint/key`, `/auth/mint/exchange`, `/auth/mint/delegation` — guarded by
`FABRIKA_IAM_PROXY_KEY`, which is a different secret from the `FABRIKA_IAM_RPC_KEY`
that guards `/rpc/*`. Either key left unset makes its surface answer 404 as though it
were never mounted; neither surface exists at all in the Cloudflare composition,
where both are service-binding method calls. `@fabrika/proxy` narrows the binding to
four methods (`mintToken`, `mintFromKey`, `exchangeAuthCode`, `getJwks`), plus
`requestDelegation` for contract applications' membership endpoints, structurally,
so it never imports IAM. How far that separation actually goes per provider is in
[`cross-host-sso.md`](cross-host-sso.md).

A contract application on Zerops reaches neither surface for its membership operations either. It calls
`POST /membership/<method>` on IAM's public origin with its own membership transport key, which Control issues per
application environment and which pins the application id; the authority stays the caller's token, plus the proxy's
delegation grant for scope creation and membership changes (ADR-0022 rule 6). In the application that key is named `FABRIKA_IAM_RPC_KEY`; it is not the
installation's key of the same name.

A job or a webhook of a contract application reaches neither surface. It exchanges its own workload key at
`POST /auth/workload/token` on IAM's public origin, which needs no transport secret because the key is the whole
authority, and which signs only for a job or webhook key of the named application (ADR-0022 "Principal kinds").

## Authorization boundary

**The proxy is the only enforcement point**
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)): one
enforcement decision, in `@fabrika/proxy-core` over `@fabrika/auth-core`'s
`planEndpoint`, and the proxy is the only thing that runs it.
Delivery and Operations use the application-facing `@fabrika/auth` SDK, whose whole
request-time job is to read the proxy-injected `X-Fabrika-Token`, verify it locally
against IAM's JWKS, and build the canonical `AuthContext`. It cannot make an enforcement
decision, exchange a session, or write a cookie. A procedure or shared use case then performs
the action and object-scope check that depends on validated application data.

That object-scope check is **authorization**, a separate layer from enforcement, and
the proxy's session check above is a third one, **admission** ([`overview.md`](overview.md) names all three). A
service that refuses a request is not thereby a second enforcement decision; only a
component that decides from the endpoint table whether a request reaches a service
would be, and only the proxy does.

IAM is different only at the identity boundary: it authenticates its own admin
callers before invoking the same typed RPC dispatcher. Every administration
operation is a named `IamAdminRpcContract` procedure and has no second transport,
so policy, audit, hidden-object behavior, and request correlation cannot diverge
by transport for them. `/admin/*` REST retains four machine-provisioning
operations only (below); they share the same use cases and the same credential
resolution code — `extractCredentials`, `resolveAdmin`.

On both providers, the proxy's endpoint decision runs before application code and
decides whether a request may reach a private service. Cloudflare authoring materializes a public
proxy Worker and a private application Worker child; its provider lifecycle
deploys every generated Worker config. Application authorization then decides
whether the resolved principal may perform the requested action on the specific
object. Neither check replaces the other.

## Administrative RPC and protocol HTTP surfaces

Typed RPC is the only administrative API for Control and Operations, for browser
and machine callers alike ([ADR-0041](../decisions/0041-one-administrative-transport-for-control-and-operations.md)).
Protocol-specific HTTP surfaces remain:

| Application | Compatibility or protocol surface                    | Why it remains                                                                                                  |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| IAM         | `/admin/*` REST — four machine operations            | App-schema reconciliation and machine-key provisioning; outside the Control/Operations transport consolidation. |
| IAM         | `/auth/*`, `/.well-known/jwks.json`                  | Login, callback, session, and JWKS are native identity protocols, not domain RPC calls.                         |
| IAM         | service-binding `IamRpc` and Bun `/rpc/*` transport  | Applications and Control use the process-to-process management contract; it is separate from browser admin RPC. |
| IAM         | `/auth/mint/*`                                       | The proxy's own least-privilege surface — session mint, key mint, handoff redemption, delegation grants.        |
| Delivery    | `/webhooks/github/:connectionId`, health, and assets | Webhooks, probes, and static files have protocol-specific HTTP semantics.                                       |
| Operations  | Sentry envelope ingest and source-map upload         | SDK ingest and artifact upload are established streaming/binary HTTP protocols.                                 |
| Operations  | private catalog and release reconciliation           | Control-to-Operations synchronization is a service protocol, not a browser domain API.                          |

Control serves `/api/rpc`; its Operations gateway forwards `/operations/api/rpc`
to Operations' private `/api/rpc`. Administrative REST routes are removed, with
no compatibility adapter. Protocol handlers remain mounted inside the shared
authentication and runtime composition.

Operations defines operator payload rules in
`packages/operations/src/operator-input.ts`. RPC validates its input schema
before invoking typed use cases, which own object visibility, authorization and
domain changes. Issue mutations, health checks and alert configuration follow
one input contract and one transport error envelope.

### IAM's `/admin/*` REST surface is closed

It is a **provisioning** surface, not a second administration API. It serves
exactly four operations; an unmatched `/admin/*` path answers 404, and a wrong method
on one of the two matched resources answers 405:

| Operation                             | Caller                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| `PUT /admin/apps/:app/schema`         | `reconcileSchema` (`@fabrika/auth`) during a deploy     |
| `GET /admin/apps/:app/schema`         | reading back what a deploy reconciled                   |
| `POST /admin/api-keys`                | first-machine-caller bootstrap, before a console exists |
| `DELETE /admin/api-keys/:principalId` | the same bootstrap tearing its key down                 |

Both callers run outside the installation with nothing but a URL and a key: a
deploy step has no service binding, and bootstrap has no browser. Everything an
operator does — principals, grants, roles, policies, share links, sessions,
audit, the auth log — is an `IamAdminRpcContract` procedure at `/admin/rpc` and
is reachable no other way. Adding a route back means showing that no RPC
procedure can serve the caller.

A machine caller may therefore use both transports in one step. `reconcileSchema`
does: `PUT /admin/apps/:app/schema` for the vocabulary, then
`POST /admin/rpc` `{ method: "apps.setReturnOrigins" }` when the control plane
supplies return origins. The split follows the rule above rather than the
transport — the schema PUT stays REST because it is the operation that
_registers_ an app, and return origins are an ordinary administration procedure
that happens to have a machine caller.

Every one of these calls presents a bearer: `/admin/*` refuses any request without
one, in every environment.

## Database and migration composition

The three applications depend on the runtime-neutral `SqlDatabase` port. Their
repositories own complete operations; shared domain code does not branch on a
database identifier. Cloudflare composition supplies D1. Bun composition
supplies the Postgres implementation from `@fabrika/platform-node`.

Each Bun migration entrypoint uses
`definePostgresServiceMigrations()` for the repeated wiring while keeping these
inputs explicit and service-owned:

- stable bundle name;
- stable ledger table;
- stable advisory lock;
- migration directory and dependency order.

IAM, Control, and Operations use `iam_schema_migrations`,
`control_schema_migrations`, and `operations_schema_migrations`, respectively.
Operations composes the `platform-node` jobs bundle before its own service
bundle. Migration identity is `(bundle, filename)` under
[ADR-0017](../decisions/0017-service-owned-postgres-migrations.md). Bundle names,
filenames, ledger tables, and lock keys are durable and must not be renamed.

Applications on the contract framework use the same runner through
`definePostgresApplicationMigrations()`, run by `fabrika db migrate`. Their
schema, ledger, bundle, and lock key are derived from the application id, and
their plans add checksums and per-migration timeouts that service plans do not
have (ADR-0017, "Application migrations").

The old `schema_migrations` table is read-only adoption evidence. The wrapper
checks the service's sentinel tables and recorded effects before it adopts an
existing schema into the service-owned ledger. It does not turn the legacy table
into a shared migration ledger, and it does not merge the services' migration
ownership.

## Runtime conformance

A private test fixture of `@fabrika/app`
(`packages/app/src/__tests__/fixtures/runtime-conformance.ts`) sends a fresh
equivalent request through a direct `fetch()` of the service's `FetchService`, the
Bun adapter, and the Cloudflare adapter. It drains background work and compares
normalized status, headers, and body. IAM, Delivery, and Operations each use it in
their `runtime-conformance.test.ts` for rows whose behavior is intentionally
portable. It is not a public export.

Composition-specific protocols remain outside a parity assertion. For example,
IAM's process health and shared-secret HTTP transport exist only in the Bun
composition, while the native service-binding transport belongs to the
Cloudflare composition.

## Environment boundaries

Configuration uses component-owned names from
[ADR-0024](../decisions/0024-canonical-environment-names.md):

- applications use `FABRIKA_APP_ID`, `FABRIKA_IAM_APP_ID` (the IAM application id `<app>@<env>`)
  and `FABRIKA_IAM_ISSUER`; `fabrika db` reads the application's database from
  `FABRIKA_APP_DATABASE_URL`;
- IAM service configuration uses `FABRIKA_IAM_*`;
- Delivery service configuration uses `FABRIKA_CONTROL_*`;
- runner-owned workspace configuration uses `FABRIKA_RUNNER_WORKSPACE`;
- Operations keeps its existing `FABRIKA_OPERATIONS_*` names and consumes IAM
  through `FABRIKA_IAM_*` names.

These are the only names anything reads. Every composition root reads its own
canonical name off its own source, and there is no shared compatibility reader
— [ADR-0024](../decisions/0024-canonical-environment-names.md)
retired the predecessor names and the fallback machinery together.

The retirement covered configuration names only. Deployed resource names, stored
application IDs, migration identities, provider envelopes, object keys, and other
durable values that contain a predecessor name remain unchanged until a dedicated
adoption or data-migration plan changes them.
