---
id: 125
title: Application-wide data has no access form of its own
blocked-by: []
---

# 125 — Application-wide data has no access form of its own

**Summary.** **The most consequential finding of the private dogfood.** Every access form and every writable table
policy names a dimension, so data that belongs to the whole application has no place on the paved road. Examples
are a code list an administrator edits, operational counters, and the audit row of an export across every record.
Internal applications are often single-tenant: every role is a global grant, and much of their data is
application-wide, so they meet this first. Effort: M–L; it needs a decision first.

## Problem

- **The access forms.** The proxy's requirement is an action plus an access form, and the form is `over`, `in`, `on`
  or `creates`. Each one names a dimension (`packages/auth-core/src/contract.ts:131`–`:136`).
  `{ member: true }` is the only form without one, and it is forbidden for application data
  (`packages/app/skill/references/endpoint.md:81`, `:90`).
- **The table scopes.** A table is a dimension table, a child, a reference table or an inbox. A reference table is
  read-only (`ReferencePolicy`, `packages/db/src/policy.ts:97`–`:100`), and an inbox is written only by its form. No
  writable table lies outside a dimension.
- **What the agent did.** The dogfood was a public intake application (a candidate registration module of one of our
  projects). In it, every staff role is a global grant, and `candidate` is the only dimension:
  - Code list management became `{ action: 'codelists.manage', over: 'candidate' }` plus `sql: 'write'` into a
    reference table (a declared deviation; [124](124-an-unscoped-write-of-a-reference-or-inbox-table-fails-only-at-run-time.md)).
  - The operational counts became `{ action: 'ops.read', over: 'candidate' }` plus `sql: 'read'`.

  The action is what restricts both. The approver reads "over candidate" for data that belongs to no candidate. Under a
  global grant, `over` mints a `Within` of `'all'` (`packages/app/src/implement/dispatch.ts:577`–`:579`), so
  `over: '<dimension>'` only stands in for "the whole application".
- **The audited export was not built.** An audited export is a mutation that writes its log row through `ctx.db`
  (`references/endpoint.md:406`–`:408`). The row needs a table in the scope that the export reads, and a list of every
  record has none, so the skill says to ask the human (`references/public-intake.md:695`–`:697`). The options the
  agent put to the human were:
  - (a) a top-level log table written by declared raw SQL;
  - (b) an invented "export profile" dimension that owns the log, with the records read through `unscoped`;
  - (c) a platform audit API, which does not exist (`references/table-and-migration.md:207`–`:208`).

  Each one is a deviation, or a dimension that exists only to hold a log.

## Approach / acceptance

Decide first, then build the smallest form that holds all three examples:

- **An application table.** A policy scope `{ application: '<why>' }` for rows that belong to no dimension. It has
  `actions` (`read`, `insert`, `update`, `delete`) and `insert`/`update` column lists like a dimension table, and no
  chain. A reference table stays migration-managed and read-only, so a code list that an administrator edits becomes
  an application table.
- **An application access form.** `{ action, app: true }` (the name is open). Its requirement is the action held as a
  global grant, a permission entry without a scope. The proxy's one enforcement decision checks it
  (`satisfies`, `packages/auth-core/src/requirement.ts:13`–`:21`, run by `@fabrika/proxy-core`; ADR-0022). The
  handler gets `ctx.db.app.<table>` with that action's rights.
- **The export across every record.** Decide one of:
  - (i) the `app` form also reads every dimension table that the action reads, as `over` with `'all'` does today;
  - (ii) an `over` endpoint whose `Within` is `'all'` may insert into an application table whose insert action is the
    endpoint's action.

  Prefer (i): one form, one capability, and the global grant already reaches every row.
- **Approval.** The new form, and each application table's actions, appear in the approval diff like any other access
  (ADR-0050). A change of an endpoint to `app: true` is a widening.
- **Witness.**
  - The public intake recipe gains an administrator-edited code list and an audited export of every record on the
    paved road, with no `sql` and no `unscoped`.
  - A generated case shows that a caller who holds the action in one scope only is refused by the proxy (403), and
    that a global holder reaches the data.
  - The policy isolation probe covers application tables.

## Touch points

`packages/auth-core/src/{contract.ts,requirement.ts}`, `packages/proxy-core/`,
`packages/app/src/contract/{define.ts,build.ts,artifact-schema.ts}`, `packages/app/src/implement/dispatch.ts`,
`packages/db/src/{policy.ts,orm-types.ts,orm.ts,store.ts}`, `packages/app/src/testing/`, `packages/check/src/scaffold.ts`,
`packages/app/skill/references/{endpoint.md,table-and-migration.md,public-intake.md}`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
