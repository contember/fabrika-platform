---
id: 97
title: The generated tests have no move case
blocked-by: []
---

# 97 — The generated tests have no move case

**Summary.** The policy isolation and endpoint access tests cover get, list, insert, update and remove, but never `move`,
because no access form gives a handler the two capabilities a move needs. Medium effort; needs a contract access form
first.

## Problem

`DimensionTable.move` (`packages/db/src/store.ts:661`) takes two capabilities: a `Ref` for the delete action at the
source and a `Ref` for the insert action at the target container. An access form hands a handler one capability
(`ctx.target`), so no endpoint can call `t.move`, and neither generated kit has a case for it:
`policyIsolationKit` (`packages/app/src/testing/policy-isolation.ts`) probes get, list, insert, update and remove only,
and `endpointAccessKit` (`packages/app/src/testing/endpoint-access.ts`) asks only endpoints that exist. Both
`packages/db/CLAUDE.md:60` and `docs/reference/application-runtime.md:609` record the deferral. A job can mint two
`Ref`s (`ctx.ref`) and move a row today, with no generated test behind it.

## Approach / acceptance

- A contract access form that names two capabilities (the object `on` its dimension, the target `in` its container),
  checked by the dispatcher like every other form and handed to the handler as two minted `Ref`s.
- A probe case in `policyIsolationKit` for every table with a container: a move from the other scope is 404, a move
  into the other scope is 403, a move with a read `Ref` is refused by the data layer, and a `Ref` minted before the
  move reaches nothing.
- An endpoint access case for every endpoint with the new form, written by `fabrika db test-scaffold`.
- Witness: the cases above in the kits' own suites, and the regenerated fixture tests in `packages/cli`.

## Touch points

`packages/app/src/contract` (the access form), `packages/app/src/implement` (dispatch and capabilities),
`packages/app/src/testing/policy-isolation.ts`, `packages/app/src/testing/endpoint-access.ts`,
`packages/check/src/scaffold.ts`, `packages/cli/src/__tests__/fixtures/isolation-app/`, `packages/db/CLAUDE.md`,
`docs/reference/application-runtime.md`.

<!-- Origin: deferred from A11 of the application framework plan (docs/archive/sprint-2026-10-08-a-m2-data.md). -->
