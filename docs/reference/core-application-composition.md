# Core application composition

IAM, Delivery, and Operations are first-party reference applications for the
same application model exposed to deployed apps. They share the
`@fabrika/app` request pipeline, typed RPC transport, IAM SDK integration,
runtime adapters, and process-side database wiring. Their product roles still
require additional protocol and compatibility surfaces.

## Shared shape

| Plane        | Server application                    | Typed browser contract                                    | RPC endpoint | Authentication                                                                     | Postgres bundle |
| ------------ | ------------------------------------- | --------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | --------------- |
| Access / IAM | `@fabrika/iam` `createIamApp()`       | `IamAdminRpcContract` in `@fabrika/iam-contract`          | `/admin/rpc` | IAM resolves its own sessions, API keys, provisioning caller, and bootstrap caller | `iam`           |
| Delivery     | `@fabrika/control` `controlApp`       | `ControlRpcContract` in `@fabrika/control-contract`       | `/api/rpc`   | Own middleware over `@fabrika/auth` `iam.authenticate()`                           | `control`       |
| Operations   | `@fabrika/operations` `operationsApp` | `OperationsRpcContract` in `@fabrika/operations-contract` | `/api/rpc`   | Own middleware over `iam.authenticate()`, plus IAM principal lookup                | `operations`    |

`@fabrika/auth` ships no middleware. It owns the `Middleware<Ctx>` type that
`@fabrika/app` consumes, and each application writes the handful of lines that call
`iam.authenticate(request)` and shape its own error envelope.

Each server defines a runtime-neutral application with `defineApp()`. The
application owns context construction, middleware, routes, RPC dispatch, and
structural error mapping. The Cloudflare Worker and Bun process entrypoints
bind runtime services to that same application through `@fabrika/app/cloudflare`
and `@fabrika/app/bun`; they do not maintain a second route tree.

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

Each gateway performs its own same-origin check before forwarding, against
`FABRIKA_CONTROL_DOMAIN` (the console's public origin) rather than the
reconstructed request URL, which is plain HTTP behind a TLS-terminating balancer.
That check is what stops a confused-deputy attack: a hostile page POSTing to the
console's own origin with the victim's cookies is refused by the gateway before
the downstream service is asked.

IAM applies the same check independently. Which browser origins may drive
`/admin/*` with an ambient session cookie is a **registry**,
`FABRIKA_IAM_ADMIN_ORIGINS`, holding the console's public origin. IAM cannot
derive it: the console is served from the control plane's domain, never from
IAM's issuer. An unset or empty registry refuses every cookie-authenticated
write, which is the fail-closed default; a machine caller presenting only a
bearer is exempt, because a bearer is never attached by a browser on its own.

### The proxy's surface is not the management surface

The proxy never calls `IamRpc`. On the Bun composition it calls `/auth/mint/*` —
`POST /auth/mint/session`, `/auth/mint/key`, `/auth/mint/exchange` — gated by
`FABRIKA_IAM_PROXY_KEY`, which is a different secret from the `FABRIKA_IAM_RPC_KEY`
that gates `/rpc/*`. Either key left unset makes its surface answer 404 as though it
were never mounted; neither surface exists at all in the Cloudflare composition,
where both are service-binding method calls. `@fabrika/proxy` narrows the binding to
four methods (`mintToken`, `mintFromKey`, `exchangeAuthCode`, `getJwks`) structurally,
so it never imports IAM. How far that separation actually goes per provider is in
[`cross-host-sso.md`](cross-host-sso.md).

## Authorization boundary

**The proxy is the only enforcement point**
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)). Delivery
and Operations use the application-facing `@fabrika/auth` SDK, whose whole
request-time job is to read the proxy-injected `X-Fabrika-Token`, verify it locally
against IAM's JWKS, and build the canonical `AuthContext`. It cannot evaluate a gate,
exchange a session, or write a cookie. A procedure or shared use case then performs
the action and object-scope check that depends on validated application data.

IAM is different only at the identity boundary: it authenticates its own admin
callers before invoking the same typed RPC dispatcher. Every administration
operation is a named `IamAdminRpcContract` procedure and has no second transport,
so policy, audit, hidden-object behavior, and request correlation cannot diverge
by transport for them. `/admin/*` REST retains four machine-provisioning
operations only (below); they share the same use cases and the same admission
code — `extractCredentials`, `rejectCrossOrigin`, `resolveAdmin`.

On both providers, proxy gates run before application code and decide whether a
request may reach a private service. Cloudflare authoring materializes a public
proxy Worker and a private application Worker child; its provider lifecycle
deploys every generated Worker config. Application authorization then decides
whether the resolved principal may perform the requested action on the specific
object. Neither check replaces the other.

