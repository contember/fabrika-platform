---
id: 39
title: Settle what `override: true` does, and stop writing it on managed services
blocked-by: []
---

# 39 — Settle what `override: true` does, and stop writing it on managed services

**Summary.** The Zerops compiler writes `override: true` on **every** service and
builds an idempotency claim on top of it. Upstream documents the field as
runtime-services-only and as a _replace_, not an update. If upstream is right, the
steady-state re-apply is a destructive redeploy of every runtime service and a
no-op-or-error on every managed one.

## Problem

`compile.ts:62` writes `override: true` unconditionally, from a constant, at the one
construction site — and `manifest.ts:234` makes its absence a parse error. So the
generated documents carry it on `postgresql:ha@18` and `object-storage` as well as
on the Bun and Alpine runtimes
([`../../packages/installation-zerops/zerops/generated/platform.zerops-import.yaml`](../../packages/installation-zerops/zerops/generated/platform.zerops-import.yaml)).

Two claims rest on it, and both are ours rather than upstream's:

- `compile.ts:60-62` — "Re-applying the document updates the existing service
  instead of colliding with it: the whole idempotency claim of the `apply-import`
  step (ADR-0003)."
- `topology.ts:286-288` — the steady-state document is described as "the same
  document re-applied (`override: true`) to reconcile drift".

Upstream's import reference says the opposite in three places: import is
**create-only**, re-importing against an existing hostname does not edit the
service, `override` is **runtime services only**, and where it applies it
_replaces_ the service and forces a redeploy. Under that reading "reconcile drift"
means "destroy and redeploy every runtime service in the project", which is not
what either call site intends.

The published JSON schema **cannot catch this**. Verified against the pinned copy
in [`../../packages/installation-zerops/zerops/schemas/import-project-yml-json-schema.json`](../../packages/installation-zerops/zerops/schemas/import-project-yml-json-schema.json):
`override` is an unconstrained boolean and the per-type `if`/`then` branches
constrain only `profile`, `profileOverrides` and the scaling fields. A managed
service carrying `override: true` validates clean. This is the concrete case of
"schema-valid is not deployable".

A related consequence is already written into the code as a comment that cannot be
true under either reading: `topology.ts:95-98` claims an explicit
`enableSubdomainAccess: false` lets `override: true` _correct_ a subdomain someone
enabled in the GUI. A replace is not a correction, and per [`40`](./40-subdomain-access-is-not-import-settable.md)
the field is not import-settable on an undeployed service at all.

## Approach / acceptance

- Determine the real semantics against a live account: re-apply an **unchanged**
  document with `override: true` and record whether the runtime service is
  replaced, redeployed, or left alone; and whether a managed service carrying the
  field is ignored or rejected. This is backlog [`05`](./05-bring-up-on-a-real-zerops-account.md)'s
  question #1, promoted here because it decides a design, not a round trip.
- Stop writing `override` on services that cannot use it. The compiler builds each
  entry from constants, so this is a decision about which entries get the field —
  not a widened spread.
- Re-state ADR-0003's idempotency claim to match the answer. If re-apply is
  destructive, the steady-state document stops being a reconcile mechanism and the
  control path needs an explicit converge step (create what is missing, converge
  the fields the API can change in place, report the rest) instead of a re-import.
- Correct `topology.ts:95-98` so no comment asserts a correction the platform does
  not perform.
- Acceptance: the invariant tests encode the chosen rule per service class; the
  generated artifacts change accordingly; ADR-0003's consequence section says what
  re-apply actually does, with the observed evidence.

## Touch points

- `packages/provider-zerops/src/compile.ts`, `manifest.ts`
- `packages/installation-zerops/zerops/topology.ts`, `invariants.ts`, `generated/`
- [`../decisions/0003-no-deploy-runner-on-zerops.md`](../decisions/0003-no-deploy-runner-on-zerops.md)

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
