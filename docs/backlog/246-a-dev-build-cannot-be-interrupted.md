---
id: 246
title: A running dev build cannot be interrupted
blocked-by: []
---

# 246 — A running dev build cannot be interrupted

**Summary.** Cancelling a dev bootstrap run, or settling it after its invocation was lost, leaves its build running in
the sandbox until the next deploy stops it. Medium.

## Problem

The dev deploy (`packages/provider-zerops/src/sandbox/deploy.ts`) starts the build as a detached Box process and records
its session in the run checkpoint. Two paths settle such a run without its invocation: the provider's `reconcile` and a
cancellation. Neither holds the sandbox host key, which Control composes from its vault only for a deploy and the
sandbox lifecycle calls, and the Box client (`packages/provider-zerops/src/zbox/client.ts`) has no call for Box's
`POST /session/{id}/interrupt`. The build keeps running until the next deploy into the sandbox runs `stop.sh`.

## Approach / acceptance

Hand the sandbox host key to `reconcile` and `cancel` of a run whose checkpoint names a sandbox, add `interruptSession`
to the client, and interrupt the recorded build session (then `stop.sh`) when such a run settles failed or cancelled.
Test: with the fake Box host, cancelling a run during its build step interrupts the build session.

## Touch points

- `packages/provider-zerops/src/zbox/client.ts`
- `packages/provider-zerops/src/sandbox/deploy.ts`
- `packages/provider-zerops/src/control.ts`
- `packages/control/src/run-lifecycle.ts`
