---
id: 36
title: Complete Zerops release artifact correlation
blocked-by: []
---

# 36 — Complete Zerops release artifact correlation

**Summary.** Prove the Zerops source-map publication on a real account, close its recovery gap, and expose the
release correlation from Delivery.

## Problem

Control projects deploy runs and releases into Operations and injects the managed release identity on both providers.
Both providers now upload source maps with a run-scoped credential
([operations errors](../reference/operations-errors.md#release-source-maps)): the Cloudflare runner after its deploy,
and the Zerops platform build as its last command, which the provider confirms from the build log. What remains:

- The Zerops build reads the bearer through `${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}` of a SENSITIVE service variable.
  That lift is not measured on a real account
  ([Zerops platform facts](../reference/zerops-platform.md#unverified-a-build-lifts-a-sensitive-service-variable-through-runtime_)).
- A Zerops run that Control settles through `reconcile` (after a Control restart) reports no artifact state, so its
  release artifacts are `incomplete` even when the build uploaded every map. `reconcile` could read the build log of
  the version once, as `await-version` does.
- Delivery run detail does not link back to the corresponding Operations release and issue/regression evidence.

## Approach / acceptance

Original-source frames on a real Zerops release are required before a production Zerops release (WU5 of the archived
[readiness sprint](../archive/sprint-2026-09-23-zerops-production-readiness.md)). The Delivery/Operations correlation UI
below is not; it can ship separately.

- Measure the sensitive `${RUNTIME_…}` lift on a real account and record it as a platform fact (a `platform-facts`
  row), or move the bearer to a mechanism that is verified.
- Report the artifact state of a run settled by `reconcile` from its build log.
- Show the Operations release from Delivery run detail and show the introducing deploy, new issues, and regressions
  from Operations.
- Prove that source maps cannot cross application, environment, or release boundaries.
- On both runtime compositions, deploy a minified fixture and resolve its error frames to the original source.

## Touch points

- `packages/provider-zerops/` (`src/control.ts` `reconcile`, `src/provider.ts` relay)
- `packages/control/` and `packages/dashboard/`
- `packages/operations/` and `packages/dashboard/src/operations/`
- release/source-map integration fixtures

<!-- Origin: Operations plane foundation WU5 and consumed backlog 31. -->
