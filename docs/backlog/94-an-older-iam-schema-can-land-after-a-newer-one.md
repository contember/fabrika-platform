---
id: 94
title: An older IAM schema can land after a newer one
blocked-by: []
---

# 94 — An older IAM schema can land after a newer one

**Summary.** IAM holds one vocabulary per app, but Control serializes Cloudflare runs per environment. Two
environments of one app can apply their schemas in either order, and a run recovered after a Control
restart applies its schema whenever the next reconcile reaches it. The last apply wins, and nothing
repairs it. Effort S–M, plus a decision.

## Problem

- IAM keys the vocabulary by app alone: `app_scopes`, `app_actions` and `roles` have `(app, …)` primary
  keys (`packages/iam/migrations/0001_init.sql`), and the reconcile replaces the whole vocabulary.
- Control applies a Cloudflare run's IAM reconcile when it settles the run: on the awaited `startRun`
  result, or from `reconcileProviderRuns` after a restart (`packages/provider-cloudflare/src/control.ts`
  `settleOutcome`). The run lease is `runLeaseKey(appId, env)` (`packages/control/src/run-lifecycle.ts`
  `RunInvocation.acquire`), and `startRun` settles a blocking run of the same environment first. So
  within one environment applies land in order; across environments nothing orders them.
- Example: staging's run of commit X finishes while Control restarts. Prod's run of a newer commit Y
  applies on its RPC path. The next reconcile settles the staging run and applies X's schema last. Both
  runs read `succeeded`; IAM serves X's vocabulary to prod.

## Approach / acceptance

Decide first which environment's schema IAM serves when two environments of one app disagree (one
vocabulary per app, per environment, or a designated environment). Then either send IAM a generation (the
run's finish time plus id) and let IAM refuse an older one, or have Control re-assert the newest applied
run's schema after any late apply. Acceptance: a test where run A applies after run B ends with the
chosen schema in IAM.

## Touch points

`packages/provider-cloudflare/src/control.ts`, `packages/control/src/run-lifecycle.ts`, possibly
`packages/iam/src/admin/app-schema.ts` and the IAM contract.

<!-- Origin: sprint-2026-09-28-local-hardening, WU4 (backlog 88) re-review; re-verified at 28706106 by the port of that sprint. -->
