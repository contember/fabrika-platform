---
id: 0074
title: A condition widens a read only inside a tenant partition
status: accepted
date: 2026-11-10
---

# 0074 — A condition widens a read only inside a tenant partition

## Context

[ADR-0073](0073-a-relation-grant-is-application-data-read-on-every-statement.md) gives access through rows of the
application: a relation reaches the rows of the nodes its source rows name, and a condition (`when`, `relationWhen`)
only narrows. Many real rules are an OR instead: "the tasks of my projects, and every public task of my organization".
The second half is a condition on the row, not a relation, and nothing in ADR-0073 can express it, because a condition
there never adds a row.

A widening condition is dangerous in two ways:

- **It crosses tenants.** "Every public task" with no boundary is every public task of every organization. Whoever
  holds the action anywhere would read another company's published rows.
- **It outruns delegation.** ADR-0073's source writer delegates only where it acts (S8's named exception). A widening
  that follows the delegated rows would hand out whatever the condition admits, wherever it admits it.

The forces:

- **Enforcement stays in the data layer** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). The token
  carries no row facts, so the widening is a predicate in the statement, as a relation is.
- **Conditions are structured data, never SQL** (ADR-0073 §3). A reviewer must be able to read the widening in the
  approval diff ([ADR-0050](0050-approved-access.md)).
- **The protocol must not break** ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). A new
  artifact field must keep every existing digest, and a release that does not know the field must not widen access.

## Decision

### 1. A partition is a top-level dimension that says so

```ts
// src/vocabulary.ts
dimensions: {
	org: { partition: true },
	project: { in: 'org' },
	task: { in: 'project' },
},
relations: { member: { dimension: 'project' } },
roles: {
	colleague: { grants: [], member: { scope: 'org', assignableBy: ['owner'] }, via: { member: ['tasks.read'] } },
},

// src/db/tables.ts
tasks: {
	scope: { dimension: 'task' },
	actions: { read: 'tasks.read', update: 'tasks.write' },
	admits: { 'tasks.read': { visibility: { eq: 'public' } } },
},
```

- **`partition: true` is one reviewed fact**: "an organization is a tenant". It is `true` or absent, and only on a
  top-level dimension; the build and the data layer's parse refuse it anywhere else.
- **Top-level only, so the existing hop rule is enough.** Containment is a tree. Two tables that share any ancestor
  share its root, and a hop that holds the tenant holds every shared ancestor (ADR-0073 §3). So every path a condition
  may follow stays in the row's own partition node, or reads a reference table. A nested partition would need a hop rule
  of its own; it is not built.
- **A table takes `admits` only inside a partition.** It must be a dimension or child table whose chain ends in a
  partition dimension (or that is the partition's own table). The partition column is the table's own column for that
  dimension: the stamped chain column, or the key of the partition's own table. An application, reference or view table
  takes no `admits`, and a table whose root is no partition is refused with a message that names the dimension to
  declare.

### 2. `admits` widens a `Within`'s read, and nothing else

`admits: { <read action>: <condition> }` adds, for a `Within` of that action, the rows that meet the condition in the
partition nodes where the caller holds the action through a relation:

```sql
where ( tasks.project_id in (select m.project_id from project_members m where m.principal_id = $me and …)
     or (tasks.org_id in ($o1) and (tasks.visibility = $public)) )
  and (<tasks.when['tasks.read']>)
```

- **The condition is section 3 of ADR-0073 with every rule.** The same root, hop rule, three-hop bound, `not` over
  NOT NULL columns only, and no JSON column. It is never SQL. An action that is not one of the table's read actions is
  refused.
- **`when` still narrows everything.** The table's `when` for the action is ANDed over the whole reach, the admitted
  rows included. `relationWhen` narrows relation terms only, and an admitted row is no relation term.
- **The partition test is SQL.** The token's node strings are bound values compared with the row's stored partition
  column, so a `uuid` spelled in another case is the node the database equates with it. A null partition column admits
  nothing.
- **Reads only.** A `Within`'s list, count and aggregate read the admitted rows. A queue claim asks for the update
  action, so it never claims one. No insert, update, delete or move is judged by `admits`: an inserted row can never
  count for its own insert, and a move is not opened into a target.
- **No `Ref`.** `on` and `in` mint nothing through `admits`, and no `Ref`'s gate carries it, so no webhook binding can
  take its reach. A row that only `admits` reaches is 404 to `on` and 403 to `in`.
- **`ctx.sql.scope` refuses** a `Within` that carries partition nodes for a table that admits rows for the action, and
  names `ctx.db`. Rendering without the term would be safe, but a `ctx.sql` list would then disagree with
  `ctx.db.within`.
- **Views take none.** A child view's parent subquery leaves the parent's `admits` out, as it leaves out the parent's
  `when` and `relationWhen`, so a view reaches less and fails closed. A view declares no `admits` of its own.
- **`ctx.db.app` is unchanged.** It reads with a global grant, which already reaches every row.
- **The partition nodes count towards `MAX_WITHIN_VALUES`**, with the `Within`'s other values.

### 3. Only a `~relin` at the partition node counts

The partition nodes are the values of the caller's `~relin` entries for the action whose dimension is a partition, for
a relation the contract declares: a membership role or scoped grant with `via`, held at the organization, as
`colleague` above. They come from the token; the framework reads no row and compares no node to find them.

- **Why this source keeps S8.** IAM gives a membership role with `via` at a node only to an assigner who holds every
  action of the role there through a plain grant (ADR-0073 §4). That assigner already reads every row of the
  partition, so the admitted rows lie within what it holds.
- **A `~rel` entry never counts.** It names no partition, and counting it would admit every tenant's rows. Placing it by
  its source rows' partitions would be a data read, one more level of nesting, and a source writer (the S8 exception)
  would then hand out the organization's admitted rows, not only the node it stamps.
- **An external principal admits nothing.** IAM signs no `~rel` or `~relin` for one (ADR-0051, ADR-0073 §4), so it has
  no partition node. No other check is needed.
- **What this leaves out.** An IAM grant of the action at the partition node or globally already reaches every row of
  the partition through containment, so it adds nothing. An IAM grant, or a `~relin`, at a node inside the partition (a
  project role) admits nothing. Counting one would need a subquery that maps the node to its partition, and would break
  S8: whoever assigns a project role holds its actions in that project only, yet the holder would gain the
  organization's admitted rows. That is the first extension, when an application needs it; it is not built.

### 4. A list may show a row its detail endpoint refuses

An admitted row is listed by an `over` endpoint, but `on` and `in` do not reach it: a public task appears in the list,
and its `on: 'task'` endpoint answers 404. An application reads such a row's detail through an `over` endpoint (a list
filtered by key). A read-only `Ref` through `admits` would close the gap. It would need a binding the database answers
(as `holdsThrough` answers a relation), a gate term on every statement, and refusals in the webhook binding and in
`ctx.sql.scope`. It is not built.

