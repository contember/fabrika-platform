# fabrika-platform

An application platform for a small fleet of apps: **who may do what** (identity, policy, audit) and
**how it ships** (declare a deploy surface, provision it, deploy it) — behind one control plane, on
more than one cloud.

fabrika is the merger of two Cloudflare-only projects: **propustka** (IAM & audit) and **vozka**
(deploy control plane). The merge exists to break the Cloudflare assumption: a client picks **one**
platform — Cloudflare or [zerops.io](https://zerops.io) — and the whole stack runs there.

> **Status.** The Cloudflare path works. The portable runtime, static provider boundary, Zerops
> provider, and auth proxy are implemented and locally verified. Zerops support has not yet been run
> against a real account, so treat it as well-formed but unexercised.

## What it does

|                       |                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity & policy** | OIDC SSO for humans, opaque `px_` keys for machines, AWS-IAM-style policies over scope dimensions each app owns, plus an audit log.                                       |
| **Enforcement**       | Nothing reaches an app until auth rules pass. Only the proxy is publicly routed; app services stay internal.                                                              |
| **Deploy**            | An app declares its resources, its authz vocabulary and its build pipeline in one config. fabrika provisions and deploys it, triggered by a git push, a tag, or a button. |

## Packages

Bun monorepo (`packages/*`). Each installation statically selects one provider bundle.

**Auth** — `@fabrika/auth-core` (the pure kernel: policy matching, token shape, the IAM contract) ·
`@fabrika/auth` (the app-facing SDK) · `@fabrika/iam` (the IAM service) ·
`@fabrika/iam-ui` (its admin SPA).

**Deploy contract and core** — `@fabrika/provider-contract` (open provider interfaces and versioned
JSON envelopes) · `@fabrika/engine` (provider-neutral plan executor) · `@fabrika/control` (registry,
run lifecycle, and composition roots) · `@fabrika/platform` (runtime ports) ·
`@fabrika/platform-node` (Bun/Postgres/S3 adapters).

**Providers** — `@fabrika/provider-cloudflare` (Oblaka authoring, deploy implementation, control
adapter, and `fabrika-cloudflare`) · `@fabrika/provider-zerops` (authoring, static manifest compiler,
API client, deploy implementation, control adapter, and `fabrika-zerops`). The Cloudflare-only
`@fabrika/runner` transports and executes provider-owned runner jobs.

**Operations** — `@fabrika/cli` (installation bring-up) · `@fabrika/dashboard` (the control-plane
SPA) · `@fabrika/proxy` (auth enforcement for private app services).

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

MIT
