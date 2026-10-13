---
id: 133
title: A scoped endpoint cannot read an application table
blocked-by: []
---

# 133 — A scoped endpoint cannot read an application table

**Summary.** Only an `app` endpoint reaches an application table, so an endpoint `on`, `in` or `over` a dimension
cannot read a code list an administrator edits, for example to validate a value in a status change. The private
dogfood used a database constraint instead. Effort: S–M; it needs a decision first.

## Problem

- `ctx.db.app` exists only on an `app` endpoint (`packages/app/src/contract/context.ts:218`–`:221`), and its runtime
  refuses any other capability (`packages/db/src/orm.ts:405`–`:409`). From a scoped handle an application table is
  `Unavailable<'<table> is an application table: declare access: { action, app: true } …'>` (`context.ts:183`).
- The table every endpoint reads is a reference table, and it is migration-managed and read-only
  (`docs/reference/application-runtime.md:375`–`:382`). A code list an administrator edits is therefore an application
  table (WU23a), which a mutation `on` a record cannot read.
- The private dogfood validated a status-change value against its code list with a foreign key from the record's
  column to the code list, so a wrong value is a database error (a 500), not a 400 that names the value.

## Approach / acceptance

Decide one of these:

- **(a) A scoped site reads an application table by its read action.** `ctx.db.app.<table>` (read-only: `list`,
  `count`, `aggregate`, `get`) exists on any endpoint whose action is the table's read action, every row, as a
  reference table is read. The table's read action decides who reads it, so an export log keeps an action no scoped
  endpoint holds. The approval diff already shows each table's actions.
- **(b) Keep it.** A scoped endpoint validates through a foreign key, or declares `unscoped: { <table>: 'read' }`. The
  skill says which, and how to answer 400 rather than a constraint's 500.

- Witness: an `on` mutation of the skill's intake recipe that reads the code list by its read action and refuses an
  unknown value with 400; a site of another action gets the `Unavailable` at its line and a refusal at run time; the
  policy isolation probe covers the read.

## Touch points

`packages/db/src/{orm,orm-types,store}.ts`, `packages/app/src/contract/context.ts`,
`packages/app/src/implement/invocation.ts`, `packages/app/src/testing/policy-isolation.ts`,
`packages/app/skill/references/{endpoint,table-and-migration,public-intake}.md`,
`docs/reference/application-runtime.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
