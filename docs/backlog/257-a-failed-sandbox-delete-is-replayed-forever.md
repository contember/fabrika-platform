---
id: 257
title: A failed sandbox delete is replayed forever
blocked-by: []
---

# 257 — A failed sandbox delete is replayed forever

**Summary.** Every delete of one Box sandbox sends the same `Idempotency-Key`, so once Box records a failed delete
operation, each retry is answered with that failure and the sandbox is never removed. Medium; it holds host capacity.

## Problem

`createZeropsDevSandboxes` (`packages/provider-zerops/src/sandbox/lifecycle.ts`) deletes with
`sandboxIdempotencyKey('delete', sandboxId)`, a key derived from the sandbox id alone. Box answers a repeated key with
the first request's operation for as long as it retains the key, including a `FAILED` one. A removal that failed once
(Box was mid-transition, an internal error) is retried by maintenance, which gets the same failed answer; the row stays
`removing`, the sandbox keeps its reservation, and a dev environment or application delete stays refused
([260](260-an-operator-cannot-remove-an-authors-sandbox.md)). The create key already
carries a fresh attempt for the same reason. The fake Box in the provider tests does not model replay, so no test sees it.

## Approach / acceptance

Make the delete key carry an attempt: a fresh key per removal attempt, or the key of the previous attempt only while
its operation is still running. Model replay in the fake Box (a repeated key answers the recorded operation) and test
that a delete whose first operation failed is retried with a new key and the sandbox is gone.

## Touch points

`packages/provider-zerops/src/sandbox/lifecycle.ts`, `packages/provider-zerops/src/__tests__/sandbox.test.ts`, the fake
Box in the provider's tests.

<!-- Origin: the comprehensive review of the per-workspace dev sandboxes PR (#84). -->
