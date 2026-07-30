# What fabrika-platform is

fabrika-platform is a **single-tenant deploy control plane plus an IAM & audit
service**, for applications that run entirely on **one** cloud platform. It is the
merger of two previously separate, Cloudflare-only projects
([ADR-0001](../decisions/0001-merge-propustka-and-vozka.md)):

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

1. **A client picks ONE platform for everything.** Control plane, IAM, and apps all
   run on the same platform. There is no cross-platform deployment.
2. **Deployments are single-tenant.** One client, one installation.
3. **App portability is explicitly out of scope.** An individual app targets one
   platform and may use that platform's primitives freely. It is _fabrika itself_
   that must be portable, not the apps it deploys.

Consequence worth internalising: "multi-cloud" here means _fabrika runs on either
platform_, never _an app runs on both_.

## The packages

| Package                        | What it is                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@fabrika/auth-core`           | Shared IAM domain: policy model, scope dimensions, evaluation.                                 |
| `@fabrika/auth`                | The published SDK apps depend on.                                                              |
| `@fabrika/app`                 | Fetch routing, middleware, typed RPC, object authorization, client, explicit runtime adapters. |
| `@fabrika/iam`                 | The IAM service itself: identity, keys, policies, and audit.                                   |
| `@fabrika/iam-ui`              | Access feature routes embedded in the unified console.                                         |
| `@fabrika/provider-contract`   | Open runtime and control-provider interfaces plus versioned JSON envelopes.                    |
| `@fabrika/provider-cloudflare` | Cloudflare app authoring, deploy plan, control adapter, runner job contract, and CLI.          |
| `@fabrika/provider-zerops`     | Zerops app authoring, manifest compiler, API client, deploy plan, control adapter, and CLI.    |
| `@fabrika/engine`              | Provider-neutral execution of an explicit `RuntimeProvider` session.                           |
| `@fabrika/platform`            | Runtime ports shared by the control plane and IAM.                                             |
| `@fabrika/platform-node`       | Bun/Postgres/S3 implementations of those runtime ports.                                        |
| `@fabrika/control`             | Shared control-plane core plus separate Cloudflare Worker and Zerops/Bun composition roots.    |
| `@fabrika/cli`                 | Operator bring-up CLI.                                                                         |
| `@fabrika/dashboard`           | Unified Delivery and Access console served by control.                                         |
| `@fabrika/runner`              | Cloudflare-only transport and execution for provider-owned runner jobs.                        |
| `@fabrika/proxy`               | Shared auth enforcement service used by the provider-specific edge proxy.                      |

`@fabrika/auth` is a published SDK with downstream consumers (poplach, revizor,
opice); the rename is a deliberate, one-time break — see
[ADR-0001](../decisions/0001-merge-propustka-and-vozka.md).

## Operator console

Control serves one Fabrika console with Delivery and Access navigation. Delivery
routes call the control API directly. Access routes come from `@fabrika/iam-ui`
and call `/iam/admin/*` on the same control origin. Control transports those
requests to the private IAM admin API; IAM remains the owner of authentication,
authorization, policy data, and audit records.

IAM has no standalone SPA or public admin origin. Its public HTTP surface is
limited to native authentication and JWKS endpoints. Control-to-IAM RPC and admin
traffic use the platform's private service binding or network.

## Application runtime

`@fabrika/app` is the server framework for Fabrika applications. It owns the
Fetch-based request pipeline: typed HTTP routes, middleware, nested RPC routers,
Standard Schema validation, structural error responses, and the typed browser RPC
client.

The package root is runtime-neutral. Cloudflare and Bun lifecycle APIs live under
`@fabrika/app/cloudflare` and `@fabrika/app/bun`.

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
  `@fabrika/provider-cloudflare`. `fabrika-cloudflare deploy` executes an app
  deployment; `fabrika-cloudflare platform deploy` deploys the platform Worker
  and runner composition.
- Zerops configs import `defineApp` and Zerops resource types from
  `@fabrika/provider-zerops`. `fabrika-zerops build` evaluates the config and
  writes the static `fabrika.manifest.json` consumed during registration.

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

The control plane accepts a deploy request, takes a per-app-environment lock, and
calls the statically selected `ControlProvider`. The provider opens or delegates
an explicit runtime session. `@fabrika/engine` executes the provider-supplied
ordered plan without interpreting provider target data, artifact data, or step
kinds.

On Cloudflare, a separate runner Worker starts a Cloudflare Container. The
container clones the repository, installs dependencies, and executes the
Cloudflare plan. Keeping the runner separate lets the control plane deploy itself
without resetting the container that owns the run.

On Zerops, the app build runs `fabrika-zerops build --env=<env>` and produces a
versioned `fabrika.manifest.json`. Registration stores manifest version 2 in the
Zerops artifact envelope version 2. Its structured import document is the source
for both service claims and the YAML sent to Zerops. The app target envelope
version 2 stores only the app service id; the assigned deployment namespace
supplies the Zerops project and proxy coordinates. A queued deploy never imports
app TypeScript: the Bun control process applies the compiled import, triggers the
service pipeline, polls its app-version, and reconciles the IAM schema. It stores
the app-version id as soon as Zerops accepts the pipeline. Startup and scheduled
maintenance call the provider reconciliation capability for unfinished
platform-owned runs, so a self-deploy or restart does not lose the terminal state
([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)).

Secret edits follow the same registered service address but are not a deploy step.
The control plane writes or deletes them immediately through the service-env API
and stores only a `zerops:` reference. It never writes an app secret at project
scope.

## How auth works

Cloudflare apps can still enforce authorization through `PropustkaAuth` inside the
app. The Zerops topology enforces access in a **proxy**
([ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md)). Only the proxy is
publicly routed; app services stay internal, so bypassing auth stops being possible
rather than merely discouraged. The proxy is not new code — it is the same
session→token exchange, cache, and local JWKS verification, relocated into its own
process. It is Caddy + `forward_auth` on Zerops and a thin Worker on Cloudflare,
over one shared TypeScript auth service
([ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md)).

The IAM service stays **global** — one identity database, one audit log, one admin
UI. The proxy is **per deployment namespace**, stateless and horizontally
scalable. For correlation, the proxy preserves or creates `X-Request-Id` and
Caddy copies it onto the allowed upstream request. IAM prefers that value, then
`cf-ray`, then a locally generated UUID for audit records.

On Zerops the proxy manifest is a baked deploy artefact. Before an app deploy, the
control plane compiles every registered app manifest assigned to that namespace,
writes the JSON to the namespace proxy's service-level
`FABRIKA_PROXY_MANIFEST_JSON` variable, and rolls the proxy. Missing or malformed
JSON fails the proxy build. A valid empty app list routes no app and the auth
service denies every request. The control plane never uses a project-level
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
