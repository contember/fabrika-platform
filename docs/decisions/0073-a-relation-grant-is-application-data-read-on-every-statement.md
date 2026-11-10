---
id: 0073
title: A relation grant is application data, read on every statement
status: accepted
date: 2026-11-04
---

# 0073 — A relation grant is application data, read on every statement

## Context

Today a grant is IAM data. A role is held globally or at one scope value, and the data layer turns the token into a
list of values per dimension ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). Real access rules depend on
rows the application owns:

- "the people assigned to this project, until the assignment ends";
- "the assignee's coordinator";
- "only open projects";
- "an order's patient, read by whoever can read the order".

None of these is a list of values IAM can hold. Each is a fact in an application table that changes many times a day.

We measured this against a production rule corpus of an existing application: 4,409 conditional rules (a role, an
entity and an operation with at least one predicate) across five rule sets. Today's model expresses 31.4 % of them. The
spike in [#134](https://github.com/contember/fabrika-platform/pull/134) built relation grants and narrowing conditions
end to end. They express 50.9 % as the spike stands, and 59.2 % once the principal id is stored on the relation's row.
This record states the model. The steps that would extend it towards about 95 % are a frozen roadmap in
[ideas/acl-coverage-roadmap.md](../ideas/acl-coverage-roadmap.md): a step is built when an application needs it.

The forces:

- **One enforcement decision** (ADR-0022). The proxy decides which endpoint a caller may reach, and the data layer
  scopes every statement. A relation adds no second decision. It is part of the scope the data layer already writes.
- **IAM stays flat.** IAM knows principals, roles, grants and scope values. It does not know an application's rows,
  and a token minted for five minutes cannot carry facts that change in seconds.
- **Delegation (S8 of the [authorization model](../ideas/authorization-model.md)).** Today whoever gives access must
  hold it. A coordinator who assigns a colleague to a project typically does not hold what the assignment grants.
- **External principals** hold only roles declared external ([ADR-0051](0051-external-principals.md)).
- **Protocol stability** ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). Every new token
  entry, artifact field and manifest row must stay readable by every framework release in the support window. A
  release that does not read a narrowing field widens access.
- **Approved access** ([ADR-0050](0050-approved-access.md)). Every field that changes who reaches what shows in the
  approval diff, with its direction (widening or narrowing).

## Decision

### 1. Relations are application data, read on every statement

The vocabulary names each relation and its dimension. A table names the rows that grant it. A role names the actions
it holds through it.

```ts
// src/vocabulary.ts
relations: { member: { dimension: 'project' } },
roles: {
	assistant: { grants: [], via: { member: ['projects.read', 'projects.write'] } },
},

// src/db/tables.ts
project_members: {
	scope: { child: 'projects' },
	actions: { read: 'projects.read', insert: 'members.assign', delete: 'members.assign' },
	insert: ['principal_id', 'expires_at'],
	confers: { member: { principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 30 } } },
},
```

- **IAM carries only a marker.** A global grant of a role with `via` carries
  `{ action, scope: { type: '~rel', value: <relation> }, source: 'grant' }` for each of its relation actions; a grant
  at a node carries `~relin` instead (section 4). Scope types that start with `~` are reserved: a stored grant naming
  one grants nothing, and no key can freeze one. Every auth-core release in the window keeps either entry and reads it
  neither as a global grant nor as a scope value.
- **The data layer reads the relation on every statement.** A relation reaches a row's node while a source row names
  the caller there, is unexpired, and satisfies the relation's own `when`:
  `T.node in (select S.node from S where S.principal = $me and (S.expires is null or S.expires > $now) and <S.when>)`.
  A `Within` ORs this term with its IAM values. A `Ref` minted through a relation carries the same term on every
  statement, so a revocation takes effect at the next statement. Nothing caches it.
