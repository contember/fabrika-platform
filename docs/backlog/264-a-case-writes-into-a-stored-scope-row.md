---
id: 264
title: A generated case writes into a scope row a migration wrote
blocked-by: []
---

# 264 — A generated case writes into a scope row a migration wrote

**Summary.** When a scope value is known (an enum `from` field) and a migration wrote its row, the generated cases use
that row as it is (#105). A mutation's requests then write into it, and nothing restores the write, so a later case of
the same file sees it. Effort: S–M.

## Problem

The kit removes every row it inserted (`seedWorlds`, `seedUnder`, `packages/db/src/testing-shared.ts`), but it never
removes a stored row, so it does not undo what a handler did to one. Against the throwaway test database, the leak case
of an endpoint `on` a stored region:

- **deletes it** when the handler removes its target (`ctx.db.target.remove()`): later cases miss the region;
- **changes it** when the handler updates it: a later case sees the new name;
- **leaves the children it inserts** under it (`in` a stored region), which the case does not track.

The other scope's request writes into the other stored row, and the `own` and leak cases write into the own stored row
when the migration wrote it too. Whether a later case notices depends on the order of the cases. The database is the
test run's own, so nothing outside the run is touched.

## Approach / acceptance

- Snapshot each stored row a case uses, and the rows that refer to it, before the case. Restore them afterwards:
  reinsert a deleted row, write back a changed one, and remove a row that now refers to it and was not there before.
  Alternatively, run a case that hits a stored row inside a transaction the kit rolls back, if the runtime allows it.
- Witness: a delete, an update and an insert endpoint `on` / `in` a stored region each leave the stored rows as the
  migration wrote them, and a case after them sees the original rows.

## Touch points

`packages/db/src/testing-shared.ts`, `packages/app/src/testing/endpoint-access.ts`.

<!-- Origin: review round 2 of the known-scope-values change (#105). -->
