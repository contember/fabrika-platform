---
id: 263
title: The leak sweep cannot seed a named row of an in endpoint whose table allows one per target
blocked-by: []
---

# 263 — The leak sweep cannot seed a named row of an in endpoint whose table allows one per target

**Summary.** An `in` endpoint whose input names a row (`GENERATED_ROW_PREFIX`) of a table with one row per target
(`unique (workspace_id)`) fails to seed, so the sweep prints a hint and checks nothing for it. Effort: S.

## Problem

The leak case of an `in` endpoint (`inScopesOf`, `packages/app/src/testing/endpoint-access.ts`) seeds worlds of every
table that lies in the dimension, the named table among them. On the named table's own turn its world row already lies
in the target, and `rowsIn` adds a second row there; under known scope values every turn shares the target. A unique
index on the container column then fails with `uniqueValueLimit`, which the sweep turns into a hint.

## Approach / acceptance

- On the named table's own turn, use its world row as the named row; under known scope values, seed each named row once
  per side and reuse it.
- Witness: a sweep with `inputs: { 'x.report': { id: GENERATED_ROW_PREFIX + 'settings' } }` over a table with
  `unique (workspace_id)` compares the endpoint, with fresh and with known scope values.

## Touch points

`packages/app/src/testing/endpoint-access.ts`, `packages/db/src/testing-shared.ts`.

<!-- Origin: review round 1 of rows under every access form (#107); rescoped to the leak sweep. -->
