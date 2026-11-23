---
id: 0076
title: An access view decides the rows a relation reaches
status: accepted
date: 2026-11-17
---

# 0076 — An access view decides the rows a relation reaches

## Context

[ADR-0073](0073-a-relation-grant-is-application-data-read-on-every-statement.md) makes relation grants application data.
It covers source rows, reveals, secondary paths and structured conditions. We measured it against a production rule
corpus of an existing application: 4,409 conditional rules across five rule sets. A local translator turns each rule
into declarations and counts it only when the real policy parser accepts them. With the steps built so far, the
declarations express 3,157 rules (71.6 %).

Most of the rest fall into a few large classes. Counts are of all rules with the class, not only the uncovered ones:

- **An OR whose second branch names no variable** (334 rules). "A member reads the modules of their company, and every
  published module of any company." The second branch crosses tenants.
- **A view as the source** (206). "Whoever holds an active, unrevoked grant reads the case." "Active" is a join with a
  clock. ADR-0073 bars a view as a relation source, because the delegation bound cannot see its writes.
- **Several containers, or paths that part below the row** (273 and 168). A row is reachable through its company and
  through a billing account.
- **Writes and memberships off a secondary path** (245 and 249). The writer of a path column picks who reaches the row.
- **Conditions the structured form does not reach.** Examples: more than three foreign keys, a hop the hop rule
  refuses, or a JSON value.

The earlier steps of ADR-0073 extended the declarations one class at a time. Each step was an ADR section, a parser, a guard form
and an approval-diff line, and each cost days for a few points. `admits` was a structured widening inside a tenant
partition. It would have covered one class and deliberately left out the cross-tenant branch.

Real applications need every rule. Whatever the declarations leave out stays in handler code, which the approver does
not see as access.

What makes a general escape path hard:

- **One enforcement decision** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). The escape path must be a
  scope the data layer writes, not a check in a handler.
- **The guard is an allowlist** over the statement tree. It never admits a raw SQL node in a scope. A condition is
  structured data, never SQL (ADR-0073 section 3).
- **No request value reaches SQL text.**
- **Approved access** ([ADR-0050](0050-approved-access.md)). Whatever decides access shows in the approval diff.

## Decision

### 1. A table names an access view under a relation

A view of the application's schema ([ADR-0072](0072-a-view-is-a-read-only-table.md)) returns pairs: a row, and who
reaches it. A table names that view under a relation of the vocabulary:

```ts
// src/vocabulary.ts
relations: { marketplace: { dimension: 'company' } },
// a company membership role lists `via: { marketplace: ['modules.read'] }`, so IAM signs `~relin` at its company

// src/db/tables.ts
modules: {
	scope: { child: 'companies' },
	actions: { read: 'modules.read' },
	access: { marketplace: { view: 'published_modules', row: 'module_id', member: 'company_id' } },
},
```

```sql
-- a migration (Postgres); the view's clock is the database's, not the data layer's statement clock
create view published_modules as
	select m.id as module_id, c.id as company_id
	from modules m cross join companies c
	where m.published_at <= now();
```

The entry has four fields:

- **`row`** is the view's column that holds the table's key.
- **`principal`** is the view's column that is compared with the caller's principal.
- **`member`** is the view's column that is compared with the nodes the relation is held inside. These come from the
  `~relin` entries of ADR-0073 section 4 whose dimension is the relation's own. An entry at another dimension, such as
  a grant at an ancestor, reaches nothing through a `member` binding. So a node of one dimension is never compared with
  a key of another.
- **At least one binding is required.** A view with neither would be read whole, and the parse refuses it.

The relation and its actions are ADR-0073's: the vocabulary declares the relation, and a role's `via` lists the actions
it holds through it. `access` says only how the relation reaches this table's rows.

- A relation may have source tables, access views or both.
- A table may name several access views, one per relation.
- A table that names no access view for a relation served only by access views gets no term from it.
- The table's key must name one row on its own. The checker requires a single-column primary or unique key on the key
  of a table that names an access view. For a view as the target, the view's author keeps its key unique.

### 2. The term is one more subquery

For each relation the caller holds, the data layer adds a term to the table's reach:

```
T.<key> in (select V.<row> from V where [V.<member> in (<nodes>)] [and V.<principal> = $me])
```

- **The term is ORed** with the action's other grants, as a relation source's term is. The table's `when` and the
  relation's `relationWhen` still narrow it.
- **The bindings decide which holds count.**
  - A view bound to `member` reaches rows only for a hold inside a node (`~relin`). A hold anywhere (`~rel`) names no
    node, so it reaches nothing through such a view.
  - A view bound to `principal` alone reaches rows for either hold. A hold inside a node narrows its term to the rows
    inside that node, by the table's own column (ADR-0073 section 4).
  - A `member`-bound term is not narrowed to the node. The view maps the node to its rows, which may be rows of other
    tenants: that is the cross-tenant branch. ADR-0073 section 4 names this exception.
