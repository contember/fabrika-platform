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

The [2026-09-23 live probe](../reference/zerops-platform.md#verified-live-2026-09-23-account-prg1--service-variables-across-activation-and-rollback)
confirmed that these writes survive failed and cancelled builds. The running process keeps its old
environment until restart, but then the old code boots with the failed or cancelled release's values.
Successful deployment picks up the current values. An explicit archived-version deploy restores code
but does not restore service-API variables. Fabrika must not claim transactional activation.

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
- The documented claim that restoring an archived version also restores its variables does **not**
  hold for service-API variables through `PUT /app-version/{id}/deploy` with an empty body, as used
  by `zops version rollback`. The live probe restored code v1 with v3's variables. `run.envVariables`
  and any different GUI restore operation were not measured.

## Approach / acceptance

- Preserve the live witnesses for successful build, failed build, cancellation, application restart
  and archived-version deployment. Add automated coverage and measure recovery across a Control-process
  restart; the isolated service probe did not run Control.
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
