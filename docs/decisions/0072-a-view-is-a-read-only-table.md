---
id: 0072
title: A view is a read-only table of the data layer
status: proposed
date: 2026-11-04
---

# 0072: A view is a read-only table of the data layer

## Context

A migration may create a view (`CREATE VIEW`, on Postgres also `CREATE MATERIALIZED VIEW`); the classifier admits it as
a deviation the approver reviews ([ADR-0017](0017-service-owned-postgres-migrations.md)). Codegen read only tables
(`relkind` `r` and `p`, SQLite's `table`), so a handler read a view through `ctx.sql` with a row schema written by hand,
and scoped it with `ctx.sql.scope` placed by hand. Real applications have 8 and 40 views: per-parent summaries
(a deal's activity count and last contact), joins a list page shows, report rows. Each is a site off the paved road
with its own hand-written types, although what it reads is a child table's rows in shape and in scope.

A view has no key, no foreign key and no `NOT NULL`, and no database enforces what its query says. The policy layer
relies on all three for a table: a containment column must be a foreign key to its container's key, and an inherited
chain one composite foreign key (`requireReference`, `requireCoveringKey`).

## Decision

1. **Codegen reads views.** Postgres reads `relkind` `v` and `m` beside `r` and `p`; SQLite reads `pragma_table_list`
   type `view`. A view's interface is `<Pascal>View`, every column is nullable (neither database records a view
   column's nullability), and its column list entry carries `view: true`. The module exports the views' names as
   `Views`, one per line, and the column list's type names them, `TypedColumnList<DB, Views>`, so the policy types know
   them. A view column of a type the data layer
   does not read is left out, as a generated column is, and named by every codegen run; a view left with no column is
   left out whole. On SQLite a view column's type is the declared type of the table column it selects; an expression
   has one only through `CAST(… AS INTEGER | REAL | TEXT)` (SQLite reports `INT`, `REAL`, `TEXT`), and is left out
   otherwise.
2. **A view's policy is optional.** A view without one is what it was: only `ctx.sql` reads it. So an application that
   upgrades with 40 views compiles unchanged and opts in view by view. A table still needs its policy.
3. **A view is declared like a child table, read-only.** `scope: { child: '<parent>', key?, column?, inherit? }` with
   the child's conventions: `column` defaults to `<parent dimension>_id`, the inherited chain is the parent's, and the
   view must carry every column of it. `key` defaults to `id`; a view keyed by its parent (one row per parent) states
   `key: '<parent column>'`, which only a view may share with its containment column. `scope: { reference }` is the
   other form, for a view every site reads. `dimension` and `app` scopes are refused: their rows are written.
4. **Policy attaches as to a child table.** A `Ref` of the parent reads the view's rows by `<column> = $id` and one
   equality per chain column; a `Within` by its chain columns; `ctx.db.app` lists it with `appRead` and `appCount`;
   column read actions hide columns. The predicates, the guard and the keyset lists are the table's, unchanged. A view
   keyed by its parent is read by the parent's own id, `ctx.db.target.<view>.get(ctx.target.value)`.
5. **Writes are refused at the type level and at run time.** The policy types allow only `actions.read`, `appRead`,
   `appCount` and column `read` actions on a view; `insert`, `update`, `version`, `createdBy`, `queue`, `files` and
   column `write` are refused by the one parse, so the static reader refuses them from source. Its handles' `insert`,
   `update` and `remove` are `Unavailable` (`<view> is a view, which no site writes`), an `unscoped: { <view>: 'write' }`
   declaration is refused, its unscoped handle refuses every write, and the store refuses an insert, update or delete
   root on a view before compiling (`read_only`).
6. **The view's query is the containment's only witness.** No foreign key ties a view's `deal_id` or chain columns to
   the parent row, so the policy checks only that the columns exist. The view's SQL is a migration deviation the
   approver reviews closer ([ADR-0050](0050-approved-access.md)); it must select the containment columns from the
   parent row (or from a row whose foreign keys tie it there). A row whose parent column is null is in no scope.
7. **The artifact marks a view.** A view's `TablePolicyArtifact` carries `view: true`, absent for a table, so every
   existing artifact keeps its digest. The approval diff says `New view policy …` and reports a table that becomes a
   view or stops being one; the database code lines show the view's SQL as before.
8. **The generated tests do not seed a view.** `fabrika db test-scaffold` writes no policy isolation case for a view,
   the endpoint access kit seeds none, and an endpoint fixture's row field may not name one: its rows come from other
   tables. The parent's cases still run.

## Consequences

- A view a handler reads through `ctx.db` needs no `sql` declaration, no hand-written row schema and no hand-placed
  scope fragment; the site stays on the paved road, so the approval diff shows one deviation less per site.
- Every view column reads `| null`. A count is `int8` on Postgres, read as a string, unless the view casts it
  (`count(*)::int4`).
- SQLite and Postgres type a view's computed timestamp differently: Postgres a `Date`, SQLite only `TEXT` through a
  cast. An application targets one dialect, so this is a difference of authoring, not of a deployed application.
- A view's isolation rests on its SQL, which the approver reads; the data layer does not check it.
- No installation state changes. The artifact field is additive and the platform reads an application with its own
  release's reader ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)); an older release never
  emits it.

## Alternatives considered

- **Scope a view through its parent:** `deal_id in (select id from deals where <parent scope>)`, so the view would need
  no chain columns and its containment would rest on the parent's foreign keys. It is the sounder rule, but the guard
  admits no subquery in a scope predicate, and a relational predicate is what the data layer's relation work is
  designing; this decision keeps to the predicates the guard admits and can move to that form once it exists
  ([backlog 274](../backlog/274-scope-a-view-through-its-parent.md)).
- **Declare the key and parent in the migration** (a `COMMENT ON VIEW` the codegen reads): a second place that states
  containment, read by codegen only, where the policy already states it for every table.
- **Require a policy for every view:** a migration guide for every application with views, for no added safety: a view
  without a policy is unreachable through `ctx.db`.
- **Type view columns from the source columns' nullability** (Postgres `pg_rewrite`, SQLite's declared types): only for
  a column that selects a base column directly, and Postgres keeps no catalog of that lineage.