- **A webhook binding takes no such `Ref`.** A binding outlives every statement, and each later delivery acts on the
  bound node without the term. `ctx.webhooks(…).bind` takes only a `Ref` an IAM grant holds, and refuses one held
  through a relation, a member reveal or a secondary path.
- **The predicate is an uncorrelated subquery**, chosen by measurement in #134. A correlated `exists` costs 0.4–1.6 s
  per count on SQLite. Resolving ids first costs 50–78 ms of planning per statement on Postgres at 20,000 ids, and
  passes D1's 100-parameter limit. A source table needs an index on `(principal, node)`, and the checker requires one.

### 2. Writing a relation's source row is delegation, and the named exception to S8

**Invariant:** a row that confers a relation is written only through the data layer's handles, and each write is a
bounded delegation:

- The row's node is stamped from the writer's `Ref`, so a writer delegates only where it acts.
- `assign: { maxDays }` caps the expiry, and an open-ended expiry is refused under it.
- `assign.self` must be stated for a row that names its writer.
- No update writes the principal, the node, the expiry or a column the relation's `when` reads; a source row never
  moves; a queue table confers nothing.
- The relation's `when` may follow one foreign key of the source, under section 3's hop rule, to the row it names (the
  far side of a many-to-many source). That row is held like the source row: it is no view, no queue table and no
  top-level dimension row, whose key an insert takes from its Ref; no update writes the column tested, which is no
  version or containment column; and no foreign key carries a cascade into that column, the row's key or the source's
  key column.
- `ctx.sql` on a writing site never names a source table or a table its principal path or its `when` reads, `unscoped`
  never writes a source table, and no seed helper reaches production.
- Access tables are written only by the platform: the migration classifier refuses a function or procedure body or a
  rule action that writes one of those tables or a member-revealing table (`accessTables` of `@fabrika/db/tables`), or
  a view over one, a `BEFORE` or `INSTEAD OF` trigger or a rule on either, and a rename of another relation to
  either's name, in Control's snapshot read and in `fabrika-check`. A backfill in a migration still writes them; it
  runs once, inside the migration.

The writer need not hold the actions the relation grants. That is the exception to S8, and this record names it: the
bound replaces "holds what it gives". An approver sees each `confers` and its `assign` as a widening in the approval
diff.

### 3. A condition only narrows

A table's `when: { <action>: <condition> }` is ANDed onto every grant of that action: global, IAM-scoped and relation
alike. A condition is structured data, never SQL: `eq`, `notEq`, `in`, `notIn`, `isNull`, `lt`, `lte`, `gt`, `gte`
over a column, with `allOf`, `anyOf` and `not`, `{ some: { <table>: … } }` and `none` over the rows whose foreign key
names the row, and `{ now: true }` as the statement clock. A path may end in `some` or `none`
(`{ '<fk column>': { some: … } }`): the rows naming the row the path reaches. A foreign key that is null reaches no row,
so neither form holds there. A `not`, in any condition and at any depth, follows a path only through columns the column
list declares NOT NULL: a hop's subquery reads its target unscoped, so on a null key it is false while no row anywhere
matches and unknown otherwise, and under `not` the row would turn on other tenants' rows. A reference table's key is no
exception, and neither is a child view's parent column: `ctx.db.app` reads a view's rows without the parent subquery,
and codegen marks every view column nullable, so a view's `when` takes no `not` over a path. A `some` nests in a `some`, and a `some` through a link table is a `some` of the link
rows followed by a path from them. A condition's path follows at most three foreign keys, the path before a `some`,
the `some` and every hop inside it counted together. A hop's subquery reads its target unscoped, so a hop follows only
a row's own container or parent column, a foreign key that also holds every ancestor the two tables share and
references the target's key, or a key into a reference table; a `some` follows such a key backwards, but never one into
a reference table, whose row every tenant's rows name: it reads only rows of the named row's own tenant. Each form is the
one subquery shape `T.<column> in (select X.<column> from X where …)`, so the guard admits it by its table and column,
nested at most four deep under a reveal. A child view's parent column is such a hop, though no foreign key declares it
([ADR-0072](0072-a-view-is-a-read-only-table.md)). An insert's condition is judged on the inserted row; one with a path,
on the written row in the insert's transaction, every row on its paths locked `FOR SHARE` first, and a refusal fails
the transaction. A `some` there reads rows that existed before the insert: it follows a path first, takes no `some` of
the inserted table's rows at any depth (judged after the write, one would count the inserted row itself), and every row naming
the row the path reached is locked too, so a row inserted meanwhile can only make it truer. It takes no `none`, no
`some` under `not` and no `some` of the rows naming the inserted row: a row inserted before the commit could turn the
first two false, which no lock holds, and no row names the third yet. An upsert's conflict update is judged on the
stored row. A relation source's condition reads the source row and at most the one row its foreign key names
(section 2), so under a reveal matched through a path it stays within four subqueries. It takes no `some`: rows naming
a source row are written by their own table's writers, outside the delegation bound.

