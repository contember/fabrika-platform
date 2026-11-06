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
  `{ action, scope: { type: '~rel', value: <relation> }, source: 'grant' }` for each of its relation actions. Scope
  types that start with `~` are reserved: a stored grant naming one grants nothing, and no key can freeze one. Every
  auth-core release in the window keeps the entry and reads it neither as a global grant nor as a scope value.
- **The data layer reads the relation on every statement.** A relation reaches a row's node while a source row names
  the caller there, is unexpired, and satisfies the relation's own `when`:
  `T.node in (select S.node from S where S.principal = $me and (S.expires is null or S.expires > $now) and <S.when>)`.
  A `Within` ORs this term with its IAM values. A `Ref` minted through a relation carries the same term on every
  statement, so a revocation takes effect at the next statement. Nothing caches it.
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
- `ctx.sql` on a writing site never names a source table, `unscoped` never writes one, and no seed helper reaches
  production.

The writer need not hold the actions the relation grants. That is the exception to S8, and this record names it: the
bound replaces "holds what it gives". An approver sees each `confers` and its `assign` as a widening in the approval
diff.

### 3. A condition only narrows

A table's `when: { <action>: <condition> }` is ANDed onto every grant of that action: global, IAM-scoped and relation
alike. A condition is structured data, never SQL: `eq`, `notEq`, `in`, `notIn`, `isNull`, `lt`, `lte`, `gt`, `gte`
over a column, with `allOf`, `anyOf` and `not`, `{ some: { <table>: … } }` and `none` over the rows whose foreign key
names the row, and `{ now: true }` as the statement clock. A condition's path follows at most three foreign keys, a
`some` counted as one. A hop's subquery reads its target unscoped, so a hop follows only a row's own container or parent
column, a foreign key that also holds every ancestor the two tables share and references the target's key, or a key
into a reference table; a `some` follows such a key backwards. An insert's condition is judged on the inserted row; one with
a path, on the written row in the insert's transaction, every row on its paths locked `FOR SHARE` first, and a refusal
fails the transaction. It takes no `some`. An upsert's conflict
update is judged on the stored row. A relation source's condition reads the source row only.

Widening is a separate mechanism (`admits`, a step of the [coverage roadmap](../ideas/acl-coverage-roadmap.md)), and
it is not part of `when`.

### 4. Relations are for internal principals, through a global grant

`via` is allowed only on a global, internal, non-membership role. IAM gives an external principal and a scoped grant
no relation entry. ADR-0051 is unchanged: a person from outside the organization does not hold a relation until a
later revision of this record says how. A relation held inside the node of a scoped grant (through-at-node) is a step
of the [coverage roadmap](../ideas/acl-coverage-roadmap.md).

### 5. A platform release publishes relation fields only to a framework that enforces them

Control refuses to publish an artifact that declares `relations`, `via`, `confers` or `when` to an application whose
pinned framework release predates their enforcement. A reader that ignores a narrowing field widens access, so this is
a refusal and not a warning. Every new field is absent from the artifact unless declared, so existing artifacts keep
their digests.

## Consequences

- An application expresses row-dependent access as data the approver reviews, instead of handler code. What the
  declarations do not express stays in handlers until a step of the coverage roadmap is built for it.
- Every statement under a relation carries one more subquery. Its cost is measured (#134) and needs the source index.
- The bounded delegation is a new kind of authority without a holder check. It must stay narrow: `assign` bounds,
  stamped nodes, immutable deciding columns and no source writes past the handles. Each of these is enforced in the
  data layer, not by convention.
- Control's approval diff grows a vocabulary: a new relation is neutral, a new `via` action or source table widens, a
  longer delegation or `self: true` widens, an added `when` narrows, a removed or changed `when` widens.
- **Rollout of an existing installation.** IAM migration `0029_role_via` adds a nullable `roles.via`. Every existing
  role reads as having none, and the next schema reconcile writes it for a role that declares it. An older IAM never
  reads the column and signs no `~rel`, so a relation grant fails closed until IAM is upgraded. No generated
  installation file, environment variable or provider state changes.

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
- **A view as a relation source.** A view's rows change with every write to its base tables, and the delegation bound
  sees none of those writes: nobody could bound who gains access, and an approver could not review it. An application
  that needs one writes its source rows through a real table with `assign`.
- **Raw SQL in a condition.** A structured condition is reviewable and checkable by the guard; SQL is neither.
- **A JSON column compared in a condition, or a path of more than three foreign keys.** The data layer never compares
  JSON, and each hop is a subquery in every statement of the action. An application extracts the value into a typed
  column, or shortens the path with a stored column.
