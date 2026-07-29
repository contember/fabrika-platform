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

The control plane accepts a deploy request, takes a per-app-environment lock, and
dispatches through a platform-specific **`DeployDriver`**
([ADR-0002](../decisions/0002-deploy-driver-owns-the-plan.md)).

On Cloudflare, a separate runner Worker starts a Cloudflare Container. The
container clones the repository, installs dependencies, and executes the
Cloudflare plan. Keeping the runner separate lets the control plane deploy itself
without resetting the container that owns the run.

On Zerops, the app build runs `fabrika build --env=<env>` and produces a versioned
`fabrika.manifest.json`. Registration stores that validated static data with the
app-env's project and service ids. A queued deploy never imports app TypeScript:
the Bun control process applies the compiled import, triggers the service pipeline,
polls its app-version, and reconciles the IAM schema. It stores the app-version id
as soon as Zerops accepts the pipeline. Startup and scheduled maintenance poll
unfinished platform-owned versions, so a self-deploy or restart does not lose the
terminal run state ([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)).

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
UI. The proxy is **per environment project**, stateless and horizontally scalable.
For correlation, the proxy preserves or creates `X-Request-Id` and Caddy copies it
onto the allowed upstream request. IAM prefers that value, then `cf-ray`, then a
locally generated UUID for audit records.

On Zerops the proxy manifest is a baked deploy artefact. Before an app deploy, the
control plane compiles every registered app manifest in that environment project,
writes the JSON to the proxy's service-level
`FABRIKA_PROXY_MANIFEST_JSON` variable, and rolls the proxy. Missing or malformed
JSON fails the proxy build. A valid empty app list routes no app and the auth
service denies every request. The control plane never uses a project-level
variable for this path.

## Where it's going

The portable runtime and Zerops control path are built and locally verified. The
remaining portability milestone is a real-account bring-up — see
[`backlog 05`](../backlog/05-bring-up-on-a-real-zerops-account.md).

## Related reference

- [`zerops-platform.md`](zerops-platform.md) — the established facts about Zerops
  that the decisions rest on, with sources.
- [`portability-surface.md`](portability-surface.md) — every Cloudflare primitive
  currently in use and its portable counterpart, plus the IAM port assessment.
