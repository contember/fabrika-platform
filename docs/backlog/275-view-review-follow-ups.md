---
id: 275
title: View review follow-ups
blocked-by: []
---

# 275 — View review follow-ups

**Summary.** Two P2 findings from the second review of the view work (ADR-0072): codegen refuses a view it could leave
out, and no test witnesses how a row with a null parent column is scoped. Small.

## Problem

1. **Codegen refuses a view it could leave out.** Codegen now reads every view. The renderer checks each table and
   column name against the plain-identifier rule (`renderTables` in `packages/db/src/codegen.ts`) before a view column
   can be left out. So a view that passed codegen before fails it now, although it has no policy and only `ctx.sql`
   reads it. Two examples: on SQLite, `CREATE VIEW stats AS SELECT count(*) FROM things` names its column `count(*)`;
   on either dialect, a quoted alias such as `"Full Name"`. ADR-0072 decision 2 says an application meets views only
   when it declares a policy.
2. **No test of a null parent column.** In `__tests__/fixtures/view-layer.ts` every containment column is `NOT NULL`,
   so `views.test.ts` never seeds a row whose parent column is null. ADR-0072 decision 6 states how such a row is
   placed: a parent `Ref` does not read it, an organization `Within` does (including a project `Within` with an
   organization container grant), and another organization's `Within` does not. No test witnesses this.

## Approach / acceptance

1. Leave out a view column whose name is not a plain identifier, with a `leftOut` entry that names it (`of: 'view'`).
   Leave out a view whose own name is not a plain identifier in the same way. Keep the refusal for a table.
   Witnesses:
   - a SQLite codegen case with `count(*)`;
   - a Postgres case with a quoted alias;
   - both generate the module and name what they leave out.
2. Add a nullable containment column to a view, or to a child table and a view over it, in the shared fixture. Cover
   each read in decision 6 on both SQLite and Postgres.

## References

- [ADR-0072](../decisions/0072-a-view-is-a-read-only-table.md), decisions 2 and 6.
- The review round 2 comment on the view PR.
