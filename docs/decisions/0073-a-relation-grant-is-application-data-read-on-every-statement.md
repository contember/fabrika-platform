---
id: 0073
title: A relation grant is application data, read on every statement
status: proposed
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
The rest of this record states the model and the road to about 95 %.

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
over a column, with `allOf`, `anyOf` and `not`, and `{ now: true }` as the statement clock. A condition's path follows
at most three foreign keys. A hop's subquery reads its target unscoped, so a path follows only a row's own container
or parent column, or ends in a reference table. An insert's condition is judged on the inserted row, and an upsert's
conflict update on the stored row.

Widening is a separate mechanism (`admits`, step 12 below), and it is not part of `when`.

### 4. Relations are for internal principals, through a global grant

`via` is allowed only on a global, internal, non-membership role. IAM gives an external principal and a scoped grant
no relation entry. ADR-0051 is unchanged: a person from outside the organization does not hold a relation until a
later revision of this record says how. A relation held inside the node of a scoped grant (through-at-node) is step 11
below.

### 5. A platform release publishes relation fields only to a framework that enforces them

Control refuses to publish an artifact that declares `relations`, `via`, `confers` or `when` to an application whose
pinned framework release predates their enforcement. A reader that ignores a narrowing field widens access, so this is
a refusal and not a warning. Every new field is absent from the artifact unless declared, so existing artifacts keep
their digests.

## Coverage roadmap

The method:

- **L2**, a local translator of the corpus, turns each rule into `relations`, `confers`, `via` and `when`. It keeps
  AND, OR, NOT, an EXISTS per to-many hop and three-valued null logic. It counts a rule only when the real `readTables`
  parser accepts the world it builds. A semantic replay (L3) checks a sample of the covered rules against seeded rows.
- For each uncovered rule, a structural walk records every gap class it contains, not only the first.
- A step's projection counts the rules whose every gap that step or an earlier one closes. The projection is an upper
  bound: each step is re-measured with L2 once it is built.

