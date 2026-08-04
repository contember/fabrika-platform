# What fabrika-platform is

fabrika-platform is a **single-tenant application platform** with three product
planes for applications that run entirely on **one** cloud platform:

- **Delivery** declares, provisions, and deploys applications.
- **Access** owns identity, policy, and audit.
- **Operations** ingests and groups errors, correlates releases and source maps,
  supports triage, and monitors active health.

Delivery and Access came from two previously separate, Cloudflare-only projects
([ADR-0001](../decisions/0001-merge-propustka-and-vozka.md)); Operations absorbed
the first useful Poplach slice under
[ADR-0016](../decisions/0016-independent-operations-plane.md):

- **propustka** — IAM & audit: OIDC SSO, opaque `px_` API keys, AWS-IAM-style
  policies over app-owned scope dimensions, per-path gates, an audit log.
- **vozka** — deploy control plane: an app declares its cloud resources, its
  authorization schema and its build pipeline in one config file; a control-plane
  Worker hands each deploy to a Cloudflare Container that clones the repo and runs
  the deploy engine.

## Why it exists in this shape

Both ancestors assumed Cloudflare everywhere. Some clients want to run entirely
**off** Cloudflare — specifically on [zerops.io](https://zerops.io). That is the
whole driver for the merge and for every portability decision in
[`../decisions/`](../decisions/README.md).

Three constraints follow from it, and they are load-bearing:

1. **A client picks ONE platform for everything.** Control, IAM, Operations, and
   apps all run on the same platform. There is no cross-platform deployment.
2. **Deployments are single-tenant.** One client, one installation.
3. **App portability is explicitly out of scope.** An individual app targets one
   platform and may use that platform's primitives freely. It is _fabrika itself_
   that must be portable, not the apps it deploys.

Consequence worth internalising: "multi-cloud" here means _fabrika runs on either
platform_, never _an app runs on both_.

## The packages

| Package                            | What it is                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@fabrika/auth-core`               | Shared IAM domain: policy model, scope dimensions, evaluation.                                 |
| `@fabrika/auth`                    | The published SDK apps depend on.                                                              |
| `@fabrika/app`                     | Fetch routing, middleware, typed RPC, object authorization, client, explicit runtime adapters. |
| `@fabrika/iam`                     | The IAM service itself: human authentication, identity, keys, policies, and audit.             |
| `@fabrika/iam-contract`            | Runtime-neutral IAM admin REST DTOs and typed RPC contract.                                    |
| `@fabrika/iam-ui`                  | Access feature routes embedded in the unified console.                                         |
| `@fabrika/email`                   | Portable outbound email contract and fetch-based provider adapters.                            |
| `@fabrika/operations-contract`     | Runtime-neutral ingest, catalog, release, access, operator DTOs, and typed RPC contract.       |
| `@fabrika/operations`              | Error ingest, grouping, triage, releases, source maps, health, and runtime compositions.       |
| `@fabrika/operations-ui`           | Operations feature routes and views embedded in the unified console.                           |
| `@fabrika/provider-contract`       | Open runtime and control-provider interfaces plus versioned JSON envelopes.                    |
| `@fabrika/provider-cloudflare`     | Cloudflare app authoring, deploy plan, control adapter, runner job contract, and executor.     |
| `@fabrika/provider-zerops`         | Zerops app authoring, manifest compiler, API client, deploy plan, and control adapter.         |
| `@fabrika/engine`                  | Provider-neutral execution of an explicit `RuntimeProvider` session.                           |
| `@fabrika/platform`                | Runtime ports shared by control, IAM, and Operations.                                          |
| `@fabrika/platform-node`           | Bun/Postgres/S3 implementations of those runtime ports.                                        |
| `@fabrika/control`                 | Shared control-plane core plus separate Cloudflare Worker and Zerops/Bun composition roots.    |
| `@fabrika/control-contract`        | Runtime-neutral control REST DTOs, typed RPC contract, and deploy log line shape.              |
| `@fabrika/installation-contract`   | Open contract for provider-specific platform `init`, `plan`, and `deploy` commands.            |
| `@fabrika/installation-cloudflare` | Cloudflare account bring-up and platform plan/deploy composition.                              |
| `@fabrika/installation-zerops`     | Zerops topology, generated installation artifacts, and platform plan validation.               |
| `@fabrika/cli`                     | The single public `fabrika` command and provider-aware command router.                         |
| `@fabrika/dashboard`               | Unified Delivery, Access, and Operations console served by control.                            |
| `@fabrika/runner-contract`         | Provider-neutral Worker↔container transport types and endpoints.                               |
| `@fabrika/runner-container`        | Plain-Bun process and container image that execute Cloudflare runner jobs.                     |
| `@fabrika/runner-cloudflare`       | Out-of-band Cloudflare Worker that hosts and relays the deploy container.                      |
| `@fabrika/proxy-contract`          | Proxy manifest wire types, encoder, and fail-closed parser.                                    |
| `@fabrika/proxy`                   | Shared auth enforcement service used by the provider-specific edge proxy.                      |

`@fabrika/auth` is the published application-facing IAM SDK; the rename from the
predecessor packages was a deliberate, one-time break — see
[ADR-0001](../decisions/0001-merge-propustka-and-vozka.md).

The narrow contract packages keep wire types away from runtime entrypoints:

- `@fabrika/control` and `@fabrika/dashboard` share REST DTOs through
  `@fabrika/control-contract`; its `RunLogLine` also crosses the runner boundary.
- `@fabrika/iam` and `@fabrika/iam-ui` share admin REST DTOs through
  `@fabrika/iam-contract`. The `IamRpc` and policy domain stay in
  `@fabrika/auth-core`.
- `@fabrika/operations`, `@fabrika/operations-ui`, and control's transport-only
  gateway share DTOs through `@fabrika/operations-contract`.
- the Zerops provider and control composition produce
  `@fabrika/proxy-contract` manifests; `@fabrika/proxy` parses and enforces them.
- `@fabrika/runner-cloudflare` and `@fabrika/runner-container` communicate only
  through `@fabrika/runner-contract`. Provider job semantics remain in
  `@fabrika/provider-cloudflare`.
- `@fabrika/cli` invokes provider-specific installation packages through
  `@fabrika/installation-contract`.

## Operator console

Control serves one Fabrika console with Delivery, Access, and Operations
navigation. Delivery uses `ControlRpcContract` at `/api/rpc`. Access routes come
from `@fabrika/iam-ui` and use `IamAdminRpcContract` at `/iam/admin/rpc` on the
same control origin. Operations routes come from `@fabrika/operations-ui` and
use `OperationsRpcContract` at `/operations/api/rpc`. Control transports the
latter two requests to the corresponding private service. IAM and Operations
retain authentication, authorization, domain-data, and audit ownership.
Cross-origin mutations are rejected at both gateways.

IAM has no standalone SPA or public admin origin. Its public HTTP surface is
limited to native authentication and JWKS endpoints. Control-to-IAM RPC and admin
traffic use the platform's private service binding or network.

Operations also has no standalone SPA or public operator origin. Its public
hostname accepts only source-bound Sentry envelope ingest and authenticated,
bounded source-map upload. Catalog and release synchronization, operator API
requests, health, and IAM principal lookup stay on the private platform network.
An Operations outage does not roll back registry mutations or deploys; control
records desired projections and replays them during maintenance.

Each registered application environment may carry an explicit canonical
`publicOrigin`. It is independent of the provider routing domain and is the only
origin Operations uses for active HTTP health checks. Control does not infer it
from provider envelopes or DNS names.

## Application runtime

`@fabrika/app` is the server framework for Fabrika applications. It owns the
Fetch-based request pipeline: typed HTTP routes, middleware, nested RPC routers,
Standard Schema validation, structural error responses, and the typed browser RPC
client.

The package root is runtime-neutral. Cloudflare and Bun lifecycle APIs live under
`@fabrika/app/cloudflare` and `@fabrika/app/bun`.

The platform's own IAM, Delivery, and Operations services use the same model.
Each defines a runtime-neutral `app.ts` and keeps Cloudflare/Bun lifecycle code
in its composition root. Delivery and Operations use the IAM SDK middleware;
IAM owns the identity boundary behind it. Their established REST and
service-binding transports coexist with typed RPC in the same framework.
The three concrete compositions, compatibility surfaces, and shared Postgres
migration wiring are documented in
[`core-application-composition.md`](core-application-composition.md).

The proxy and the application perform different checks. The proxy evaluates
static path gates before a request reaches the private app service. App middleware
verifies the injected Fabrika token and provides the canonical
`@fabrika/auth` `AuthContext`. An RPC procedure's `.require(action, scope)` then
checks the application-owned object coordinate that a path gate cannot know. See
[`application-runtime.md`](application-runtime.md) and
[ADR-0012](../decisions/0012-fabrika-app-runtime.md) and
[ADR-0013](../decisions/0013-explicit-runtime-adapter-entrypoints.md).

## Provider composition

One installation has exactly one provider. The Cloudflare Worker entrypoint
statically imports `@fabrika/provider-cloudflare`; the Zerops Bun entrypoint
statically imports `@fabrika/provider-zerops`. Shared engine and control code do
not contain a provider registry, a provider-id union, or branches for either
provider ([ADR-0011](../decisions/0011-static-provider-bundles.md)).

App configs use the selected provider package as their authoring surface:

- Cloudflare configs import `defineApp` and Oblaka resources from
  `@fabrika/provider-cloudflare`. `fabrika app deploy` executes an app deployment.
- Zerops configs import `defineApp` and Zerops resource types from
  `@fabrika/provider-zerops`. `fabrika app build` evaluates the config and
  writes the static `fabrika.manifest.json` consumed during registration.

The public CLI infers the app provider from the object returned by the selected
provider's `defineApp()`. App commands therefore need `--provider` only when the
config is absent. Platform commands load one `@fabrika/installation-*` module
through `@fabrika/installation-contract`; official provider names are aliases,
and a package specifier can supply another installation module.

The control-plane registry persists provider-owned target and artifact data as
opaque `{ provider, version, payload }` JSON envelopes. The selected provider
validates and normalizes those envelopes. Shared control owns registry rows,
locks, run status, secret resolution, and queue semantics; the provider owns
deploy, cancellation, reconciliation, and optional provider-managed secret
operations. Providers may also own deployment namespaces: placement lifecycle,
resource claims, and operator plans behind the same static contract. Adding
another statically linked provider does not require a core schema column or a
core provider branch.

Runtime portability is separate from deployment-cloud semantics.
`@fabrika/platform` defines SQL, blob, queue, lock, asset, and lifecycle ports.
The installation composition root binds those runtime ports and its provider
bundle together. See [`provider-bundles.md`](provider-bundles.md) for the
boundary in detail.

## How a deploy works

The control plane accepts a deploy request, takes a per-app-environment lock,
resolves the source-scoped Operations ingest configuration, and calls the
statically selected `ControlProvider`. It supplies managed
`FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` values separately from app-authored
configuration; providers reject collisions with those reserved names. The
provider opens or delegates an explicit runtime session. `@fabrika/engine`
executes the provider-supplied ordered plan without interpreting provider target
data, artifact data, or step kinds.

On Cloudflare, `@fabrika/runner-cloudflare` starts a Cloudflare Container. The
`@fabrika/runner-container` process clones the repository, installs dependencies,
and invokes the internal `fabrika-cloudflare-executor` to execute the Cloudflare
plan. `@fabrika/runner-contract` is the transport-only boundary between them.
Keeping the runner Worker separate lets the control plane deploy itself without
resetting the container that owns the run.

The Cloudflare runner also owns the build filesystem, so it can upload bounded
source maps to the release-scoped Operations artifact endpoint. Zerops builds
inside its own platform and does not yet publish those artifacts; that remaining
gap is [backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md).

On Zerops, the app build runs `fabrika app build --env=<env>` and produces a
versioned `fabrika.manifest.json`. Registration stores manifest version 2 in the
Zerops artifact envelope version 2. Its structured import document is the source
for both service claims and the YAML sent to Zerops. The app target envelope
version 2 stores only the app service id; the assigned deployment namespace
supplies the Zerops project and proxy coordinates. A queued deploy never imports
app TypeScript: the Bun control process applies the compiled import, triggers the
service pipeline, polls its app-version, and reconciles the IAM schema. The Zerops
control provider requires its composition root to inject `@fabrika/engine`; it has
no fallback executor. It stores
the app-version id as soon as Zerops accepts the pipeline. Startup and scheduled
maintenance call the provider reconciliation capability for unfinished
platform-owned runs, so a self-deploy or restart does not lose the terminal state
or terminal Operations release projection
([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)). A release is
unique per source and immutable commit, while every deploy attempt keeps its own
run link. The release summary follows the latest `observedAt`, so a delayed
failure from an older attempt cannot replace a newer successful retry.

The Zerops provider currently writes managed environment values before it
triggers the asynchronous app pipeline. Activation consistency when that
pipeline fails still requires
[backlog 37](../backlog/37-activate-zerops-managed-environment-transactionally.md).

Secret edits follow the same registered service address but are not a deploy step.
The control plane writes or deletes them immediately through the service-env API
and stores only a `zerops:` reference. It never writes an app secret at project
scope.

## How auth works

Both provider compositions enforce authorization in a **proxy**
([ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md)). Only the proxy is
publicly routed; app services stay internal, so bypassing auth stops being possible
rather than merely discouraged. The proxy is not new code — it is the same
session→token exchange, cache, gate matcher, and local JWKS verification, relocated
into its own process. It is Caddy + `forward_auth` on Zerops and a thin Worker on
Cloudflare, over one shared TypeScript auth service
([ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md)).

The IAM service stays **global** — one identity database, one audit log, one admin
UI. The proxy is stateless and horizontally scalable. Zerops owns one proxy per
deployment namespace; the current Cloudflare app graph owns one proxy root per
app environment. Cloudflare application children have no routes and disable
`workers.dev`. For correlation, the proxy preserves or creates `X-Request-Id`
and copies it onto the allowed upstream request. IAM prefers that value, then
`cf-ray`, then a locally generated UUID for audit records.

On Zerops the proxy manifest is a baked deploy artefact. Before an app deploy, the
control plane compiles every registered app manifest assigned to that namespace,
writes the JSON to the namespace proxy's service-level
`FABRIKA_PROXY_MANIFEST_JSON` variable, and rolls the proxy. Cloudflare app
authoring embeds one app manifest in the proxy Worker's vars and binds the app
Worker under `APP`; the provider deploys the proxy and child configs together.
Missing or malformed JSON fails closed. The control plane never uses a project-level
variable for this path.

## Related reference

- [`deployment-namespaces.md`](deployment-namespaces.md) — placement lifecycle,
  resource claims, Zerops presets, and operator interfaces.
- [`zerops-platform.md`](zerops-platform.md) — the established facts about Zerops
  that the decisions rest on, with sources.
- [`portability-surface.md`](portability-surface.md) — every Cloudflare primitive
  currently in use and its portable counterpart, plus the IAM port assessment.
- [`provider-bundles.md`](provider-bundles.md) — the static provider contract,
  persistence boundary, and composition roots.
