---
id: 37
title: Activate Zerops managed environment transactionally
blocked-by: []
---

# 37 — Activate Zerops managed environment transactionally

**Summary.** Tie Zerops managed environment activation to the app version that
successfully becomes active, so a failed asynchronous deploy cannot expose
configuration for a release that never shipped.

## Problem

The Zerops provider currently reconciles `FABRIKA_OPERATIONS_DSN` and
`FABRIKA_RELEASE` as service-level variables before it triggers the app
pipeline. Zerops then builds and activates the version asynchronously. If that
pipeline fails, the prior application version can remain active while its
service variables already describe the failed release.

The current API and published platform documentation do not establish whether
these writes are snapshotted per app version, applied immediately to the active
service, or can be staged atomically. Fabrika must not claim transactional
activation until this is proven against Zerops.

Three documented facts constrain the protocol before any of that is settled:

- A service-variable write does **not** reach a running process. Upstream is
  explicit that a secret or project-variable change needs a **restart**, not a
  reload, and that a running process keeps its boot-time environment — so a
  post-activation write only takes effect on the next container start.
- `run.envVariables` are baked into the app version and need a full **redeploy**,
  and a key declared there **owns** its name: setting a service variable with the
  same name is rejected with `userDataDuplicateKey`. `FABRIKA_RELEASE` is already
  guarded against user collision (`packages/control/src/api/registry.ts:300`); the
  same rule has to hold against an app's own `zerops.yaml`, which fabrika does not
  author.
- Restoring an archived app version also restores the variables to their state when
  that version was last active — which is a compensating-rollback primitive worth
  measuring before building one by hand.

## Approach / acceptance

- Establish the real Zerops activation semantics for service variables during a
  successful build, failed build, cancellation, and control-process restart.
- Choose an activation protocol that keeps the last successfully active
  version and its managed environment consistent. This may require staging,
  post-activation writes, compensating rollback, or a provider-native primitive.
- Make the protocol idempotent under queue redelivery and restart
  reconciliation. An older run must not overwrite the managed environment of a
  newer active version.
- Preserve secret handling: managed values may reach only the app service and
  must not appear in manifests, provider envelopes, logs, or project-level
  variables.
- Add emulator tests for success, asynchronous failure, cancellation, retry,
  and restart. Complete the acceptance with a credentialed real-account witness.

## Touch points

- `packages/provider-zerops/`
- `packages/control/src/run-lifecycle.ts`
- `packages/control/src/provider-reconcile.ts`
- Zerops emulator and real-account verification

<!-- Origin: Operations plane foundation final review. -->
