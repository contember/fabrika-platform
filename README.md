# fabrika-platform

An application platform for a small fleet of apps: **who may do what**
(identity, policy, audit), **how it ships** (declare, provision, deploy), and
**what happens afterward** (errors, releases, triage, alerts, and health) — on
more than one cloud.

fabrika is the merger of two Cloudflare-only projects: **propustka** (IAM & audit) and **vozka**
(deploy control plane). The merge exists to break the Cloudflare assumption: a client picks **one**
platform — Cloudflare or [zerops.io](https://zerops.io) — and the whole stack runs there.

> **Status — work in progress.** The Cloudflare path works. The Zerops path has been exercised
> against a real account: provisioning, service variables, the `.zerops.app` entry point, and a
> browser signing in through the auth proxy all run live. Two things are **not** built yet — fabrika
> does not deploy _itself_ to a fresh account (that pipeline belongs to whoever installs it, not to
> this repository), and an app deployed to Zerops cannot yet build from a private repository.

## What it does

|                       |                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity & policy** | OIDC SSO for humans, opaque `px_` keys for machines, AWS-IAM-style policies over scope dimensions each app owns, plus an audit log.                                       |
| **Enforcement**       | Nothing reaches an app until auth rules pass. Only the proxy is publicly routed; app services stay internal.                                                              |
| **Deploy**            | An app declares its resources, its authz vocabulary and its build pipeline in one config. fabrika provisions and deploys it, triggered by a git push, a tag, or a button. |
| **Operations**        | Sentry-compatible error ingest, grouping, scoped triage, release/source-map correlation, alerts, and active health checks.                                                |

## Packages

Bun monorepo (`packages/*`). Each installation statically selects one provider bundle.

**Auth** — `@fabrika/auth-core` (the pure kernel: policy matching, token shape, the IAM contract) ·
`@fabrika/auth` (the app-facing SDK) · `@fabrika/iam` (the IAM service) ·
`@fabrika/iam-contract` (runtime-neutral admin API DTOs) · `@fabrika/iam-ui` (Access feature routes
embedded in the Fabrika console).

**Application runtime** — `@fabrika/app` (Fetch-based HTTP routing, middleware, typed RPC, structural
errors, object-level authorization, a typed browser client, and Worker/Bun lifecycle adapters).

**Operations** — `@fabrika/operations-contract` (browser/runtime-safe
protocols) · `@fabrika/operations` (portable ingest, persistence, triage,
release, source-map, alert, and health service) · `@fabrika/operations-ui`
(Operations feature routes embedded in the Fabrika console).

**Deploy contract and core** — `@fabrika/provider-contract` (open provider interfaces and versioned
JSON envelopes) · `@fabrika/engine` (provider-neutral plan executor) · `@fabrika/control` (registry,
run lifecycle, and composition roots) · `@fabrika/control-contract` (runtime-neutral control API DTOs
and run-log shape) · `@fabrika/platform` (runtime ports) · `@fabrika/platform-node`
(Bun/Postgres/S3 adapters).

**Providers** — `@fabrika/provider-cloudflare` (Oblaka authoring, deploy implementation, control
adapter, and the internal `fabrika-cloudflare-executor`) · `@fabrika/provider-zerops` (authoring,
static manifest compiler, API client, deploy implementation, and control adapter).

**Installation and console** — `@fabrika/installation-contract` (open platform CLI contract) ·
`@fabrika/installation-cloudflare` and `@fabrika/installation-zerops` (provider-specific installation
plans) · `@fabrika/cli` (the single public `fabrika` command) · `@fabrika/dashboard` (the unified
Delivery, Access, and Operations console) · `@fabrika/proxy-contract` (the manifest wire contract)
and `@fabrika/proxy-core` (the auth enforcement decision, shared by both proxies).

**Cloudflare runner** — `@fabrika/runner-contract` (Worker↔container transport) ·
`@fabrika/runner-container` (plain-Bun deploy process and image) · `@fabrika/runner-cloudflare`
(out-of-band executor Worker).

App commands infer the provider from the provider-authored `fabrika.config.ts`; `--provider` is only
required without that config. Platform commands use the same `fabrika platform ...` surface and
dispatch through the selected installation package.

## Quick start

Requires **[Bun](https://bun.sh)** (≥ 1.3).

```bash
bun install
bun run typecheck
bun test
bun run lint          # biome
bun run format        # dprint
```

## Documentation

Start with [`docs/reference/overview.md`](docs/reference/overview.md) for the current architecture
and [`docs/decisions/README.md`](docs/decisions/README.md) for the decisions behind it.

## License

[MIT](./LICENSE) © Contember Limited