| #  | Step                                                   | Gap class (rules with it / rules where it is the only gap)                                  | Approach                                                                                                                                                                                                                                                                                                                                                                                            | Size  | Conditional rules after the step |
| -- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------- |
| 0  | The spike (#134)                                       | —                                                                                           | as decided above                                                                                                                                                                                                                                                                                                                                                                                    | built | **50.9 %** measured              |
| 1  | The principal reached through a to-one path            | principal through a foreign key (364 covered rules need it)                                 | `confers.principal` takes a to-one path such as `person_id.principal_id`, into a table whose path columns no update writes. Or the port stores the principal id on the source row.                                                                                                                                                                                                                  | M     | **59.2 %** measured              |
| 2  | P3 `reveals`                                           | a reach two to-many hops deep (721 / 322)                                                   | A table declares `reveals: { <its action>: <container action> }`. Holding an action on a contained row yields a lesser action on its container, and from there on the container's other contained tables. The term nests the contained table's own reach: `node in (select c.parent from c where <c's reach>)`. The endpoint requirement gains `revealedBy`, an additive manifest field (ADR-0062). | L     | 66.5 %                           |
| 3  | P3 over a scoped membership                            | a membership variable through a to-many hop (350 / 179)                                     | On step 2: a contained row in a scope value the caller is a member of reveals its container.                                                                                                                                                                                                                                                                                                        | S     | 70.8 %                           |
| 4  | Relations and conditions on view tables                | a rule on a view (518 / 333)                                                                | On [ADR-0072](https://github.com/contember/fabrika-platform/pull/137): a view with a declared parent takes `when` and reveals, and a condition follows the view's declared parent column. Includes the view's scope through its parent row.                                                                                                                                                         | M     | 79.5 %                           |
| 5  | A path into a scoped table that shares the row's chain | a path out of the row's containment (74 / 60; 58 were lost to the review-round confinement) | The hop's subquery also matches the target's top containment column to the row's own, so it stays inside the row's tenant.                                                                                                                                                                                                                                                                          | S     | 81.0 %                           |
| 6  | A condition across a to-many hop                       | `exists child where …` in a condition (199 / 65)                                            | `{ some: { <child table>: <condition> } }` and `none`, a subquery anchored on the row's key and checked by the guard like a hop.                                                                                                                                                                                                                                                                    | M     | 82.6 %                           |
| 7  | A source condition on the source's far row             | a many-to-many relation with a condition on its far side (74 / 0)                           | A relation's `when` follows the source's own foreign key to the principal's side, under the step 5 rule.                                                                                                                                                                                                                                                                                            | S     | 82.8 %                           |
| 8  | An insert's condition along a foreign key              | (41 / 26)                                                                                   | The insert reads the referenced row in its transaction, `FOR SHARE`, and judges the condition on it.                                                                                                                                                                                                                                                                                                | S     | 83.5 %                           |
| 9  | P4a secondary read paths                               | several containment paths for one table (273 / 51)                                          | A table declares `reach: { <dimension>: <fk column> }`. Grants and relations on that dimension read the table; writes, inserts and moves follow containment only. Shown as a widening.                                                                                                                                                                                                              | M     | 87.3 %                           |
| 10 | A condition on one relation                            | a condition on one branch of an OR of reaches (63 / 1)                                      | `via: { member: { actions, when } }`: the condition applies only to what the relation grants.                                                                                                                                                                                                                                                                                                       | S     | 87.8 %                           |
| 11 | Through-at-node                                        | an intersection of a membership and a relation (39 / 5)                                     | A role with `via` granted at a scope value carries `~rel` with that node. The relation reaches only rows inside it. The entry's value field is reserved for this.                                                                                                                                                                                                                                   | M     | 88.7 %                           |
| 12 | `admits`, widening within a tenant                     | an OR of a reach and a condition (334 / 94)                                                 | `admits: { <action>: <condition> }` adds rows that satisfy a structured condition, only inside a declared tenant partition the caller holds the action in. A dimension declares the partition first. Never raw SQL. Its own ADR.                                                                                                                                                                    | L     | **95.0 %**                       |
| —  | A view as a relation source                            | a join view as the source of a relation (206 / 1)                                           | Out of the framework (below). A port replaces the view with a source table written by bounded delegation.                                                                                                                                                                                                                                                                                           | port  | 99.7 % with the port             |

Each step is its own PR on top of the previous ones, re-measured with L2, and replayed with L3 where it touches reads.
Steps 2, 4, 9 and 12 change what the approval diff shows; steps 2, 11 and 12 add protocol fields that must stay
additive.

**What stays out, and why:**

- **A view as a relation source** (206 rules, 4.7 points). A view's rows change with every write to its base tables,
  and the delegation bound sees none of those writes. Nobody could bound who gains access, and an approver could not
  review it. A port that needs one writes its source rows through a real table with `assign`.
- **A JSON column compared in a condition** (2 rules). The data layer never compares JSON; a port extracts the value
  into a typed column.
- **A path of more than three foreign keys** (5 rules). Each hop is a subquery in every statement of the action; a
  port shortens the path with a stored column.
- **Raw SQL in any condition**, `admits` included. A structured condition is reviewable and checkable by the guard;
  SQL is neither.
- **The harness remainder** (7 rules), which L2 cannot translate for reasons of its own, not of the model.

## Consequences

- An application expresses most row-dependent access as data the approver reviews, instead of handler code. Through
  step 12, a port moves about 95 % of the corpus's conditional rules into declarations; the rest goes into handlers.
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
  hold the assistant's actions. Every realistic port would then grant the coordinator those actions, which is wider
  than the bound.
- **`admits` together with `when`, or raw SQL in it.** Widening without a tenant partition lets a grant in one company
  reach published rows of another. Raw SQL is the opposite of what a reviewable widening needs. It is deferred to step
  12 with its own ADR.
