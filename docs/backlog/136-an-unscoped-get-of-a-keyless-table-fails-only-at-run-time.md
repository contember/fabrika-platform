---
id: 136
title: An unscoped get of a keyless table fails only at run time
blocked-by: []
---

# 136 — An unscoped get of a keyless table fails only at run time

**Summary.** `ctx.db.unscoped.<table>.get(key)` type-checks for a reference table and a form inbox, which have no key,
and fails at run time with `row_address`. Effort: S.

## Problem

`UnscopedRows` types `get(key)` for every declared table (`packages/db/src/orm-types.ts:427`–`:431`). At run time
`unscopedRows` answers `row_address` ("`<table>` has no key; read it with list") for a table that is not a dimension,
child or application table (`packages/db/src/orm.ts:528`–`:536`). WU23b fixed the same kind of gap for an unscoped
write of these tables (`ReadOnlyUnscoped`) and left this one.

## Approach / acceptance

- `get` on an unscoped reference or inbox table is an `Unavailable` that says "read it with list"; the runtime refusal
  stays.
- Witness: a kit mistake for each of the two table kinds, and a matrix row.

## Touch points

`packages/db/src/orm-types.ts`, `packages/app/src/__tests__/kit-mistakes/`, `packages/app/src/__tests__/kit-fixture/matrix.ts`.

<!-- Origin: the paved-road sprint, WU23b's Run log ("not fixed here"). -->