## Compatibility HTTP surfaces

Typed RPC is the browser-facing domain API, but it does not replace every HTTP
surface:

| Application | Compatibility or protocol surface                   | Why it remains                                                                                                  |
| ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| IAM         | `/admin/*` REST — four machine operations           | Provisioning callers that cannot make a browser-shaped RPC call; see below.                                     |
| IAM         | `/auth/*`, `/.well-known/jwks.json`                 | Login, callback, session, and JWKS are native identity protocols, not domain RPC calls.                         |
| IAM         | service-binding `IamRpc` and Bun `/rpc/*` transport | Applications and Control use the process-to-process management contract; it is separate from browser admin RPC. |
| IAM         | `/auth/mint/*`                                      | The proxy's own least-privilege surface — session mint, key mint, handoff redemption; see below.                |
| Delivery    | `/api/*` REST                                       | CLI, integration, and established control API consumers retain their request and response contract.             |
| Delivery    | `/webhooks/github`, health, and assets              | Webhooks, probes, and static files have protocol-specific HTTP semantics.                                       |
| Operations  | `/api/*` operator REST                              | Existing operator consumers and the same-origin gateway remain compatible while the console uses typed RPC.     |
| Operations  | Sentry envelope ingest and source-map upload        | SDK ingest and artifact upload are established streaming/binary HTTP protocols.                                 |
| Operations  | private catalog and release reconciliation          | Control-to-Operations synchronization is a service protocol, not a browser domain API.                          |

RPC routes are mounted before their REST wildcards. `route.all()` mounts the
established Fetch handlers inside the shared pipeline without changing their
accepted methods, response bodies, or status codes. This allows RPC and REST to
share authentication and runtime composition while compatibility consumers
migrate independently.

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

Every one of these calls presents a bearer and no cookie, so they are exempt from
the `FABRIKA_IAM_ADMIN_ORIGINS` check by the same rule that exempts any
bearer-only caller: a browser never attaches an `Authorization` header on its
own. **A credential-less call is not exempt** — nothing stops a hostile page from
making one, and IAM resolves "no credential presented" as the local-dev bypass, a
synthetic global admin. A machine caller that writes to `/admin/*` presents a
key, in every environment.

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
- migration directory and dependency order;
- legacy-ledger sentinel and effect evidence.

IAM, Control, and Operations use `iam_schema_migrations`,
`control_schema_migrations`, and `operations_schema_migrations`, respectively.
Operations composes the `platform-node` jobs bundle before its own service
bundle. Migration identity is `(bundle, filename)` under
[ADR-0017](../decisions/0017-service-owned-postgres-migrations.md). Bundle names,
filenames, ledger tables, and lock keys are durable and must not be renamed.

The old `schema_migrations` table is read-only adoption evidence. The wrapper
checks the service's sentinel tables and recorded effects before it adopts an
existing schema into the service-owned ledger. It does not turn the legacy table
into a shared migration ledger, and it does not merge the services' migration
ownership.

## Runtime conformance

`@fabrika/app/testing` sends a fresh equivalent request through direct
`FabrikaApp.fetch()`, the Bun adapter, and the Cloudflare adapter. It drains
background work and compares normalized status, headers, and body. IAM,
Delivery, and Operations each use this scaffold for routes whose behavior is
intentionally portable.

Composition-specific protocols remain outside a parity assertion. For example,
IAM's process health and shared-secret HTTP transport exist only in the Bun
composition, while the native service-binding transport belongs to the
Cloudflare composition.

## Environment boundaries

Configuration uses component-owned names from
[ADR-0018](../decisions/0018-canonical-fabrika-environment-names.md):

- applications use `FABRIKA_APP_ID` and `FABRIKA_IAM_URL`;
- IAM service configuration uses `FABRIKA_IAM_*`;
- Delivery service configuration uses `FABRIKA_CONTROL_*`;
- runner-owned workspace configuration uses `FABRIKA_RUNNER_WORKSPACE`;
- Operations keeps its existing `FABRIKA_OPERATIONS_*` names and consumes IAM
  through `FABRIKA_IAM_*` names.

These are the only names anything reads. Every composition root reads its own
canonical name off its own source, and there is no shared compatibility reader
— [ADR-0024](../decisions/0024-retire-the-legacy-environment-name-fallback.md)
retired the predecessor names and the fallback machinery together.

The retirement covered configuration names only. Deployed resource names, stored
application IDs, migration identities, provider envelopes, object keys, and other
durable values that contain a predecessor name remain unchanged until a dedicated
adoption or data-migration plan changes them.
