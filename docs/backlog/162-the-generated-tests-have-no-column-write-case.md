---
id: 162
title: The generated tests have no column-write case
blocked-by: []
---

# 162 — The generated tests have no column-write case

**Summary.** A column with its own write action (`columns: { assignee: { write: 'tasks.assign' } }`) is enforced by
the data layer, but no generated policy test proves it. Effort: S.

## Problem

`updatableBy` (`packages/db/src/orm.ts:309`, `:345`) lets a capability of a column's write action update exactly
those columns, and keeps them out of the table's update action. The scaffold writes `update` cases for the table's
update action and a hidden-column case for a column with its own read action (`packages/check/src/scaffold.ts:189`),
nothing for a column write action. The policy isolation probe (`packages/app/src/testing/policy-isolation.ts:171`)
has one `update` mutation under the table's update action, so it cannot hold a column's action at all. A handler or
a policy change that lets the table's update action write `assignee`, or lets `tasks.assign` write another column,
passes every generated test.

## Approach / acceptance

- The probe contract gains a mutation per column write action, under that action.
- The scaffold writes, per such column: the column's action updates it (200); the column's action is refused another
  column; the table's update action is refused the column.
- Witness: a scaffold case test over a fixture table with a column write action, and the generated cases of
  `examples/crm` (`deals.assign`) pass and are current.

## Touch points

`packages/app/src/testing/policy-isolation.ts`, `packages/check/src/scaffold.ts`,
`packages/check/src/__tests__/scaffold-cases.test.ts`, the regenerated fixtures.

<!-- Origin: the paved-road sprint, WU13a run log ("Not done: the generated isolation tests have no column-write case"). -->
