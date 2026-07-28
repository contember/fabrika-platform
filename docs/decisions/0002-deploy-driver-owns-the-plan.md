---
id: 0002
title: Multi-cloud through a DeployDriver; the deploy plan belongs to the driver, not the engine
status: accepted
date: 2026-07-28
---

# 0002 — Multi-cloud through a `DeployDriver`; the deploy plan belongs to the driver, not the engine

## Context

`buildPlan` in `@vozka/core` (now `@fabrika/engine`) derives a **fixed, ordered
sequence** of steps for every deploy:

```
build → provision → migrate → deploy-worker → reconcile-schema → sync-secrets
```

That order is not a property of "deploying an app". It is a property of
**Cloudflare**. On Zerops:

- **build and deploy are one indivisible platform-side step** — you hand Zerops a
  git ref and it builds _and_ activates the version; there is no seam between them
  for fabrika to occupy ([pipeline docs](https://docs.zerops.io/features/pipeline));
- **migrations are not a plan step at all** — they run as `run.initCommands` when a
  runtime container starts
  ([zerops.yaml spec](https://docs.zerops.io/zerops-yaml/specification));
- **secrets push may not exist as a step** — see
  [ADR-0004](0004-secrets-live-in-the-platform.md).

So the difference between platforms is not "the same steps, implemented
differently". It is a **different set of steps in a different order**. Any seam
placed _below_ plan derivation forces the Zerops driver to fake Cloudflare's step
list — emitting no-ops for `sync-secrets` and `migrate`, and splitting one atomic
platform operation across `build` and `deploy-worker`.

There is an existing `DeployRuntime` seam, and it is tempting to reuse it. It is
the right idea at the wrong altitude: it exists so the engine can be **tested**
without touching a real cloud. A testability seam sits under the plan; a platform
seam has to sit over it.

## Decision

We will introduce a **`DeployDriver`** interface, one implementation per platform,
and **move plan derivation into the driver**. The engine orchestrates a plan — it no
longer decides what the plan is.

Per-layer, the drivers differ by exactly as much as the platforms do:

| Layer            | Portability   | Consequence                                                                  |
| ---------------- | ------------- | ---------------------------------------------------------------------------- |
| Secrets push     | Portable      | Shared implementation.                                                       |
| Schema reconcile | Portable      | Shared implementation — it talks to the IAM service, not to the cloud.       |
| Provisioning     | Semi-portable | Concepts map, vocabularies don't. Per-provider _translation_, shared design. |
| Build            | Per-provider  | Irreducible.                                                                 |
| Artifact deploy  | Per-provider  | Irreducible.                                                                 |
| Migrations       | Per-provider  | Irreducible — a plan step on CF, a container-start hook on Zerops.           |

`DeployRuntime` stays where it is, for what it was for: testing.

## Consequences

- Adding a platform means writing a driver, not editing the engine. The engine
  stops accumulating `if (platform === …)`.
- The engine's public surface narrows to plan **execution** — progress reporting,
  logs, failure handling, and cancellation — which is genuinely platform-neutral.
- Phase 3 must move Cloudflare's plan derivation into the CF driver **with
  behaviour unchanged**, so that the refactor is verifiable against existing tests
  before Zerops introduces any new behaviour.
- Two seams now exist in the same area (driver and runtime) and can be confused.
  The rule is: _what happens and in what order_ → driver; _what actually touches
  the network/filesystem_ → runtime.

## Alternatives considered

- **Reuse `DeployRuntime` as the platform seam.** Rejected: it sits below plan
  derivation, so the fixed Cloudflare step order survives; the Zerops
  implementation would be mostly no-ops plus one step doing two steps' work. It
  would also destroy the seam's actual purpose by loading platform semantics into
  the thing tests stub out.
- **Keep one plan, add conditionals per step.** Rejected: the conditionals are not
  local — they change the _shape_ of the sequence, not the body of a step. This is
  the version that looks cheapest at the first platform and is worst at the second.
- **Normalise both platforms onto a superset plan with no-op steps.** Rejected: a
  no-op `sync-secrets` step is a lie in the deploy log, and forcing Zerops'
  atomic build-and-deploy into two steps means inventing an intermediate state the
  platform does not have — which then has to be faked in progress reporting and
  failure handling.
