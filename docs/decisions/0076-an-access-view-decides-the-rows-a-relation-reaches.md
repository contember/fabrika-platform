---
id: 0076
title: An access view decides the rows a relation reaches
status: accepted
date: 2026-11-17
---

# 0076 — An access view decides the rows a relation reaches

## Context

[ADR-0073](0073-a-relation-grant-is-application-data-read-on-every-statement.md) makes relation grants application data:
source rows, reveals, secondary paths and structured conditions. Measured against a production rule corpus of an
existing application (4,409 conditional rules across five rule sets), these declarations express about 72 % of the
rules. The rest falls into a few large classes:

- **OR with a branch that names no variable.** "A member reads the modules of their company, and every published module
  of any company": the second branch crosses tenants.
- **A view as the source.** "Whoever holds an active, unrevoked grant reads the case", where "active" is a join with a
  clock. ADR-0073 bars a view as a relation source because the delegation bound cannot see its writes.
- **Several containers.** A row is reachable through its company and through a billing account, along paths that part
  below the row.
- **Conditions the structured form does not reach:** more than three foreign keys, a hop the hop rule refuses, or a
  principal compared through a path.

The coverage roadmap extended the declarations one class at a time. Each step was an ADR section, a parser, a guard
form and an approval-diff line. `admits`, a structured widening inside a tenant partition, would have covered one class
and deliberately left out the cross-tenant branch. Each step costs days and covers a few points. Real applications need
every rule, and what the declarations leave out would stay in handler code, which the approver does not see as access.

What makes a general escape path hard:

- **One enforcement decision** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). The escape path must be a
  scope the data layer writes, not a check in a handler.
- **The guard is an allowlist** over the statement tree. It never admits a raw SQL node in a scope, and a condition is
  structured data, never SQL (ADR-0073 section 3).
- **No request value reaches SQL text.**
- **Approved access** ([ADR-0050](0050-approved-access.md)). Whatever decides access shows in the approval diff.

## Decision

### 1. A table names an access view under a relation

A view of the application's schema ([ADR-0072](0072-a-view-is-a-read-only-table.md)) returns pairs of a row and whoever
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
published_modules: { scope: { access: 'which companies read a published module' } },
```

```sql
-- a migration
create view published_modules as
	select m.id as module_id, c.id as company_id
	from modules m cross join companies c
	where m.published_at <= now();
