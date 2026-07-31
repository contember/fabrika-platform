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
| Delivery     | `@fabrika/control` `controlApp`       | `ControlRpcContract` in `@fabrika/control-contract`       | `/api/rpc`   | `@fabrika/auth` middleware supplies the request `AuthContext`                      | `control`       |
| Operations   | `@fabrika/operations` `operationsApp` | `OperationsRpcContract` in `@fabrika/operations-contract` | `/api/rpc`   | `@fabrika/auth` middleware owns operator authentication and IAM lookup             | `operations`    |

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
results.

## Authorization boundary

Delivery and Operations use the application-facing `@fabrika/auth` SDK. Their
middleware verifies the IAM-issued token and builds the canonical
`AuthContext`. A procedure or shared use case then performs the action and
object-scope check that depends on validated application data.

IAM is different only at the identity boundary: it authenticates its own admin
callers before invoking the same typed RPC dispatcher. Its admin REST and RPC
surfaces share typed use cases, so policy, audit, hidden-object behavior, and
request correlation do not diverge by transport.

Proxy gates still run before application code. They decide whether a request may
reach a private service. Application authorization decides whether the resolved
principal may perform the requested action on the specific object. Neither
check replaces the other.

## Compatibility HTTP surfaces

Typed RPC is the browser-facing domain API, but it does not replace every HTTP
surface:

| Application | Compatibility or protocol surface                   | Why it remains                                                                                                       |
| ----------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| IAM         | `/admin/*` REST                                     | Existing clients and status/error behavior remain wire-compatible while the UI uses `/admin/rpc`.                    |
| IAM         | `/auth/*`, `/.well-known/jwks.json`                 | Login, callback, session, and JWKS are native identity protocols, not domain RPC calls.                              |
| IAM         | service-binding `IamRpc` and Bun `/rpc/*` transport | Applications, Control, and the proxy use the process-to-process IAM contract; it is separate from browser admin RPC. |
| Delivery    | `/api/*` REST                                       | CLI, integration, and established control API consumers retain their request and response contract.                  |
| Delivery    | `/webhooks/github`, health, and assets              | Webhooks, probes, and static files have protocol-specific HTTP semantics.                                            |
| Operations  | `/api/*` operator REST                              | Existing operator consumers and the same-origin gateway remain compatible while the console uses typed RPC.          |
| Operations  | Sentry envelope ingest and source-map upload        | SDK ingest and artifact upload are established streaming/binary HTTP protocols.                                      |
| Operations  | private catalog and release reconciliation          | Control-to-Operations synchronization is a service protocol, not a browser domain API.                               |

RPC routes are mounted before their REST wildcards. `route.all()` mounts the
established Fetch handlers inside the shared pipeline without changing their
accepted methods, response bodies, or status codes. This allows RPC and REST to
share authentication and runtime composition while compatibility consumers
migrate independently.

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

New configuration uses component-owned names from
[ADR-0018](../decisions/0018-canonical-fabrika-environment-names.md):

- applications use `FABRIKA_APP_ID` and `FABRIKA_IAM_URL`;
- IAM service configuration uses `FABRIKA_IAM_*`;
- Delivery service configuration uses `FABRIKA_CONTROL_*`;
- runner-owned workspace configuration uses `FABRIKA_RUNNER_WORKSPACE`;
- Operations keeps its existing `FABRIKA_OPERATIONS_*` names and consumes IAM
  through `FABRIKA_IAM_*` names.

Configuration writers, generated files, installation flows, and examples emit
only the canonical names. Runtime and authoring readers retain canonical-first
fallbacks for the deprecated `PROPUSTKA_*`, `VOZKA_*`, and `VOZKA_WORKSPACE`
names. A reader warns at most once per legacy name and never includes the value
in the warning.

This compatibility applies only to configuration names. Deployed resource
names, stored application IDs, migration identities, provider envelopes, object
keys, and other durable values that contain a predecessor name remain unchanged
until a dedicated adoption or data-migration plan changes them.
