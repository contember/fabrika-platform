---
id: 36
title: Complete Zerops release artifact correlation
blocked-by: []
---

# 36 — Complete Zerops release artifact correlation

**Summary.** Production Zerops builds upload their source maps; prove that Operations resolves original-source frames
from them, close the recovery gap, and expose the release correlation from Delivery.

## Problem

Control projects deploy runs and releases into Operations and injects the managed release identity on both providers.
Both providers now upload source maps with a run-scoped credential
([operations errors](../reference/operations-errors.md#release-source-maps)): the Cloudflare runner after its deploy,
and the Zerops platform build as its last command, which the provider confirms from the build log. What remains:

- The Zerops build reads the bearer through `${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}` of a SENSITIVE service variable.
  That lift works in production: every retained build of a production application reported `state=complete`
  ([Zerops platform facts](../reference/zerops-platform.md#verified-in-production-2026-10-19-to-2026-10-27-a-build-lifts-a-sensitive-service-variable-through-runtime_)).
  No `platform-facts` row pins it, and nobody has checked that Operations shows original-source frames for such a
  release.
- A Zerops run that Control settles through `reconcile` (after a Control restart) reports no artifact state, so its
  release artifacts are `incomplete` even when the build uploaded every map. `reconcile` could read the build log of
  the version once, as `await-version` does.
- Delivery run detail does not link back to the corresponding Operations release and issue/regression evidence.

## Approach / acceptance

The archived [readiness sprint](../archive/sprint-2026-09-23-zerops-production-readiness.md) (WU5) required
original-source frames on a real Zerops release. The upload is verified in production; the frames are not. The
Delivery/Operations correlation UI below is separate and can ship on its own.

- Pin the sensitive `${RUNTIME_…}` lift with a `platform-facts` row.
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