Widening is a separate mechanism (`admits`, a step of the [coverage roadmap](../ideas/acl-coverage-roadmap.md)), and
it is not part of `when`.

### 4. Relations are for internal principals, anywhere or inside the grant's node

`via` is allowed on an internal role, application-wide or membership, and never on an external one. ADR-0051 is
unchanged: IAM gives an external principal no relation entry. A global grant of the role holds its relations anywhere
(`~rel`). A grant at a node, a scoped grant or a membership role in the value it is held in, holds them only inside
that node: it carries `{ action, scope: { type: '~relin', value: '<relation>:<dimension>:<node>' }, source: 'grant' }`
for each relation action, and never `~rel`.

- **The value is parsed from the left.** A relation and a dimension name hold no `:` (the build and IAM's schema refuse
  one), so the relation ends at the first `:` and the dimension at the second; the node is the rest, verbatim, and may
  hold `:`. IAM gives no entry for a name that holds one.
- **Inside is strict.** The data layer narrows each term of the relation, its reveals and its secondary paths, to rows
  whose own column for the grant's dimension names the node: `(<term> and (T.<column> in (<nodes>)))`. A table with no
  column for that dimension gets no term from the entry, and neither does a reveal to a dimension above the node: its
  rows lie at the node's ancestor, not inside the node. The framework counts an entry only where the relation's
  dimension, and a reveal's, is the grant's dimension or lies inside it; `on` and `in` ask the database for the object
  row with that comparison, never comparing a node themselves, and a `Ref` carries the node as the object's column
  stores it, so every spelling the database equates (a `uuid` in either case) is one node for `on`, `in` and `over`.
- **A membership role's relation lies inside its value.** Each relation of its `via` has the role's own dimension or one
  inside it; the build refuses any other.
- **Assigning the role is held to a plain grant.** IAM gives a membership role with `via` only to an assigner that holds
  every action of the role at the node, its relation actions included, through a grant: `permits` reads no `~` entry,
  so an action held through a relation does not count.
- **An older reader fails closed.** An older auth-core keeps the entry, and the proxy's requirement counts it as it
  counts `~rel`. The scope type names no dimension, so no release reads it as a value or a global grant, and a
  framework before `0.9.0-dev.14` reads only `~rel`, so the entry holds nothing there.

Scoped grants of a role with `via` that exist before the IAM upgrade carry `~relin` after it, with no artifact change:
their reach grows from nothing to the relation's rows inside their node. The owner accepted this widening; the
framework migration guide says so.

### 5. A platform release publishes relation fields only to a framework that enforces them

Control refuses to publish an artifact that declares `relations`, `via`, `confers` or `when` to an application whose
pinned framework release predates their enforcement, and one that declares `relationWhen` (section 10) to an application
pinned before the release that enforces it. A reader that ignores a narrowing field widens access, so this is a refusal
and not a warning. Every new field is absent from the artifact unless declared, so existing artifacts keep their
digests.

