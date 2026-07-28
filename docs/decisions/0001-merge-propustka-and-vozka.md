---
id: 0001
title: Merge propustka and vozka into fabrika-platform under the @fabrika/* scope
status: accepted
date: 2026-07-28
---

# 0001 — Merge propustka and vozka into fabrika-platform under the `@fabrika/*` scope

## Context

Two separate projects, both Cloudflare-only:

- **propustka** — IAM & audit: OIDC SSO, opaque `px_` API keys, AWS-IAM-style
  policies over app-owned scope dimensions, per-path gates enforced in-process by an
  SDK, an audit log. It had previously _removed_ Cloudflare Access in order to be
  "100% native".
- **vozka** — a deploy control plane: an app declares its Cloudflare resources (via
  `oblaka-iac`), its propustka authorization schema, and its build pipeline in one
  config file; a control-plane Worker hands each deploy to a Cloudflare Container
  that clones the repo and runs the deploy engine.

The trigger is a client requirement to run entirely off Cloudflare, on
[zerops.io](https://zerops.io). Making that work means changing both projects at
once, in matched ways: vozka needs a per-platform deploy path
([ADR-0002](0002-deploy-driver-owns-the-plan.md)), and propustka needs enforcement
that does not depend on a Cloudflare-shaped SDK
([ADR-0007](0007-proxy-based-auth-enforcement.md)). Every one of the portability
decisions cuts across both codebases. Coordinating them as two repos with a
published package between them means a lock-step release dance on every step of a
multi-phase migration.

The scope of the target is narrow and that narrowness is what makes the merge
tractable: a client picks **one** platform for everything, deployments are
single-tenant, and app portability is explicitly out of scope — an app may target
one platform.

## Decision

We will merge propustka and vozka into a single monorepo, **fabrika-platform**,
with **clean git history** — a fresh start, with the old repositories archived.

All packages are renamed into the `@fabrika/*` scope:

| Old                   | New                  |
| --------------------- | -------------------- |
| `@propustka/core`     | `@fabrika/auth-core` |
| `@propustka/client`   | `@fabrika/auth`      |
| `@propustka/worker`   | `@fabrika/iam`       |
| `@propustka/admin-ui` | `@fabrika/iam-ui`    |
| `vozka-config`        | `@fabrika/config`    |
| `@vozka/core`         | `@fabrika/engine`    |
| `@vozka/worker`       | `@fabrika/control`   |
| `@vozka/cli`          | `@fabrika/cli`       |
| `@vozka/dashboard`    | `@fabrika/dashboard` |
| `@vozka/runner`       | `@fabrika/runner`    |

Phase 0 is the merge and rename only: green build, **no behaviour change**.

## Consequences

- One repository, one version, one CI. A change that spans IAM and deploy is one
  commit and one review.
- **The published SDK breaks for downstream consumers** — poplach, revizor, opice
  all import `@propustka/client`. This is accepted because
  [ADR-0007](0007-proxy-based-auth-enforcement.md) breaks that package's API
  anyway: the SDK loses minting and gate evaluation when enforcement moves to the
  proxy. Renaming now means consumers absorb **one** break instead of two.
- Clean history means `git log` no longer explains pre-merge code. The rationale
  that mattered is being rewritten into [`../decisions/`](README.md) instead; the
  archived repositories remain available for anything that isn't.
- Environment-variable prefixes (`VOZKA_*`, `PROPUSTKA_*`) are deliberately **not**
  renamed in phase 0, to keep it behaviour-neutral —
  [`../backlog/07-rename-env-var-prefixes.md`](../backlog/07-rename-env-var-prefixes.md).

## Alternatives considered

- **Keep two repos, coordinate releases.** Rejected: every portability phase
  touches both sides, so each rung of the ladder would need a matched pair of
  releases with a version-compatibility window in between. The coupling is real; a
  repo boundary would only hide it.
- **Merge but preserve both histories** (subtree merge / `git filter-repo`).
  Rejected: the resulting history is a two-headed graph whose value decays fast,
  and the packages are being renamed and restructured anyway, so blame across the
  boundary would be misleading rather than useful. The archived repos cover the
  audit case.
- **Merge without renaming packages.** Rejected: it leaves two product names in one
  codebase forever, and — decisively — the SDK's API is changing regardless, so the
  "avoid breaking consumers" argument buys nothing.
