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
> browser signing in through the auth proxy all run live. Operator-owned install/deploy automation and
> the application source-upload path for public and private GitHub repositories are implemented and
> locally verified. Their end-to-end real-account gates are still open: the same app commit has not yet
> reached `ACTIVE` through upload as both public and private, and the resulting browser/Operations flow
> has not yet been observed live.

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
`@fabrika/iam-contract` (runtime-neutral admin API DTOs).

**Application runtime** — `@fabrika/app` (Fetch-based HTTP routing, middleware, typed RPC, structural
errors, object-level authorization, a typed browser client, and Worker/Bun lifecycle adapters).

**Agent interfaces** — `@fabrika/daemon-kit` (Bun daemon lifecycle, HTTP routing, WebSocket channels,
and CLI waiters) · `@fabrika/annotations` (annotation state, editors, and text/block/region locators) ·
`@fabrika/canvas-kernel` (JSX compilation, revisions, rendering, and interactive canvas components).

**Application builder** — `@fabrika/builder` provides the guided specification, review, and
agent-assisted implementation loop exposed through `fabrika builder …` by `@fabrika/cli`.

**Operations** — `@fabrika/operations-contract` (browser/runtime-safe
protocols) · `@fabrika/operations` (portable ingest, persistence, triage,
release, source-map, alert, and health service).

**Deploy contract and core** — `@fabrika/provider-contract` (open provider interfaces, versioned
JSON envelopes for persisted data, and the shared step loop) · `@fabrika/control` (registry,
run lifecycle, and composition roots) · `@fabrika/control-contract` (runtime-neutral control API DTOs
and run-log shape) · `@fabrika/platform` (runtime ports) · `@fabrika/platform-node`
(Bun/Postgres/S3 adapters).

**Providers** — `@fabrika/provider-cloudflare` (Oblaka authoring, deploy implementation, control
adapter, and the internal `fabrika-cloudflare-executor`) · `@fabrika/provider-zerops` (authoring,
static manifest compiler, API client, deploy implementation, and control adapter).

**Installation and console** — `@fabrika/provider-contract/installation` (open platform CLI contract) ·
`@fabrika/provider-cloudflare/installation` and `@fabrika/provider-zerops/installation` (provider-specific
installation plans) · `@fabrika/cli` (the single public `fabrika` command) · `@fabrika/dashboard` (the unified
Delivery, Access, and Operations console) · `@fabrika/proxy-core` (the auth enforcement decision, shared
by both proxies; `/manifest` is the manifest wire contract).

**Cloudflare runner** — `@fabrika/provider-cloudflare/runner` (Worker↔container transport) ·
`@fabrika/runner-container` (plain-Bun deploy process and image) · `@fabrika/runner-cloudflare`
(out-of-band executor Worker).

App commands infer the provider from the provider-authored `fabrika.config.ts`; `--provider` is only
required without that config. Platform commands use the same `fabrika platform ...` surface and
dispatch through the selected provider's `/installation` subpath.

## Install

Installing fabrika means bringing the platform up in your own cloud account. The `fabrika` command
runs on [Bun](https://bun.sh) (≥ 1.3). It loads the provider package of the cloud you install on, so install
both:

```bash
bun add --global @fabrika/cli @fabrika/provider-zerops
```

On Zerops, the bring-up is three commands run from your machine, in this order:

```bash
fabrika platform install --provider=zerops --create-project --client-id=<id> --env=<name>
fabrika platform admin   --provider=zerops --email=<address> --iam-host=<host>
fabrika platform init    --provider=zerops <installation>
```

- `install` creates the Zerops project and the installation, and prints the provisioning key once.
- `admin` admits the first administrator and prints their enrollment URL.
- `init` creates the sidecar repository you own. Its GitHub pipeline deploys the platform from then
  on, and `fabrika platform upgrade --provider=zerops --to=<tag>` rolls it to a newer release.

The full procedure — prerequisites, where each credential lives, the first application, and a check
for every step — is in [`docs/reference/installing-on-zerops.md`](docs/reference/installing-on-zerops.md).
Each command prints its own surface with `fabrika platform --provider=<cloudflare|zerops> --help`.

## Development

Requires **[Bun](https://bun.sh)** (≥ 1.3).

```bash
bun install
bun run typecheck
bun run test
bun run lint          # biome
bun run format        # dprint
```

## Documentation

Start with [`docs/reference/overview.md`](docs/reference/overview.md) for the current architecture
and [`docs/decisions/README.md`](docs/decisions/README.md) for the decisions behind it.

## License

[MIT](./LICENSE) © Contember Limited
