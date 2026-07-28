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

| Package              | Was                   | What it is                                                     |
| -------------------- | --------------------- | -------------------------------------------------------------- |
| `@fabrika/auth-core` | `@propustka/core`     | Shared IAM domain: policy model, scope dimensions, evaluation. |
| `@fabrika/auth`      | `@propustka/client`   | The published SDK apps depend on.                              |
| `@fabrika/iam`       | `@propustka/worker`   | The IAM service itself (identity, keys, policies, audit).      |
| `@fabrika/iam-ui`    | `@propustka/admin-ui` | IAM admin UI.                                                  |
| `@fabrika/config`    | `vozka-config`        | App-facing config (`fabrika.config.ts`) and its types.         |
| `@fabrika/engine`    | `@vozka/core`         | The deploy engine: plan derivation and execution.              |
| `@fabrika/control`   | `@vozka/worker`       | The control plane: registry, runs, orchestration.              |
| `@fabrika/cli`       | `@vozka/cli`          | CLI.                                                           |
| `@fabrika/dashboard` | `@vozka/dashboard`    | Deploy dashboard UI.                                           |
| `@fabrika/runner`    | `@vozka/runner`       | Deploy runner — Cloudflare-only, see below.                    |

`@fabrika/auth` is a published SDK with downstream consumers (poplach, revizor,
opice); the rename is a deliberate, one-time break — see
[ADR-0001](../decisions/0001-merge-propustka-and-vozka.md).

## How a deploy works

Today (Cloudflare): the control plane accepts a deploy request, takes a lock, and
hands the run to a **Cloudflare Container** which clones the repo, installs
dependencies, and runs the engine. The engine executes a fixed ordered plan —
build → provision → migrate → deploy-worker → reconcile-schema → sync-secrets. The
runner is a separate Worker so that a self-deploy does not reset the container
executing it.

Decided (both platforms): plan derivation moves out of the engine and into a
**`DeployDriver`** per platform
([ADR-0002](../decisions/0002-deploy-driver-owns-the-plan.md)), because that fixed
order is a Cloudflare artifact. On Zerops there is **no runner and no container** at
all — a deploy is a handful of HTTP calls, because the platform runs the build
itself ([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)).

## How auth works

Today: `PropustkaAuth` is middleware **inside** each app — enforcement depends on
the app wiring it up correctly.

Decided: enforcement moves into a **proxy**
([ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md)). Only the proxy is
publicly routed; app services stay internal, so bypassing auth stops being possible
rather than merely discouraged. The proxy is not new code — it is the same
session→token exchange, cache, and local JWKS verification, relocated into its own
process. It is Caddy + `forward_auth` on Zerops and a thin Worker on Cloudflare,
over one shared TypeScript auth service
([ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md)).

The IAM service stays **global** — one identity database, one audit log, one admin
UI. The proxy is **per environment project**, stateless and horizontally scalable.

## Where it's going

The work is sequenced as a ladder of independently shippable phases; each rung is a
backlog item — see [`../backlog/README.md`](../backlog/README.md). Phase 0 is the
merge itself (rename, green build, no behaviour change); the last rung is
self-hosting fabrika on Zerops.

## Related reference

- [`zerops-platform.md`](zerops-platform.md) — the established facts about Zerops
  that the decisions rest on, with sources.
- [`portability-surface.md`](portability-surface.md) — every Cloudflare primitive
  currently in use and its portable counterpart, plus the IAM port assessment.
