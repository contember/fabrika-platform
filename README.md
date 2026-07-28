# fabrika-platform

An application platform for a small fleet of apps: **who may do what** (identity, policy, audit) and
**how it ships** (declare a deploy surface, provision it, deploy it) — behind one control plane, on
more than one cloud.

fabrika is the merger of two Cloudflare-only projects: **propustka** (IAM & audit) and **vozka**
(deploy control plane). The merge exists to break the Cloudflare assumption: a client picks **one**
platform — Cloudflare or [zerops.io](https://zerops.io) — and the whole stack runs there.

> **Status: phase 0.** The two codebases have just been merged and renamed under `@fabrika/*`. The
> Cloudflare path is the one that works today; the multi-cloud seams (platform ports, deploy drivers,
> the Zerops driver, the auth proxy) are designed but not built. See `docs/` for the decision record
> and the phase ladder.

## What it does

|                       |                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity & policy** | OIDC SSO for humans, opaque `px_` keys for machines, AWS-IAM-style policies over scope dimensions each app owns, plus an audit log.                                       |
| **Enforcement**       | Nothing reaches an app until auth rules pass. Only the proxy is publicly routed; app services stay internal.                                                              |
| **Deploy**            | An app declares its resources, its authz vocabulary and its build pipeline in one config. fabrika provisions and deploys it, triggered by a git push, a tag, or a button. |

## Packages

Bun monorepo (`packages/*`). Two halves that meet at the config surface.

**Auth** — `@fabrika/auth-core` (the pure kernel: policy matching, token shape, the IAM contract) ·
`@fabrika/auth` (the app-facing SDK, the only published one) · `@fabrika/iam` (the IAM service) ·
`@fabrika/iam-ui` (its admin SPA).

**Deploy** — `@fabrika/config` (the app-authoring surface: `defineApp`) · `@fabrika/engine` (the
deploy engine + the `fabrika` CLI) · `@fabrika/control` (the control plane) · `@fabrika/cli`
(operator bring-up) · `@fabrika/dashboard` (the control-plane SPA) · `@fabrika/runner` (the
Cloudflare deploy runner).

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

`docs/` holds the decision record — what was chosen, and why the alternatives lost. Start there
before changing anything structural; most of the surprising parts of this codebase are surprising on
purpose.

## License

MIT