Each floor is a release compared by prerelease precedence, and names the first release whose source enforces its
fields. The source version names the last release cut, so a field that lands between releases takes the next
prerelease after it as its floor (`relationWhen`: `0.9.0-dev.14`). A test holds every floor at or below the source
version, or at that next prerelease, so a bump that cuts the enforcing release under another name fails it.

### 6. A read path may start at the row's container

`readThrough: { <dimension>: <column> }` reads a row through a foreign key of its own to the table that owns a
dimension outside the row's chain. When that key lives on the row's nearest container instead, the row names the
container's path: `readThrough: { team: 'task_id.team_id' }` on a task's comments, read by the team the task names. The
term reads the container at every statement: `T.<link> in (select C.<key> from C where C.<column> in (<nodes>))`.

- `<link>` is the row's nearest containment column, which places it now, so a move takes the read along.
- The container declares the same path through a column of its own, which no update writes. One container deep: a
  path through the container's own container is refused.
- The guard admits the one extra subquery by the container's table and key, the way it admits a chain link.
- The container's own `when` is not applied: the subquery tests the container's path column only, as a child view's
  parent subquery leaves the parent's `when` out ([ADR-0072](0072-a-view-is-a-read-only-table.md)). The row's own
  `when` narrows it; a row that must follow its container's condition states that condition on a path of its own.
- A reveal is not matched through such a path. A relation above the dimension, under its source's condition, would
  read the revealing row, the container, the path's table, the source and the far row: five subqueries, past the
  guard's bound of four. The reveal is declared on the container instead.

Nothing is stamped on the row, so no write keeps a copy in step (see Alternatives). An older framework refuses the
dotted path at parse, so the form fails closed; the approval diff shows a new or changed path as a widening.

### 7. A member reveal holds a Ref and the actions it lists

`memberReveals: { <its own dimension>: { to, actions, when? } }` on a dimension table makes a grant of a listed action
at a row's own node hold that action at the row's ancestor in `to`, while the reveal's `when` admits the row: a task's
members read and write its project. A grant at a container of the row does not count, and the layer generates the row's
key, so no writer picks a node someone already holds a grant at.

- **A `Within` reads through it.** The term is `T.<to column> in (select R.<column> from R where R.<key> in (<values>)
  and <R.when>)`, ORed with the `Within`'s other values.
- **`on` and `in` mint a `Ref` through it**, for every action the reveal lists, writes included. The `Ref` carries the
  caller's grants at the revealing dimension, not the rows they matched, and every statement of the `Ref` requires the
  member term again, ORed with the relation terms it is held through. A row closed or deleted ends its reach at the
  next statement, as a relation row does (section 1).
- **An insert under such a `Ref` is rechecked under lock**, as a relation `Ref`'s is: into a node a table owns, the
  destination row is locked `FOR SHARE` under the term; into a node no table owns, the revealing row is locked
  `FOR SHARE` before the write, and an insert with none left is a 404.
- **A member-revealing table delegates**: it is never written unscoped or by `ctx.sql`, its rows never move, and its key
  is the layer's. A row that moved or was revived under an old key would hand its members another node.
- **`ctx.sql.scope` refuses such a `Ref`**: the fragment renders column tests and would leave the term out.

The declaration is unchanged, so the artifact and its digest are too. A framework release that reads the declaration
only for a `Within` mints no such `Ref`, which fails closed. Raising the pin to one that mints them widens an existing
declaration to `Ref`s and to the write actions it lists, with no artifact diff: the approver reviewed the declaration
with the actions it lists. `0.9.0-dev.13` read it for a `Within` only, so an application approved on it gains the
write actions it lists when it raises its pin; the framework migration guide says so.

### 8. A write path holds a Ref, and bounds its column's writer

