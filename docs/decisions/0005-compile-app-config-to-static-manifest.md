---
id: 0005
title: Compile app config to a static manifest; the control plane never executes app code
status: accepted
date: 2026-07-28
---

# 0005 — Compile app config to a static manifest; the control plane never executes app code

## Context

`fabrika.config.ts` is TypeScript that must be **executed**, not parsed:
`resources({ env })` is a function, so getting an app's resource list means
installing the config's dependencies and running it.

Three separate problems follow:

1. **It forces an evaluation environment onto Zerops.** The Zerops driver is
   otherwise pure HTTP with no filesystem and no shell
   ([ADR-0003](0003-no-deploy-runner-on-zerops.md)). Executing app config would
   drag a whole runtime — install step, module resolution, sandboxing — back in for
   the sole purpose of reading configuration.
2. **It means running a stranger's code with platform credentials in scope.** Once
   "import a public GitHub app" exists, the control plane is executing arbitrary
   third-party TypeScript in a process that holds the Zerops personal access token
   — a token with **account-wide admin privileges**
   ([REST API reference](https://docs.zerops.io/references/api)). That is not a
   sandboxing problem to solve; it is a design to avoid.
3. **Imported repos have no config at all.** A control-plane path that produces a
   resource description _without_ running a `fabrika.config.ts` is required
   regardless — so the executing path was never going to be the only path.

## Decision

We will add a **`fabrika build`** step that evaluates `fabrika.config.ts` where the
app's own code already runs — in the app's build — and emits
**`fabrika.manifest.json`**.

The control plane reads static JSON. **It never executes app code.**

## Consequences

- The control plane's input becomes data it can validate, diff, store, and show in
  a UI — instead of a program whose output depends on when and where it ran.
- The Zerops driver stays pure HTTP.
- **`pipeline.vars` must change shape.** They are currently injected into
  `process.env` _before_ `resources()` runs, so config code can read them. With a
  static manifest they become **`${VAR}` placeholders** interpolated at deploy time.
- **The config language narrows** from arbitrary TypeScript to declarative data with
  interpolation. Anything an app was doing by computing its resource list at config
  time — loops, conditionals on environment, reading a file — must be expressible
  declaratively or move into the build step. This is a real capability loss and the
  main price of the decision.
- A manifest is a build artifact, so it needs versioning and a compatibility story
  between the `fabrika build` that wrote it and the control plane that reads it.
- Imported repos and first-party apps now travel the same path: something produces
  a manifest, the control plane consumes it.

## Alternatives considered

- **Execute `fabrika.config.ts` in the control plane, sandboxed.** Rejected: the
  sandbox has to be strong enough to contain hostile code next to an account-wide
  admin token, and it has to exist on both platforms including the one with no
  filesystem. The security burden is permanent and the failure mode is total.
- **Execute it only on Cloudflare (where a container exists) and require a manifest
  on Zerops.** Rejected: two config semantics, and the more dangerous one is the
  default. Divergence would be discovered by clients, not by tests.
- **Execute it in the deploy runner rather than the control plane.** Better, but
  still rejected: the runner is Cloudflare-only, so Zerops needs the manifest path
  anyway — and once the manifest path exists, the executing path is redundant
  surface area with worse properties.
- **Keep `pipeline.vars` in `process.env` and evaluate lazily at deploy.** Rejected:
  it is the same execution problem with later timing, and it makes the manifest a
  partial artifact — some of the config resolved, some not.
