---
id: 0072
title: A view is a read-only table of the data layer
status: proposed
date: 2026-11-04
---

# 0072: A view is a read-only table of the data layer

## Context

A migration may create a view (`CREATE VIEW`); the classifier admits it as
a deviation the approver reviews ([ADR-0017](0017-service-owned-postgres-migrations.md)). Codegen read only tables
(`relkind` `r` and `p`, SQLite's `table`), so a handler read a view through `ctx.sql` with a row schema written by hand,
and scoped it with `ctx.sql.scope` placed by hand. Real applications have 8 and 40 views: per-parent summaries
(a deal's activity count and last contact), joins a list page shows, report rows. Each is a site off the paved road
with its own hand-written types, although what it reads is a child table's rows in shape and in scope.

A view has no key, no foreign key and no `NOT NULL`, and no database enforces what its query says. The policy layer
relies on all three for a table: a containment column must be a foreign key to its container's key, and an inherited
chain one composite foreign key (`requireReference`, `requireCoveringKey`). A view's columns are what its SQL fills, so
a scope over them is as sound as that SQL.

## Decision

1. **Codegen reads views.** Postgres reads `relkind` `v` beside `r` and `p`, and leaves a materialized view (`m`) out;
   SQLite reads `pragma_table_list` type `view`. A view's interface is `<Pascal>View`, every column is nullable (neither database records a view
   column's nullability), and its column list entry carries `view: true`. The module exports the views' names as
   `Views`, one per line, and the column list's type names them, `TypedColumnList<DB, Views>`, so the policy types know
   them. A view column of a type the data layer
   does not read is left out, as a generated column is, and named by every codegen run; a view left with no column is
   left out whole. On SQLite a view column's type is the declared type of the table column it selects; an expression
   has one only through `CAST(… AS INTEGER | REAL | TEXT)` (SQLite reports `INT`, `REAL`, `TEXT`), and is left out
   otherwise.
2. **A view's policy is optional.** A view without one is what it was: only `ctx.sql` reads it. So an application that
   upgrades with 40 views compiles unchanged and opts in view by view. A table still needs its policy.
3. **A view is declared like a child table, read-only.** `scope: { child: '<parent>', key?, column?, inherit? }`:
   `column` defaults to `<parent dimension>_id` and is the one containment column the view must carry. The parent's
   chain columns are optional; `inherit` defaults to those the view carries, and a stated one must be a containment
   column of the parent. `key` defaults to `id`; a view keyed by its parent (one row per parent) states
   `key: '<parent column>'`, which only a view may share with its containment column. `scope: { reference }` is the
   other form, for a view every site reads. `dimension` and `app` scopes are refused: their rows are written.
4. **Every capability reads a child view through its parent row.** A view's rows are those whose parent column names a
   parent row the capability reaches: `V.<column> in (select P.<key> from P where <P's predicate>)`. P's predicate is
   the one a statement on the parent builds for the same capability: a `Ref`'s key and chain equalities, a `Within`'s
   values, container and contained grants, the relation rows and reveals the capability is held through, and a
   `Within`'s member reveals and secondary paths. It leaves out the parent's own `when`, which holds the parent's rows;
   the view's own `when` narrows the view's (item 9). A get by key puts `V.<key> = $id` before the subquery. A `Within`
   lists the view wherever it reaches the parent, the parent's own dimension included, and a `Within` of `all` reads
   the rows whose parent row exists, `V.<column> in (select P.<key> from P)`. `ctx.db.app` lists every row of it with
   `appRead` and `appCount`, as it lists a child table's; column read actions hide columns; a join from the parent
   compares the parent column and the inherited columns. A view keyed by its parent is read by the parent's own id,
   `ctx.db.target.<view>.get(ctx.target.value)`. The guard admits the parent subquery only on a child view's
   statement, for its declared parent column, parent table and key, over a predicate it would admit on a statement of
   the parent, never `true`, or with no WHERE for every parent row, alone or after an AND of `V.<column> = $n`
   equalities. On a child view's statement it admits no other reach but `true`: no equality, value list or relation
   row over the view's own columns. The subquery counts apart from the nesting bound of the parent's predicate, so a
   view's scope nests at most one deeper than its parent's. `ctx.sql.scope` renders no
   `Ref` or `Within` of a child view: its fragment holds column tests only, and no column of the view places a row.
5. **Writes are refused at the type level and at run time.** The policy types allow only `actions.read`, `appRead`,
   `appCount`, column `read` actions and, on a child view, `when`; `insert`, `update`, `version`, `createdBy`, `queue`, `files` and
   column `write` are refused by the one parse, so the static reader refuses them from source. Its handles' `insert`,
   `update` and `remove` are `Unavailable` (`<view> is a view, which no site writes`), an `unscoped: { <view>: 'write' }`
   declaration is refused, its unscoped handle refuses every write, and the store refuses an insert, update or delete
   root on a view before compiling (`read_only`).
6. **The parent row places a view's rows.** The parent's own foreign keys place the parent row, so a view's
   containment rests on them and on its parent column alone. A chain column the view carries is read and joined, never
   compared for scope: a row whose chain columns disagree with its parent's lies where the parent lies. A row whose
   parent column is null, names no parent row, or names a row the capability does not reach, is read by no `Ref` or
   `Within`, a `Within` of `all` included. What the view's SQL still decides is which parent row each row names; it
   is a migration deviation the approver reviews closer ([ADR-0050](0050-approved-access.md)).
7. **The artifact marks a view.** A view's `TablePolicyArtifact` carries `view: true`, absent for a table, so every
   existing artifact keeps its digest. The approval diff says `New view policy …` and reports a table that becomes a
   view or stops being one; the database code lines show the view's SQL as before.
8. **The generated tests do not seed a view.** `fabrika db test-scaffold` writes no policy isolation case for a view,
   the endpoint access kit seeds none, and an endpoint fixture's row field may not name one: its rows come from other
   tables. The parent's cases still run.
9. **A child view's `when` narrows its reads, and a view holds no other access field.** `when: { <action>: <condition> }`
   narrows a read action of a child view as it narrows a table's ([ADR-0073](0073-a-relation-grant-is-application-data-read-on-every-statement.md)),
   after the parent subquery. A path may start at the view's parent column, which the parse takes for a foreign key to
   the parent's key that no column list declares, and follows the parent's own foreign keys from there under the path
   rule; that hop counts toward the three. No other column of a view is a foreign key, so no other path starts there,
   and no `some` or `none` reads rows that name a view's. A reference view takes no `when`: every site reads it. A view
   confers no relation, and takes no `reveals`, `readThrough` or `memberReveals`: each of them places or reads rows of
   its own table at a node, and a view's rows lie at no node of their own. A relation, a reveal or a secondary path that
   reaches the parent reaches the view's rows through the parent row (item 4).

## Consequences

- A view a handler reads through `ctx.db` needs no `sql` declaration, no hand-written row schema and no hand-placed
  scope fragment; the site stays on the paved road, so the approval diff shows one deviation less per site.
- Every view column reads `| null`. A count is `int8` on Postgres, read as a string, unless the view casts it
  (`count(*)::int4`).
- SQLite and Postgres type a view's computed timestamp differently: Postgres a `Date`, SQLite only `TEXT` through a
  cast. An application targets one dialect, so this is a difference of authoring, not of a deployed application.
- A view's isolation rests on its parent column: the data layer reads every row through the parent row it names, so a
  view's SQL can attach a row to the wrong parent, which the approver reads, but cannot place it outside its parent.
- A read of a child view runs one subquery on its parent, the parent's predicate inside it.
- A view declared in the first form of this decision, with every chain column, keeps its artifact and its digest:
  `inherit` still names the columns it carries. Its reads become the rows whose parent row the capability reaches; a
  row whose parent column was null or named a parent out of scope is no longer read.
- No installation state changes. The artifact field is additive and the platform reads an application with its own
  release's reader ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)); an older release never
  emits it.

## Alternatives considered

- **Scope a view by its own columns,** as a child table: `<column> = $id` and one equality per chain column for a
  `Ref`, the chain columns for a `Within`. It needs no subquery, but no foreign key ties those columns to the parent
  row: a view whose SQL selected them from the wrong row put a row in a scope its parent is not in, and every view had
  to carry the whole chain, which a per-parent summary does not need.
- **Apply the parent's `when` inside the subquery:** the parent's condition holds the parent's rows for an action. Applied to
  the view, it would narrow the view by a condition its own policy does not state, so an approver reading the view's
  policy would not see what narrows it. The view states its own.
- **Declare the key and parent in the migration** (a `COMMENT ON VIEW` the codegen reads): a second place that states
  containment, read by codegen only, where the policy already states it for every table.
- **Require a policy for every view:** a migration guide for every application with views, for no added safety: a view
  without a policy is unreachable through `ctx.db`.
- **Read a materialized view too:** its rows are a snapshot, refreshed when the application says so, so its containment
  columns keep a row's old parent after the parent row moves or is deleted. A capability over the new parent would read
  rows its parent no longer holds, until the next refresh. A handler reads one through `ctx.sql`.
- **Type view columns from the source columns' nullability** (Postgres `pg_rewrite`, SQLite's declared types): only for
  a column that selects a base column directly, and Postgres keeps no catalog of that lineage.