- **The values are the caller's.** `$me` and `<nodes>` come from the capability the framework minted. No other value
  enters the term.
- **On a table's statement, the guard admits nothing new.** The term has the subquery shape the guard already admits for
  relation sources, and the view joins the guard's allowlist by its table and its `row` column.
- **On a child view's statement, the guard admits one new member** of the union beside the parent subquery:
  `V.<key> in (select A.<row> from A where …)`, for an access view that view declares and no other (ADR-0072 item 4).
- **The nesting bound is unchanged.** The subquery counts as one level toward the bound of four. The view's own SQL is
  the database's, and the guard does not walk it.

### 3. Every statement reads the view

- **A `Within` ORs the term** into its list, count, aggregate and queue claim.
- **A `Ref` minted through the relation carries the term on every statement.** A change to the rows the view reads
  takes effect at the next statement, as a revocation of a source row does. `relates` answers through the same term.
- **`on` and `in` judge a hold inside a node by the object's own column** (ADR-0073 section 4). A row that a
  `member`-bound view maps outside the node is read through a `Within`, and no `Ref` of it is minted.
- **An insert under such a `Ref` checks its destination under the term**, in the insert's transaction, before the write.
  - The destination row is locked `FOR SHARE`. The view's base rows are not, because the data layer does not know which
    rows the view read.
  - Under READ COMMITTED, the check and the write each see what was committed at their own statement. So any insert
    that runs while a change to the base rows commits may pass on the state before it. SQLite serializes writers, so it
    has no such window.
  - An insert into a node that no table owns, held only through an access relation, is refused: nothing lists that node.
  - A move into a destination held through the relation is judged the same way. The insert's own `when` is judged as
    ADR-0073 section 3 says.
- **What refuses every relation refuses this one too:**
  - `ctx.sql.scope`, whose fragment renders column tests only;
  - a webhook binding, which outlives every statement (ADR-0073 section 1).
- **A child view may name an access view.** Its term serves a `Within`'s reads, beside the parent subquery. A `Ref`
  reads the view through its parent, as ADR-0072 says.

### 4. An access view takes no policy

An access view has no policy of its own, so no store or handle of the data layer reads it. The parse refuses an `access`
entry that names a view with a policy. The view maps principals and nodes to rows, so reading it directly would show the
caller who else reaches what.

A `ctx.sql` site can still name the view, as it can any view without a policy (ADR-0072 item 2). That read is raw SQL:
a declared deviation that the approval diff shows, reviewed as off-road code.

### 5. The view's writers delegate without a bound

Whoever writes a row the view reads changes who reaches the table's rows.

- ADR-0073 section 2 bounds the writer of a relation source with `assign`, a stamped node and immutable columns. An
  access view has no such bound. Its base tables are written by their own writers, under their own policies.
- They are not access tables in the sense of ADR-0073 section 2 (`accessTablesOf`). Stored code and `ctx.sql` may
  write them.
- **Assigning a membership role is a channel too.** Through a `member`-bound view, a grant at a node reaches whatever
  the view maps the node to, beyond the node itself. ADR-0073 section 4 bounds the assigner only at the node.

This is the second named exception to S8, wider than the first. It holds because the view is database code the approver
reads when approving the `access` entry, and the base tables it reads are in that SQL.

The approval diff does not track them afterwards. A later change to who writes a base table shows as that change, not as
a change to the relation:

- a new write action;
- a writing `ctx.sql` or `unscoped` site;
- a trigger;
- a replaced function the view calls.

ADR-0073's bar on a view as a relation source stands. A source row is a grant held to a bound. An access view is a rule
the approver reads.

### 6. The approval diff and the artifact

- **The artifact carries `access` on a table only when declared**, so an application without it keeps its digest.
  - An older data layer refuses the unknown field at parse and does not boot, so it fails closed.
  - A reader that ignores the field would reach less, not more. ADR-0073 section 5's publish refusal still counts it,
    at the floor of `relationWhen`, so an application pinned to an older release is refused before anything publishes
    rather than failing its own build ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
  - The token, the manifest and IAM do not change: the term reads the `~rel` and `~relin` entries IAM already signs.
- **The approval diff shows each `access` entry** as a line naming the table, the relation, the view and its bindings.
  An added or changed entry widens, with closer review. A removed one narrows.
- **The view's SQL is the migration's database code**, which the diff already shows with closer review. Beside it, the
  diff names the relations the view decides, so the approver knows they are reading access. An entry that newly names
  a view whose migration has already run shows that view's SQL again: it was approved when it decided nothing.
- **Static checks.** The policy parse, which `fabrika-check` runs against the generated column list, checks that the
  named view is a view, has the bound columns and has no policy. `fabrika-check`'s `access-view-key` checks in the
  migrations that the table's key is unique on its own. Neither can check what the SQL selects.

## Consequences