`writeThrough: { <dimension>: [<actions>] }` beside a table's `readThrough` makes that path hold the listed actions, writes
included: a grant of a listed action at the node the column names or at a container of it, or a relation there, gets a
`Ref` of the row from `on` and `in`. A reveal matched through the path holds a `Ref` of its ancestor for the actions both
the reveal and `writeThrough` list. A path, or an action, it does not list holds reads only, as before.

- **Every statement of such a `Ref` requires the path term again**: the `Ref` carries the grants that matched at the
  path's dimension and its containers (`RefGrant.paths`) and the relations held there, not the rows. The column never
  changes (section 6), but a container's column, a node's place and a relation row do, and the next statement reads them
  as they stand.
- **The column's writer must hold what the path hands out.** An insert that names a node in the column needs its writer
  to hold there every action the path lists, and every action listed by a table whose container path (section 6) reads
  through this column. It is judged in the insert's transaction, before the insert: the node's row is locked
  `FOR SHARE`, so it stays where it lies until the commit; each action is held by the request's grant at the node or at
  a container on the chain that row gives, or else by a relation or revealing row, which is locked `FOR SHARE` too. A
  writer outside the bound, and work with no request caller (a job, a webhook), get a `ConflictError` (409), and nothing
  is written. A null column names no node and is not checked. Judged before the insert, the bound never counts the
  inserted row.
- **This keeps S8.** Unlike a relation's source (section 2), the writer hands out only what it holds, so the bound needs
  no exception. A reveal on the same path keeps its own `assign`: a writer that holds the reveal's relation at the node,
  and so passes this bound through it, names that node only under `assign.self`.
- **Rows written before `writeThrough` was declared keep the node they name.** No update writes the column, so the
  bound covers each row written after the declaration for its whole life. The approval diff says so.
- **A move follows containment only.** A `Ref` held through a path never moves a row, from or to. A move rewrites the
  containment column, and a path `Ref` holds nothing there: bounding it would need the mover to hold the destination's
  actions in its containment, which is a containment `Ref` of the destination. A containment `Ref` may move a row of a
  table with a write path, because the move leaves the path column alone. A row read through its container's path
  follows its new container's column, and that container's insert bounded the column's writer for this row's actions.
- **A writing `Within` does not arise.** A `Within` writes only through a queue claim and `ctx.sql`; a queue table takes
  no secondary path, and `ctx.sql` never writes a table with a write path. A `Within` reads through every path, as before.
- **The bound has no way around it.** A table whose path hands out an action, or whose column a container path reads,
  is never written unscoped or by `ctx.sql`, and `ctx.sql.scope` refuses a `Ref` held through a path: the fragment
  renders column tests and would leave the path term out.
- **The guard admits one more member.** A `Ref`'s statement is its chain's equalities and a parenthesized `OR` that may
  now hold a scope membership (`T.<column> in (<values>)`, or the container form) beside relation memberships. The
  nesting bound stays four: the deepest is a reveal matched through a path below the relation's dimension, under the
  source's condition on the row it names.

`writeThrough` is absent from the artifact unless declared, so an artifact without it keeps its digest. A reader that
ignores it holds the path for reads only, which reaches less, so section 5's publish refusal does not count it. An
older data layer refuses the unknown field at parse, so an older framework fails closed. The approval diff shows each
added action as a widening and each removed one as a narrowing.

### 9. A member reveal may follow a secondary path

`memberReveals` may be keyed by a dimension the table reads through a direct path (section 6): a grant of a listed
action at the node the row's column names holds that action at the row's nearest container, while the reveal's `when`
admits the row. The members of the team a task names read its project. A link row, a child of the to-many row that
names the team, reveals its parent the same way: the members of every team linked to a task read the task.

