---
id: 274
title: Scope a view through its parent row
blocked-by: []
---

# 274 — Scope a view through its parent row

**Summary.** Read a view's rows by `<column> in (select <key> from <parent> where <parent scope>)`, so its containment
rests on the parent's foreign keys instead of on its SQL alone. Medium; waits for the data layer's relational predicates.

## Problem

A view read as a child table (ADR-0072) is scoped by equalities over its own columns: its parent column and its
parent's chain columns. No foreign key ties those columns to the parent row, so a view whose SQL selects them from the
wrong row puts a row in a scope its parent is not in. The approver reviews the view's SQL; the data layer checks only
that the columns exist. A view must also carry every chain column, which a per-parent summary would not need.

## Approach / acceptance

Once the guard admits a relational predicate (the data layer's relation work), scope a child view through its parent:
the parent's own scope predicate inside a subquery on the parent's key, and drop the chain-column requirement for a
view. Acceptance: a view without the chain columns reads under a `Ref` and a `Within` on both dialects, a row whose
parent column names a row out of scope is unreachable, and the approval diff shows the change of form.

## Touch points

`packages/db/src/policy.ts` (the view's chain), `packages/db/src/store.ts` and `links.ts` (the predicate),
`packages/db/src/guard.ts`, `docs/decisions/0072-a-view-is-a-read-only-table.md`.

<!-- Origin: ADR-0072, alternative "Scope a view through its parent". -->
