---
id: 82
title: A duplicate cross-app grant answers 500
blocked-by: []
---

# 82 — A duplicate cross-app grant answers 500

**Summary.** `grants.create` for a principal that already holds the same cross-app role hits a
uniqueness constraint that the handler does not absorb, so IAM answers 500 instead of a 409. Effort S.

## Problem

Found by the first-administrator contract test
(`packages/installation-zerops/src/__tests__/admin-contract.test.ts`), which drives the real admin
router: re-sending the exact `{ principalId, roleKey: 'admin', app: null }` grant returns 500. The
command works around it by checking "grant present" first, so `fabrika platform admin` is unaffected —
but every other caller of the admin surface (the console, a script) gets an opaque server error for an
ordinary idempotent retry.

## Approach / acceptance

Catch the constraint violation in the grants handler and answer 409 with a message naming the existing
grant, or make the create idempotent and answer the existing grant. Witness: a test in
`packages/iam` that creates the same grant twice and asserts the second response, plus the contract test
above asserting the new status.

## Touch points

`packages/iam/src/admin/` (the grants handler), `packages/iam/src/__tests__/`,
`packages/installation-zerops/src/__tests__/admin-contract.test.ts`.

<!-- Origin: cheap-rebuild sprint WU3 run log, 2026-08-21. -->
