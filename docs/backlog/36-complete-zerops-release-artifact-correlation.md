---
id: 36
title: Complete Zerops release artifact correlation
blocked-by: []
---

# 36 — Complete Zerops release artifact correlation

**Summary.** Finish the release evidence that cannot yet be produced by the
Zerops build path and expose the correlation from Delivery.

## Problem

Control projects deploy runs and releases into Operations and injects the
managed release identity on both providers. The Cloudflare runner can upload
bounded, authenticated source-map artifacts because it owns the build
filesystem. The Zerops control provider triggers platform-side builds and does
not yet receive their artifacts. Delivery run detail also does not link back to
the corresponding Operations release and issue/regression evidence.

## Approach / acceptance

- Define a Zerops-correct source-map publication path that runs where build
  artifacts exist and uses a run/release-scoped upload credential.
- Preserve deployment success when artifact publication fails; mark release
  artifacts incomplete and reconcile them when possible.
- Show the Operations release from Delivery run detail and show the introducing
  deploy, new issues, and regressions from Operations.
- Prove that source maps cannot cross application, environment, or release
  boundaries.
- On both runtime compositions, deploy a minified fixture and resolve its error
  frames to the original source.

## Touch points

- `packages/provider-zerops/` and Zerops build integration
- `packages/control/` and `packages/dashboard/`
- `packages/operations/` and `packages/operations-ui/`
- release/source-map integration fixtures

<!-- Origin: Operations plane foundation WU5 and consumed backlog 31. -->