- **The writer picks the node, bounded by `assign`**, as for a reveal through a path (section 2). An insertable table
  states `assign: { self? }`, and one without an insert action takes none. Without `self`, an insert is refused with a
  409 while its writer holds a grant the reveal counts at the node the column names: one of the listed actions, at that
  node itself. The grants are the request's own standing (section 8), compared with the node's key by the database in
  the insert's transaction before the insert, so every spelling of one key is that node and the inserted row never
  counts. Work with no request caller has no grants to judge and is refused. A grant
  above the node, or everywhere, is no membership (section 7), so it gains nothing through the reveal and is not counted.
- **It reveals the row's nearest container only.** A move of an ancestor rewrites the column above it, and no bound
  sees that move. The row itself never moves, since it delegates (section 7).
- **It takes no container's path.** A row read through its container's column declares the reveal on the container.
- **A `Ref` holds an action through it only where the path does** (`writeThrough`, section 8); otherwise it serves a
  `Within`'s reads only. An action both list must also be held at the node (section 8): a writer that holds it by a
  grant at the node is a member and needs `self`, and one that holds it at a container or through a relation does not.
- **Every grant matched is carried.** Through a path many rows name one grant's node, so the minting binding reads
  the matched grants grouped, never only the first row.
- **The guard admits nothing new.** The term is section 7's: `T.<to column> in (select R.<to column> from R where
  R.<path column> in (<values>) and <R.when>)`. The subquery reads R unscoped, over a tenant-holding key, so a null
  column names no node and no negation reads other tenants' rows.

The new key and its `assign` are absent unless declared, so existing artifacts keep their digests. A release that reads
member reveals by the row's own key only refuses another key at parse, so it fails closed. A release before member
reveals ignores them and reaches less. Neither widens, so section 5's publish refusal does not count them. The approval
diff names the path and shows `assign` as it shows a reveal's.

### 10. A condition on one relation

`relationWhen: { <relation>: { <action>: <condition> } }` on a table narrows what that relation reaches of the table for
that action, and nothing else: a caller reads every task of a project an IAM grant holds, and through the `member`
relation only the open ones. It is table-side because the condition reads the table's columns, which the vocabulary
does not know. The condition is section 3's, with every rule of it, and it is ANDed onto each term of that relation for
that action: the direct term, a reveal matched for the relation, and the relation's term through a secondary path, as
`(<term> and (<condition>))`. IAM values, member reveals and global grants are not narrowed; the table's own `when`
still narrows every grant.

- **The parse refuses what reaches nothing.** The relation is one the vocabulary declares, the action one the table
  names, and the relation reaches the table for the action: its dimension is in the table's chain, a secondary path
  reads it, or a reveal of the relation for that action names a node the row lies at. A view is judged against its
  parent. An application or reference table takes none.
- **The nesting bound holds.** The condition stands beside the term, not inside its subquery, so its paths count as a
  `when`'s do: at most three foreign keys, and the deepest term stays the four of section 3.
- **A `Ref` minted through the relation carries it.** Every statement's gate ORs the `Ref`'s parts (section 8), and the
  relation's part is its narrowed term, so a row the condition does not admit is out on every statement.
- **An insert is judged on the written row**, as `when`'s. A relation whose condition has no path and fails on the row
  is dropped before the write; one with a path is judged after it, in the insert's transaction, with the rows on its
  paths locked first. What holds the destination without the path-narrowed relations (and, with several, each of them
  alone) is decided before the write, so the written row never holds its own insert: a row that fails one stands only
  on what held the destination before it. Otherwise the insert is a 409 and the transaction fails.
- **A path writer's bound does not count a narrowed relation.** A writer that holds an action at the node only through
  a relation narrowed for that action is not counted as holding it (section 8): the bound reads no row condition.
- **A child view's parent subquery leaves the parent's `relationWhen` out**, as it leaves the parent's `when` out. The
  view may declare its own: the parent subquery is then split into the rest and one part per narrowed relation, each
  ANDed with the view's condition, and the guard admits that union.

It narrows, so a release that ignores it widens: section 5 refuses to publish it to an application pinned below
`0.9.0-dev.14`. The approval diff shows one line per relation and action, as it shows `when`: an added condition
narrows, a removed or changed one widens.

## Consequences

- An application expresses row-dependent access as data the approver reviews, instead of handler code. What the
  declarations do not express stays in handlers until a step of the coverage roadmap is built for it.
- Every statement under a relation carries one more subquery. Its cost is measured (#134) and needs the source index.
- The bounded delegation is a new kind of authority without a holder check. It must stay narrow: `assign` bounds,
  stamped nodes, immutable deciding columns and no source writes past the handles. Each of these is enforced in the
  data layer, not by convention.
- Control's approval diff grows a vocabulary: a new relation is neutral, a new `via` action or source table widens, a
  longer delegation or `self: true` widens, an action a write path holds widens, an added `when` or `relationWhen`
  narrows, a removed or changed one widens.
- **Rollout of an existing installation.** IAM migration `0029_role_via` adds a nullable `roles.via`. Every existing
  role reads as having none, and the next schema reconcile writes it for a role that declares it. An older IAM never
  reads the column and signs no `~rel`, so a relation grant fails closed until IAM is upgraded. IAM migration
  `0030_membership_role_via` lets a membership role carry `via`; after it, IAM signs `~relin` for every scoped grant of
  a role with `via` (section 4). No generated installation file, environment variable or provider state changes.

## Alternatives considered

- **Relations in IAM** (a grant per assignment, a scope value per project). This would put an application's rows into
  IAM, and every assignment would become a grant write and a re-mint. It would also mean token growth and the 24 KiB
  limit: an assistant on 2,000 projects carries 2,000 values. It loses on freshness, size and ownership.
- **Ids resolved into the statement** (`in ($1 … $n)` or `= any($1)`). This is planning-bound at high fan-out, and past
  100 parameters it cannot run on D1. It wins two cases (Postgres counts at low fan-out, a first page at fan-out 300),
  which a later per-statement choice can take.
- **A correlated `exists`.** Unusable for counts on SQLite. It wins single-row reads at high fan-out, which a later
  per-operation choice can take.
- **Source writes held to S8** (the writer must hold what the relation grants). A coordinator who assigns does not
  hold the assistant's actions. Every realistic application would then grant the coordinator those actions, which is wider
  than the bound.
- **`admits` together with `when`, or raw SQL in it.** Widening without a tenant partition lets a grant in one company
  reach published rows of another. Raw SQL is the opposite of what a reviewable widening needs. `admits` is a step of
  the coverage roadmap and takes its own ADR.
- **A stamped copy of the container's path column on the row**, for a read path that starts at the row's container.
  It reads one subquery shallower and would let a reveal match through it. But every insert, every move of the row and
  every write of the container's column would have to rewrite the copy on every row below, in the same transaction, or
  a row would stay readable by a team its container left. The container term reads the column where it lives, at every
  statement, and needs nothing kept in step (section 6).
- **A path column written as a `Ref`** (the writer passes a `Ref` of the node it names). A `Ref` holds one action, and the
  path hands out several, including those a container path reads through the column; the writer's standing checks
  them all in one place.
- **A move through a path, bounded by the path.** The moved row's path column satisfies the path term wherever the row
  lands, so the destination check bounds nothing; holding the destination's containment actions is a containment `Ref`.
- **A view as a relation source.** A view's rows change with every write to its base tables, and the delegation bound
  sees none of those writes: nobody could bound who gains access, and an approver could not review it. An application
  that needs one writes its source rows through a real table with `assign`.
- **Raw SQL in a condition.** A structured condition is reviewable and checkable by the guard; SQL is neither.
- **A JSON column compared in a condition, or a path of more than three foreign keys.** The data layer never compares
  JSON, and each hop is a subquery in every statement of the action. An application extracts the value into a typed
  column, or shortens the path with a stored column.
