---
id: 124
title: An unscoped write of a reference or inbox table fails only at run time
blocked-by: []
---

# 124 — An unscoped write of a reference or inbox table fails only at run time

**Summary.** `unscoped: { <reference table>: 'write' }` compiles, passes `fabrika-check` and the generated tests, and
every write through it is a 500 at run time. Effort: S.

## Problem

`UnscopedDeclaration` accepts every table of `src/db/tables.ts` in either mode
(`packages/db/src/orm-types.ts:364`–`:365`), and `UnscopedRows` types `insert`, `update` and `remove` for every
table declared `'write'` (`:368`–`:381`). At run time `insertUnscoped` refuses every table that is not a dimension or
child table: `query_refused: read_only` (`packages/db/src/orm.ts:502`–`:505`). An update fails with `unknown_column`,
because a reference policy has no `update` columns. The agent met it on a code list that an administrator edits. tsc,
the checker and the generated tests were green, and its own test got the 500. A reference table is documented as
"shared rows every endpoint reads and none writes" (`packages/app/skill/references/table-and-migration.md:197`–`:198`).
But `ctx.sql` under `sql: 'write'` does write one, so the agent declared that instead.

## Approach / acceptance

- The types refuse `'write'` for a reference or inbox table: an `Unavailable` that says the table is read-only and
  where its rows come from (a migration for a reference table, a form for an inbox). The contract compile refuses the
  same, so the checker reports it.
- A code list that an administrator edits is application data: an application table (`scope: { app }`, written by
  an `app` endpoint; the paved-road sprint's WU23a), not a reference table. The skill says that a reference table
  changes by migration only.
- Witness: a `kit-mistakes` case for `unscoped: { <reference>: 'write' }` and a checker test for the finding.

## Touch points

`packages/db/src/orm-types.ts`, `packages/db/src/orm.ts`, `packages/app/src/contract/build.ts`,
`packages/app/src/__tests__/kit-mistakes/`, `packages/app/skill/references/table-and-migration.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
