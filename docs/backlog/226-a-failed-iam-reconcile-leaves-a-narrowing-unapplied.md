---
id: 226
title: A failed IAM reconcile leaves a narrowing unapplied while the new version serves
blocked-by: [../sprints/sprint-2026-10-23-provider-neutral-core.md]
---

# 226 — A failed IAM reconcile leaves a narrowing unapplied while the new version serves

**Summary.** A deploy publishes the new manifest and version first and writes the approved IAM schema after, so a
narrowing (a role losing an action, a mount or a role removed) is not in force while the IAM write fails or is
pending. Decided: split the write by direction. Narrowings go to IAM before the manifest is published, so their
failure stops the deploy; widenings go after the publish. Effort M; it waits for the provider-neutral-core sprint,
which moves the IAM write into Control's run lifecycle.

## Problem

- Control writes `environment.access.schema` once a run has succeeded, after the provider published the manifest and
  the new version serves (`packages/control/src/run-lifecycle.ts`, WU1 of the provider-neutral-core sprint). Until
  that write lands, IAM resolves grants under the old schema.
- Scenario: version 2 removes `deals.delete` from the `sales` role. The deploy succeeds and the proxy serves version
  2's manifest, then the IAM write fails (IAM unavailable, or a refusal). Until a reconcile pass lands it, every token
  of a `sales` holder still carries `deals.delete`, and the proxy and the application admit it on every endpoint that
  still names it. The approval classified the change as a narrowing, so nobody was asked to accept the window.
- The authorization model ([`../ideas/authorization-model.md`](../ideas/authorization-model.md), "One catalog author")
  makes the approved catalog the only source of role meaning; this is the one path where a version serves under
  another.

## Approach / acceptance

- Split the approved schema into its narrowing part and its widening part, with the direction the approval diff
  already assigns each line (`AccessEffect`, `packages/control/src/approval/diff.ts`). Anything the diff cannot show to
  narrow access counts as a widening, as it does for the approval.
- Before the provider publishes the manifest: write the narrowings to IAM. A failure fails the run before publishing,
  so the old version keeps serving, as with any failed deploy (on Zerops a failed `initCommand` leaves the old version
  serving).
- After the publish: write the widenings, with today's failure semantics (the awaited deploy fails; a reconcile or a
  cancellation stays unsettled while IAM does not answer).
- The narrowing write must leave IAM in a state the old version still serves: it may remove only what version 2
  removes, never add anything.
- Witness: a Control test where the narrowing write fails: no manifest is published, the run fails, IAM is unchanged.
  A test where only the widening write fails: the manifest is published and the run follows today's failure path. A
  test that a schema with both directions writes the narrowing before the publish and the widening after it.

## Touch points

`packages/control/src/{run-lifecycle,iam-schema}.ts`, `packages/control/src/approval/diff.ts` (the split), the
provider contract's step that publishes the manifest (`packages/provider-contract/src/control.ts`), both providers'
publish step, IAM's schema write if it needs a narrowing-only mode (`packages/iam/src/repositories/app-schema.ts`).

<!-- Origin: the failed-reconcile gap of ../ideas/authorization-model.md. -->
