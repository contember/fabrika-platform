---
id: 264
title: A leak sweep case writes into a scope row a migration wrote
blocked-by: []
---

# 264 — A leak sweep case writes into a scope row a migration wrote

**Summary.** The leak sweep asks mutations too and uses stored scope rows (an enum `from` field) as they are, so a
mutation's write into one stays for the later cases of the run. Found so far: a later case quietly downgraded to a
hint, no false leak. Effort: S–M.

## Problem

The kit removes every row it inserted (`seedWorlds`, `packages/db/src/testing-shared.ts`) but never restores a stored
row a handler changed. The sweep runs its cases in endpoint id order, so `regions.close` (sets `status = 'closed'` on
the stored rows) runs before `regions.get`, which then answers 404 for a closed region; the sweep prints "its own scope
was answered 404" and checks nothing. A handler that deletes a stored row, or inserts children under it, leaves the
same kind of trace.

## Approach / acceptance

- Snapshot each stored row a case uses, and the rows that refer to it, before the case; restore them after it.
  Alternatively, run such a case inside a transaction the kit rolls back, if the runtime allows it.
- Witness: a delete, an update and an insert endpoint `on` / `in` a stored region leave the stored rows as the
  migration wrote them, and a query swept after them is compared.

## Touch points

`packages/db/src/testing-shared.ts`, `packages/app/src/testing/endpoint-access.ts`.

<!-- Origin: review round 2 of the known-scope-values change (#105); rescoped to the leak sweep. -->