```

- **`row`** is the view's column that holds the table's key.
- **`principal`** is the view's column compared with the caller's principal.
- **`member`** is the view's column compared with the nodes the relation is held inside: the `~relin` entries of
  ADR-0073 section 4, for the relation's dimension.
- **At least one binding is required.** A view with neither would be read whole, and the parse refuses it.

The relation and its actions are ADR-0073's: the vocabulary declares the relation, and a role's `via` lists the actions
it holds through it. `access` only says how the relation reaches this table's rows. A relation may have source tables,
access views or both, and a table may name several access views, one per relation.

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
  - A view bound to `principal` alone reaches rows for either hold. A hold inside a node narrows its term to rows inside
    that node (ADR-0073 section 4).
  - A `member`-bound term is not narrowed to the node: the view maps the node to its rows, and that may reach rows of
    other tenants. That is the cross-tenant branch.
- **The values are the caller's.** `$me` and `<nodes>` come from the capability the framework minted. No other value
  enters the term.
- **The guard admits nothing new.** The term has the subquery shape the guard already admits for relation sources. The
  view joins the guard's allowlist by its table and its `row` column. The subquery counts toward the nesting bound of four
  as one level. The view's own SQL is the database's, and the guard does not walk it.

### 3. Every statement reads the view

- **A `Within` ORs the term** into its list, count and aggregate.
- **A `Ref` minted through the relation carries the term on every statement.** A change to the rows the view reads
  takes effect at the next statement, as a revocation of a source row does. `relates` answers through the same term.
- **An insert under such a `Ref`** checks its destination under the term, in the insert's transaction, before the write.
  The destination is either the table that owns the node, or the view's row for the node when no table owns it.
  - Unlike a source row, a view cannot be locked. A change to its base rows committed while the insert runs may let one
    insert through, as on Contember's READ COMMITTED.
  - The insert's own `when` is judged as ADR-0073 section 3 says.
- **These refuse a relation held only through an access view:**
  - a queue claim;
  - `ctx.sql.scope`, whose fragment renders column tests and would leave the term out;
  - a webhook binding, which outlives every statement (ADR-0073 section 1).
- **A view may be the target.** Its access term is ORed beside its parent subquery, and it serves reads only, like
  every view.

### 4. An access view is read only inside the term

An access view's policy is `{ scope: { access: '<what it decides>' } }`:

- It has no actions, and no store or handle of the data layer reads it.
- The parse refuses an access-scoped table that is not a view, an access view that no table's `access` names, and an
  `access` entry naming a table that is not access-scoped.

The view maps principals and nodes to rows. Read directly, it would show the caller who else reaches what.

### 5. The view's base tables are an access table without a bound

Whoever writes a row that the view reads changes who reaches the table's rows. ADR-0073 section 2 bounds the writer of a
relation source with `assign`, a stamped node and immutable columns. An access view has no such bound: its base tables
are written by their own writers, under their own policies.

This is the second named exception to S8, wider than the first. It holds because the view is database code the
approver reads, and the approver reviews the tables it reads and who writes them. The approval diff says so (section 6).

ADR-0073's bar on a view as a relation source stands. A source row is a grant held to a bound. An access view is a rule
the approver reads.

### 6. The approval diff and the artifact

- **The artifact carries `access`** on a table, and the `access` scope mode, only when declared, so an application
  without them keeps its digest.
  - An older data layer refuses the unknown field at parse and does not boot, so it fails closed.
  - A reader that ignores the field would reach less, not more, so ADR-0073 section 5's publish refusal does not count
    it.
  - The token, the manifest and IAM do not change: the term reads the `~rel` and `~relin` entries IAM already signs.
- **The approval diff shows each `access` entry** as a line naming the table, the relation, the view and its bindings.
  An added or changed entry widens, with closer review. A removed one narrows.
- **The view's SQL is the migration's database code**, which the diff already shows with closer review. Beside it, the
  diff names the relations the view decides, so the approver knows they are reading access.
- **`fabrika-check` reads `access` statically.** It checks that the named view is created as a view in the migrations
  and that it has the bound columns. It cannot check what the SQL selects.

## Consequences

- **Coverage.** Every rule of the corpus is expressible by the declarations or an access view, except 12. Those read
  other principals' memberships from IAM, which an application's database does not hold. This was measured by
  classifying each rule the declarations leave out, and five representative rules ran end to end on SQLite and
  Postgres. The coverage roadmap's remaining steps are not built.
- **A wrong view widens access, across tenants too:** a `cross join` without a filter, or a missing tenant join. The
  guard cannot see it. The safeguards:
  - the approval diff with closer review;
  - the application's tests;
  - the framework's skill, which shows how to test what a given principal reads.
- **Cost.** Each statement under the relation evaluates the view's subquery, and its cost is the view's. An application
  whose view is slow writes the access as a relation source table instead (ADR-0073 section 1), and pays the delegation
  bound for it.
- **Writers of the view's base tables delegate access without a bound** (section 5). An application that wants bounded
  delegation uses a relation source.
- **Rollout of an existing installation.** No generated installation file, environment variable, provider state or IAM
  migration changes. An application opts in by raising its pin and declaring `access`. One that declares none keeps its
  digest and its reach.

## Alternatives considered

- **A grant table the application maintains** (a relation source per rule, written by its handlers or triggers).
  - It covers about 432 rules fewer. A published row of another tenant needs one row per node or per principal.
  - A create rule needs a grant before the row exists.
  - Its writers delegate without a bound too, so it is a new source class anyway, and the application keeps it in
    step.
  - An access view is that table without the materialization.
- **A SQL predicate per table and action in the policy.** It covers the same rules, but the guard would have to admit
  raw SQL in a scope. That means a new classifier for both dialects, a function allowlist and foreign-schema refusals.
  It contradicts "a condition is never SQL". An access view keeps the SQL where it already lives: in a migration the
  approver reads.
- **`admits`, a structured widening inside a tenant partition.** It covered one class and left out the cross-tenant
  branch on purpose.
- **A view read without a binding** (a public branch). The guard would have to admit an unanchored subquery. A view
  `cross join`ed with the dimension's table expresses the same rule with a `member` binding.
- **A set-returning function with parameters** (`access_for($me)`). SQLite has none, and a parameter list is a second
  channel for request values.
- **Locking the view's base rows on insert.** The data layer does not know which base rows the view read. Contember
  does not lock them either.
- **Access checks in handlers.** These exist today and need no change, but the approval diff does not show them as
  access.