- **Coverage.**
  - The declarations or an access view express 4,389 of the corpus's 4,409 rules (99.5 %). With every ADR-0073 step,
    built or not, the declarations express 3,421; the access view takes 968 of the 988 they leave out.
  - A replay measured the access-view part. It took the 976 rules that the declarations leave out and that read no IAM
    data, and generated an access view from each rule's own predicate: the source system's compiled condition, with
    each variable a column of a cross-joined domain. A rule whose OR mixes bindings became one view per binding, except
    the rules described below. On Postgres with random rows, the replay compared the rows the data layer reaches
    through the view with the rows the source system's own SQL admits. Reads went through a `Within`. Writes read the
    existing rows through a `Ref` of the write action; no write ran.
  - Each of the 968 runnable rules agrees on every seed for a caller whose principal the rows name. 910 of them had a
    seed where the rule both admits and refuses rows. With one view per binding and the remedy below, every rule bound to
    a principal also agrees for a principal that no row names.
  - The 20 exceptions, not replayed:
    - 12 rules read other principals' memberships from IAM, which an application's database does not hold;
    - 6 rules take their condition from the membership itself, not a value;
    - 2 rules require memberships at two dimensions at once, an AND that one term cannot express.
  - **A branch for every holder of a role joins a table of the application's principals.** A principal-bound view whose
    principals come from the application's rows reaches only the principals those rows name.
    - 280 rules OR a branch bound to the principal with a branch that names no variable. Each comes from a role that
      names no node, so it ports as a role held anywhere (`~rel`). As such a view, 262 of them reached fewer rows than
      the source system for a principal no row names, never more.
    - **The remedy:** the view takes its principals from a table that lists every principal of the application. The
      rule stays one view, under one role held anywhere. All 280 rules then agree for such a principal on all 6 seeds,
      as they do for a named one.
    - The table must list the principal. One it does not list reaches nothing through the view, so a table that lags
      behind IAM narrows access. It never widens it: the hold still comes from IAM, and the term binds the caller.
    - The table is a copy of IAM's principals that the application keeps in step. It is a base table the view reads,
      so its writers delegate without a bound (section 5), but a write can only withhold what the rule admits a
      holder, never add to it.
    - **The alternative, also replayed:** the branch with no variable as a second view, under a second relation bound
      by `member` to one node that the view maps to every row the branch admits. It agrees on the same rows and seeds,
      but the port needs two roles: the role held anywhere, and a membership in that node. One role inside the node
      would not do, because a hold inside a node narrows the principal-bound term to that node (section 2).
  - The replay does not measure a view's cost, hand-written views, SQLite, or the SQL of the source system's own view
    entities, which it seeded as tables. The data layer's own access-view tests run on SQLite.
- **A wrong view widens access, across tenants too**: for example a `cross join` without a filter, or a missing tenant
  join. The guard cannot see it. What catches it:
  - the approval diff, with closer review;
  - the application's tests;
  - the framework's skill, which shows how to test what a given principal reads.
- **Cost.** Each statement under the relation evaluates the view's subquery, so its cost is the view's. An application
  whose view is slow writes the access as a relation source table instead (ADR-0073 section 1) and pays the delegation
  bound for it. Postgres runs two ORed terms as hashed subqueries, so a `Ref`'s statement reads each view whole: in the
  replay, a `Ref` statement over two generated views took up to about 7 s.
- **The view's writers, and a membership assigner, delegate without a bound** (section 5). An application that wants
  bounded delegation uses a relation source.
- **Rollout of an existing installation.** No generated installation file, environment variable, provider state or IAM
  migration changes. An application opts in by raising its pin and declaring `access`. One that declares none keeps its
  digest and its reach.

## Alternatives considered

- **A grant table the application maintains**: a relation source per rule, written by its handlers or triggers.
  - It covers 432 rules fewer. A published row of another tenant needs one row per node or per principal, and a create
    rule needs a grant before the row exists.
  - Its writers delegate without a bound too, so it is a new source class anyway, and the application keeps it in step.
  - An access view is that table without the materialization.
- **A SQL predicate per table and action in the policy.** It covers the same rules, but the guard would have to admit
  raw SQL in a scope. That means a new classifier for both dialects, a function allowlist and refusals of foreign
  schemas, and it contradicts "a condition is never SQL". An access view keeps the SQL where it already lives: in a
  migration the approver reads.
- **`admits`, a structured widening inside a tenant partition.** It covered one class and left out the cross-tenant
  branch on purpose.
- **A view read without a binding** (a public branch). The guard would have to admit an unanchored subquery. A view
  `cross join`ed with the dimension's table expresses the same rule with a `member` binding.
- **A set-returning function with parameters** (`access_for($me)`). SQLite has none, and a parameter list is a second
  channel for request values.
- **Locking the view's base rows on insert.** The data layer does not know which base rows the view read.
- **Access checks in handlers.** They exist today and need no change, but the approval diff does not show them as
  access.