### 5. The guard admits the term only on a read

The guard admits a narrowed value membership, `(T.<column> in ($…) and (<condition>))`, only when the statement's
context names the column as the table's partition column (`GuardContext.admitting`), only on a select, and only without
a lock. Only a `Within`'s list, count and aggregate set that context. Every write, every lock, a `Ref`'s read, a
write's read of its row, an update that changes nothing, another column, and a table without `admits` are refused. As for `relationWhen`, the
guard checks the condition's shape, not that it equals the declared one.

### 6. The protocol and the approval diff

- **The artifact mirrors the source.** A table policy carries `admits` and a dimension carries `partition: true`, each
  only when declared, so every existing artifact keeps its digest. The IAM schema does not carry `partition`.
- **No token change and no IAM migration.** `admits` reads the `~relin` entries IAM already signs.
- **No publish floor.** ADR-0073 §5 refuses to publish a narrowing field to a framework that ignores it. `admits` widens,
  so an older framework that ignored it would only reach less. In fact an older data layer refuses the unknown policy
  field and the application does not boot: it fails closed.
- **The approval diff** shows one line per table and action. An added `admits` widens; a removed one narrows; a changed
  condition widens, since a change can go either way and the diff does not prove a narrowing. A dimension's `partition`
  flag is a neutral line: the parse refuses `admits` without it, so every effect shows on the table lines.

## Consequences

- An application states "my projects' tasks, and every public task of my organization" as policy data the approver
  reads, instead of handler code with its own tenant check.
- The widening has a hard boundary that no condition can cross: the row's own partition column, compared in SQL with
  nodes the caller holds at the partition, through a role whose assigner already holds them.
- Detail endpoints lag behind lists (section 4) until a read-only `Ref` through `admits` is built.
- A project-level role widens nothing (section 3). An application whose rule is "a project member also reads the
  organization's public tasks" needs the first extension.
- **Rollout of an existing installation.** No generated installation file, environment variable or provider state
  changes, and IAM has no migration. An installation converges by upgrading. An application opts in by raising its pin
  and declaring `partition` and `admits`; the approver sees the widening. An application that declares neither keeps its
  digest and its reach.

## Alternatives considered

- **No partition flag; the root of the table's chain is implied.** Smaller, but nothing tells the approver that the root
  is a tenant boundary, and a vocabulary without a tenant dimension would widen across the whole application.
- **A partition per entry** (`admits: { <action>: { within: 'org', when } }`). It needs no vocabulary change, but the
  boundary is repeated per table and can differ between tables of one application.
- **A partition at any depth.** Every hop into a table at or inside the partition would also have to map the partition
  column, or a sibling project's row could decide whether a task of mine is admitted; and partitions could nest. Neither
  is needed while the tenant is a top-level dimension.
- **Every holder of the action at or inside the partition** (section 3). This breaks S8, as stated there, and adds a
  subquery per term.
- **`admits` on writes.** An insert would have to be judged before the write, with the partition row locked, and the
  update and delete gates would carry the term. No rule needs it yet, and without it no inserted row can count for its
  own insert and no move needs a new judgement.
- **Raw SQL in the condition.** A reviewable widening needs a form the approval diff can read and the guard can check;
  raw SQL is neither.
