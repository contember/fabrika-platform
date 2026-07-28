---
id: 0003
title: No deploy runner on Zerops — the platform executes the deploy
status: accepted
date: 2026-07-28
---

# 0003 — No deploy runner on Zerops — the platform executes the deploy

## Context

On Cloudflare, a fabrika deploy needs a **container**: `wrangler deploy` wants a
filesystem, and the app's build wants `bun install`. Workers have neither, so the
control plane hands each run to a Cloudflare Container that clones the repo and runs
the engine there. That container requirement is also why `@fabrika/runner` exists as
a _separate Worker_ from `@fabrika/control`: when fabrika deploys itself, a
self-deploy would otherwise reset the very container executing it.

Zerops removes the premise. It **has its own CI** — a build container with a real
filesystem and shell, 1–5 cores, 8 GB RAM, a 1-hour limit, not separately charged,
triggerable by git push, tag, `zcli`, the GUI, or the REST API
([pipeline docs](https://docs.zerops.io/features/pipeline)). Everything fabrika
would spin a container up to do, the platform already does.

What is left for fabrika on a Zerops deploy is five HTTP calls:

1. push secrets,
2. apply the import YAML,
3. trigger `/app-version`,
4. poll status and relay logs,
5. reconcile the authorization schema.

No filesystem. No shell. No container.

## Decision

We will **not** run a deploy runner on Zerops. The Zerops driver is pure HTTP
against the Zerops REST API, executed by the control plane itself.

Because the platform — not fabrika — executes the deploy, the control plane may
**trigger its own redeploy and then die**. On restart it reconciles in-flight runs
by polling `/app-version` for their status.

`@fabrika/runner` therefore stays a Cloudflare-only component.

## Consequences

- The Zerops installation has strictly fewer moving parts: no container image to
  build, no container lifecycle to manage, no runner deployment, and no
  runner/control version skew.
- **Self-deploy stops being a special case on Zerops.** The runner split was a
  workaround for "the thing running the deploy is the thing being replaced"; when
  the platform runs the deploy, that problem doesn't exist.
- The control plane must be **crash-safe across a deploy** — run state lives in the
  database, and startup reconciliation is a required feature, not a nice-to-have. A
  run whose status was only in memory is a lost run.
- Log relay is pull-based (polling `/app-version`) rather than streamed from a
  process fabrika owns, so log latency and granularity are whatever Zerops offers.
- Two quite different execution models now live behind one `DeployDriver`
  interface ([ADR-0002](0002-deploy-driver-owns-the-plan.md)). The interface must
  not assume a runner exists.

## Alternatives considered

- **Port the container runner to Zerops** (e.g. a long-lived service that clones
  and builds). Rejected: it duplicates a capability the platform provides for free
  and charges nothing extra for, and it would make fabrika responsible for build
  isolation, caching, and timeouts that Zerops already handles.
- **Keep the runner/control split on Zerops for symmetry.** Rejected: symmetry is
  not a benefit here — the split exists solely to survive self-deploy on
  Cloudflare, and paying for a second deployable to solve a problem that doesn't
  occur is cost without return.
- **Have the control plane block until the deploy finishes** instead of dying and
  reconciling. Rejected: on a self-deploy the control plane _is_ the thing being
  replaced, so blocking guarantees the run is orphaned at exactly the moment it
  matters most. Startup reconciliation is needed regardless — a crash produces the
  same state — so we may as well rely on it.
