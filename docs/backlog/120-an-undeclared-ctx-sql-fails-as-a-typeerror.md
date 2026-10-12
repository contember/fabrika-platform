---
id: 120
title: An undeclared ctx.sql fails as a TypeError
blocked-by: []
---

# 120 — An undeclared ctx.sql fails as a TypeError

**Summary.** At runtime a site without `sql` has no `ctx.sql` property, so a call is a plain `TypeError` and a 500
logged as `handler_failed`, which names neither the cause nor the declaration that fixes it. The types and the
checker already name it. Effort: S.

## Problem

The context gets `sql` only when the site declares it: `dispatch.ts` spreads `{ sql: invocation.sql(…) }` only for a
declared site (`packages/app/src/implement/dispatch.ts:751`, `:809`), and a job's `tx.sql` likewise
(`packages/app/src/jobs/runner.ts:589`). Without the declaration, `` ctx.sql`…` `` throws `TypeError: ctx.sql is not a
function`; the failure is reported by code only (`packages/app/src/implement/failures.ts:37`), so the log line is
`fabrika: api.deals.pipeline: handler_failed`. WU11 measured it on the CRM with `sql: 'read'` removed from
`deals.pipeline`: tsc names the fix at the line (an `Unavailable` that says "add sql: 'read'"), `fabrika-check` gives
the `sql-undeclared` hint, the runtime gives neither. A handler that reaches `ctx.sql` through an untyped helper, or an
agent reading only the server log, gets no pointer.

The other declared reaches already refuse by name: an undeclared `ctx.db.unscoped` write is a `QueryRefusedError`
with reason `undeclared_reach` (`packages/db/src/orm.ts:469`).

## Approach / acceptance

- An undeclared site's `ctx.sql` (and a job's `tx.sql`) is a function that throws `QueryRefusedError('undeclared_reach',
  …)` naming the site and the declaration (`sql: 'read'`, or `'write'` on a mutation, a job or a webhook), before
  anything is sent. The log line then carries the reason and its catalog text.
- The types stay as they are; the runtime member exists only to refuse.
- Witness: an `orm-dispatch` test of an endpoint and a job without `sql` that call it: 500, the log line
  `query_refused: undeclared_reach`, no statement reached the database.

## Touch points

`packages/app/src/implement/{dispatch.ts,invocation.ts}`, `packages/app/src/jobs/runner.ts`,
`packages/app/src/__tests__/orm-dispatch.test.ts`, `packages/app/skill/references/errors.md`.

<!-- Origin: the paved-road sprint, WU11 ("ctx.sql without the declaration"). -->
