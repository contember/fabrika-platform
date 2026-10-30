---
id: 262
title: Report a replaced ARCHIVED sandbox, and document the Box operator steps
blocked-by: []
---

# 262 — Report a replaced ARCHIVED sandbox, and document the Box operator steps

**Summary.** Two follow-ups of the change that adopted Box's 2026-10 release, left after its live check: `ensure`
replaces an `ARCHIVED` sandbox without saying that the workspace's database is gone, and the operator steps the release
asks for are not written down. Small.

## Problem

1. `ensure` finds a workspace's sandbox with `findSandboxByName`, which reads the default `GET /sandbox-list`. That list
   leaves out ended sandboxes (`ARCHIVED`, `TERMINATED`); only `?status=ARCHIVED` lists them, and a create under an
   `ARCHIVED` sandbox's name succeeds (verified live on 2026-10-30,
   [platform facts](../reference/zerops-platform.md)). So when Box archives a sandbox past its absolute TTL, the next
   bind creates a new one without the "had ended; it is replaced …, with an empty database" line, and nobody learns why
   the workspace's data is gone; a `TERMINATED` one goes unreported the same way. Fabrika creates no sandbox with a TTL,
   so only one set by hand is archived this way.
2. The release asks for one reload of the `zbox` service: until then a restart, such as the rekey's, still drops the
   memory of running sandboxes. A base Fabrika built earlier does not get the new Box agent, because the base is found by
   its content name. Neither step is documented for an operator.

## Approach / acceptance

1. Look the sandbox the binding records up by id (`GET /sandbox/{id}` answers an `ARCHIVED` one) before the name, or
   also read `?status=ARCHIVED`, and log the replacement as for `FAILED`. Test: a unit test where the name lookup finds
   nothing and the recorded sandbox reads `ARCHIVED` logs the replacement; `zbox-router.live.test.ts` asserts the line,
   and its router test, now pinned to `zbox:8081`, re-runs on the next live check.
2. Add both steps to `docs/reference/deployment-namespaces.md`.

## Touch points

- `packages/provider-zerops/src/sandbox/lifecycle.ts`, `src/zbox/client.ts`
- `packages/provider-zerops/src/__tests__/zbox-router.live.test.ts`
- `docs/reference/deployment-namespaces.md`
