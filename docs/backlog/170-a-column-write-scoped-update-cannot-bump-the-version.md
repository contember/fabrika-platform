---
id: 170
title: A column-write-scoped UPDATE cannot bump the version
blocked-by: []
---

# 170 — A column-write-scoped UPDATE cannot bump the version

**Summary.** A raw `UPDATE` scoped by a column's own write action may assign only columns that declare that action.
The version column may declare no action, so a scoped UPDATE that also bumps `version`, as the handles do, is
refused, and the application falls back to an unscoped `sql: 'write'` deviation. Effort: S.

## Problem

`checkWriteTarget` admits a column's own write action on an UPDATE only when every assigned column is in
`updatableBy(model, grant.action)` (`packages/db/src/store.ts:378`–`:388`). `updatableBy` answers the columns whose
`columnWrites` entry is that action (`packages/db/src/policy.ts:562`), and the policy refuses any action on the
version column: "the version … takes no action of its own" (`policy.ts:492`). So an `UPDATE tasks SET state = …, version = version + 1 WHERE ${ctx.sql.scope(capability, 'tasks')}` under the
`state` column's write action is refused with `wrong_action`.

The handles do bump it: a column write through `ctx.db` updates the row and its version together
(`store.ts:980`, `updateNode(table, changes, version, …)`). Raw SQL cannot keep the handles' optimistic lock under the
same capability, so a job or an endpoint that writes such a table in SQL drops the scope instead of the version bump.

## Approach / acceptance

- Treat the table's version column as assignable under any action that may update the row: the table's update
  action or a column's own write action. Keep the key unassignable. The SET-list reader names `version` whatever its
  value expression (`packages/db/src/sql.ts:493`), so the change belongs in `checkWriteTarget`, not in the reader.
- Witness: a `raw-sql-column-writes.test.ts` case runs `UPDATE … SET <column>, version = version + 1` scoped by the
  column's write action and passes; one that also assigns a column outside the action is still refused.

## Touch points

`packages/db/src/{store.ts,policy.ts}`, `packages/db/src/__tests__/raw-sql-column-writes.test.ts`, the raw SQL section
of `packages/app/skill/references/endpoint.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
