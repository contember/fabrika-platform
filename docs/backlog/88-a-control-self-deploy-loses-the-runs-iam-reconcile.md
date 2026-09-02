---
id: 88
title: A control self-deploy loses the run's IAM reconcile
blocked-by: []
---

# 88 — A control self-deploy loses the run's IAM reconcile

**Summary.** The security review moved the Cloudflare IAM reconcile out of the container: the
runner hands `{ app, schemaJson }` back on the run's outcome and the control plane applies it with
its own key (finding C2). The hand-back rides on the `startRun` RPC that control awaits for the
whole run. When the run is control deploying itself, the awaiting isolate is replaced mid-run: the
runner still writes the terminal status to the database, so the run reads `succeeded`, but nobody
applies the schema. Effort S.

## Problem

- `packages/control/src/platform-cf.ts` `startRunOnRunner` awaits `svc.startRun(job)` and maps
  `result.status.iamReconcile` into the outcome; `packages/provider-cloudflare/src/control.ts`
  `deploy` applies it after the await. Both live in the Worker a self-deploy replaces.
- The runner's guarded `finishRun` writes `succeeded` on its own, so the run's record and the IAM
  schema disagree, and nothing later notices.
- Before the review the container called IAM directly with a global provisioning key, so the
  abort did not matter. That path was the finding; this is the price of closing it.

## Approach / acceptance

Persist the reconcile with the run rather than in a promise: the runner Worker stores the outcome
file's `iamReconcile` beside the terminal status (a column on `runs`, or the outcome under the run's
R2 prefix) and control applies any reconcile the run row still carries unapplied, both on the RPC
return and from the maintenance sweep, marking it applied. A test: a run that finishes with a
reconcile while no `deploy` awaits it is reconciled by the next sweep, once. Until then a control
self-deploy that changes control's own schema must be followed by a second deploy of control.

## Touch points

- `packages/runner-cloudflare/src/worker.ts`, `src/relay.ts` — where the terminal status is written.
- `packages/control/src/platform-cf.ts`, `packages/provider-cloudflare/src/control.ts` — the apply.
- `packages/control/src/run-lifecycle.ts` — the sweep; a migration under `packages/control/migrations*/`.

<!-- Origin: security review 2026-09-02, finding C2 (A6-1); the user chose "control plane after the run returns". -->
