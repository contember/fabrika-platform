# One authorization model for the platform and the runtimes behind it

A proposal: the platform and any runtime framework it fronts (see [a foreign runtime](foreign-runtime.md)) share one
authorization model in **concepts and guarantees**, not in code. Each keeps its own implementation; when a foreign
runtime declares its access to the platform, the mapping is mechanical because both sides mean the same thing by an
action, a role, a node and a grant, and both give the same twelve guarantees.

The model has three layers. The actor's data is serializable and issued by the identity system. Part of the rules is
declarative, over roles and that data, and checked before anything runs. Part is imperative code, which may extend the
model in any direction, but only narrowing is free.

## Scope of conformance

- **Mandatory:** the semantics S1–S12 below, in every conforming system.
- **Optional vocabulary:** several parents per dimension, optional parents, column actions, attribute conditions. A
  system may support a subset. A boundary refuses a declaration the other side does not support; it never
  approximates it.
- **Not shared,** because the deployment models differ: the mechanics of a partition (row-level security, a schema or
  a database per tenant; the concept is shared, see Layer 1), where enforcement runs (the proxy and the application here,
  in process elsewhere), credential transport and lifetime, the installation administrator path, and the mechanics of
  declared off-road steps.

## Terms

| Term              | Definition                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| action            | A verb the application declares, such as `crm.read`. Never repurposed once declared.                                                 |
| role              | A named set of actions in the application's catalog.                                                                                 |
| member role       | A role that may be held only at nodes of one declared dimension.                                                                     |
| dimension         | A declared kind of container, with containment edges to its parent dimensions.                                                       |
| partition         | A root dimension declared as one: every resource lies in exactly one of its nodes, for good. A tenant is a partition.                |
| node              | One `(dimension, id)`. "Scope" is a local name in each system, not a model term.                                                     |
| resource          | A protected object of the application; it lies at a node and in that node's containers.                                              |
| principal         | An identity the identity system stores: a user or a service.                                                                         |
| actor             | Whoever a request acts as: a principal, a workload, a share link or API key acting for its issuer, or anonymous.                     |
| grant             | A stored assignment of one role or one action to a principal, at one node or application-wide, with an optional expiry and a source. |
| binding           | How an operation's action attaches to its subject: application-wide, one resource, a container, a list, a create, several at once.   |
| catalog revision  | One approved state of the application's vocabulary: actions, roles, dimensions.                                                      |
| guardrail         | A global, code-level check that only subtracts.                                                                                      |
| declared widening | A named rule that admits beyond grants.                                                                                              |

Enforcement, authorization and admission keep their meaning from [the overview](../reference/overview.md). The model says
"a rule admits" for an authorization outcome and does not call it admission.

## Layer 1 — the actor's data

- **Grants and attributes.** Attributes are typed and serializable, each with its issuer, assurance and freshness, issued
  only by the identity system and never writable by the actor. `email` and a verified email are distinct attributes;
  actor kind and execution provenance are distinct facts.
- **Roles.** A role granted at a node holds its actions at that node. A member role adds one constraint: it may be held
  only at nodes of its dimension, and a grant that breaks it confers nothing. No catalog change voids an existing grant
  unless the approval names it.
- **One catalog author.** The application's approved catalog is the only source of role meaning; the identity system
  reconciles roles only from an approved artifact. A role changes only through an approved revision. The approval binds
  the baseline and target revision and names each rule that widens or voids authority ("role X gains action Y",
  "operation O binds to company instead of deal", "dimension D gains parent P"). Counts of affected grants are
  informational; consent covers every grant a named rule matches at activation, and a reconcile voids only grants a
  named rule covers. Introducing or re-introducing a role key counts every stored grant naming it, dangling ones
  included, as widened.
- **Activation.** Activation and rollback define the permitted combinations of identity-system, proxy and application
  revisions, including intermediate and failed states. Requests are served only under a permitted combination;
  otherwise the affected operations refuse until compatibility is restored. Installation-defined roles are part of an
  approved revision or are expanded into actions by IAM; a credential never names them.
- **No wildcards** in grants or application catalogs. The installation administrator role is the only wildcard, and it
  reaches an application only through an explicit grant at that application, shown in the approval. A bootstrap or
  cross-application grant never reaches an application credential.
- **Authority envelope.** Before a grant is interpreted, its issuer, application and environment audience and subject are
  verified.
- **Tenancy is a partition.** A tenant is not a separate concept: it is a root dimension declared as a `partition`. Its
  node is required on every resource and immutable, so no move crosses partitions. A partition carries an isolation
  guardrail, which only subtracts: no operation reads or writes across two partitions. A grant at a partition node
  reaches that partition only. An application-wide grant that would reach every partition is refused unless it is
  declared as a platform grant. An application with no partition dimension has one implicit partition, so
  application-wide means the whole application.
- **Credentials are projections.** A credential carries what its enforcement point needs. The rest, such as the list of
  nodes, may be fetched by the application from the identity system within the same freshness bound.
- **Freshness.** Each system declares T: a revoked, narrowed or expired grant stops admitting within T. A grant's expiry
  is a hard deadline. An access credential expires no later than the earliest time at which any authority it represents
  loses all its supporting grants: per identical action-and-node entry take the latest expiry among its grants (a
  grant without expiry means no deadline), then the earliest across entries. A compressed projection keeps this bound.
  A share link or API key is capped at issue by S8 and re-checked at every mint.

## Layer 2 — declarative rules

The application declares actions, roles and member roles with `assignableBy` (a role may name itself, and the matrix
shows it as self-propagating), acyclic dimensions, and how each resource lies in them: a column, a foreign-key path or a
declared relation, read from stored data. An operation declares the actor kinds it accepts, its action and its binding.

- **S1 Containment.** A grant at a node holds at that node and every node it contains. A missing required parent makes
  the chain incomplete; an absent optional parent is confirmed absence.
- **S2 Application-wide.** A node-bound grant never satisfies a rule that requires the action application-wide; an
  application-wide grant satisfies node-bound rules.
- **S3 Stored facts.** A binding is judged on facts the system reads from stored data: containment, ownership,
  attributes. From the input it takes only the resource id, and a create's or a move's container ids. A binding that
  names no resource, a resource that does not exist, or an incomplete chain denies. A root may be opaque, with no table
  of its own (an organization id): the actor establishes it by its own grant on it; an application-wide grant admits
  any well-formed value, and the approved artifact states that the value is not checked to exist. A node registered in
  the identity system may replace this rule. Rows stored under an opaque root stay reachable by the grants that reach
  them, whether or not a grant on the root remains.
- **S4 Lists.** A list returns exactly the rows the single-resource rule admits for the same actor, context and data
  snapshot, derived from the same declaration and never hand-written beside it. It includes grants on the listed
  resource's own dimension and on every container. A single-resource binding is a gate and never adds rows: rows come
  only from bindings over the listed resource, an application-wide branch reads every row, a conjunction of gates only
  reads nothing, and a disjunction ignores gates. Authorization applies before pagination, sorting and aggregation, and
  to every query that contributes to the result, related rows included. Visibility guardrails apply to lists too.
- **S5 Creates and moves.** A create is judged on every non-null container it names, read from stored data, never on
  chain values the input asserts for the new row. A move is the resource's own rule with the move action plus a create
  on every new container. Setting or clearing an optional parent is judged on the non-null side.
- **S6 Atomic writes.** A write is conditioned, in its own statement or transaction, on the containment and attributes
  its authorization used.
- **S7 Fields.** A field with its own read action is never returned, filtered, sorted, grouped or aggregated without a
  binding of that action. A field with its own write action is never changed without one; authority to write the row
  does not substitute for it.
- **S8 Delegation.** An actor assigns a role at a node only through a role named in `assignableBy` that it holds at that
  node or application-wide, only if it holds every action of the assigned role at that node or application-wide
  (grants on ancestors do not count), and with an expiry no later than the earliest expiry among the grants that
  authorize it. Self-assignment follows the same rule. A share link or API key is delegation: its issuer must be enabled
  and still hold the delegated actions on the chain at every mint, and a missing issuer denies. The installation
  administrator is a named, audited exception, and a credential issued under it is re-checked against the exception.
- **S9 Workloads and anonymous actors.** A workload holds exactly its declared actions, application-wide or at the node
  its binding names (a webhook bound to a node acts only within that node's chain), approved with the artifact; grants
  in the identity system do not apply to it. An operation that lets an anonymous or link actor run with a workload's
  authority is a declared widening. A link actor is bound to one chain, re-checked on every use.
- **S10 Errors.** Unknown vocabulary, a dangling role, missing evidence or an evaluation error denies the branch that
  depends on it; an error in a guardrail denies the operation.
- **S11 Indistinguishability.** For a resource the actor may not read, a denial is indistinguishable from not-found.
- **S12 Composition.** Rules compose with all-of and any-of; in an any-of, a branch that denies does not deny an
  independently admitting one. A bulk binding (several ids of one dimension; S4 governs lists) needs one alternative to
  cover every target. Within it, grants of the same action combine; targets admitted by different alternatives are not
  stitched together unless the operation declares per-resource admission.

## Layer 3 — code

- **Free refusals.** Code may refuse anything that does not restrict visibility: a write refusal, or a refusal that does
  not depend on the resource. The criterion is the effect, not the reason. An error is a refusal, and code never turns a
  refusal into an admission.
- **Declared visibility.** A refusal of a read that depends on resource data, or that hides resources from a list, is a
  visibility restriction. It is part of the binding's declaration, so S4 holds, or the operation is declared
  single-resource only. No tool detects a handler that filters rows after its query; this is a review rule, backed by
  tests that compare list and single-resource results.
- **Declared widening.** A rule that admits beyond grants (an assignee edits their ticket, a relation in application data)
  is named and states its stored data source, its path through the operation's requirement (the endpoint requirement
  names it, so the proxy does not refuse it first), its list predicate or "single-resource only", and its writer rule.
  A write to data that a widening reads is delegation and is judged by S8, also when the writer already holds the access.
  The widening shows in the role × operation matrix and in review. Trusted-code data access (`unscoped`, `ctx.sql`) is a
  declared exception, not proof of conformance.
- **Guardrails** run for every branch, declared widenings included, and only subtract. There are no deny grants.
- **Attribute conditions** narrow; one that admits is a declared widening. An absent attribute fails the condition.

## Where the platform stands

Conformant today: allow-only grants; member roles and `assignableBy` with the same-node rule, and delegated grants
clamped to the expiry of the grants that authorize them (`packages/iam/src/membership.ts`); chains read from stored data in the application (`packages/app/src/implement/dispatch.ts`);
lists derived from the table policy, including grants on the listed resource's own dimension, and pinned by the query guard (`packages/db/src/store.ts`, `guard.ts`); writes
conditioned on the chain with `FOR SHARE` on the destination; not-found for a refused `on` binding; workloads holding
only their declared actions (`packages/iam/src/tokens.ts`); share links and anonymous keys re-checked against their issuer
at every mint (`issuerAuthority`); exact actions only at a contract application (`exactActions`, `packages/iam/src/resolve.ts`,
preflighted by migration 0027); an opaque root (a root dimension no table owns) named in the approval diff and on the
surface as admitting any value unchecked, derived by Control from the artifact every reader already emits
(`opaqueRoots`, `packages/control/src/approval/diff.ts`); access tokens capped by the grants they carry
(`authorityDeadline`, `packages/iam/src/resolve.ts`).

Gaps:

- A failed or pending IAM reconcile after a deploy leaves a narrowing unapplied while the new version serves. Decided:
  narrowings are written to IAM before the manifest is published, widenings after
  ([backlog 226](../backlog/226-a-failed-iam-reconcile-leaves-a-narrowing-unapplied.md), after the provider-neutral-core
  sprint).
- One parent per dimension (optional vocabulary).
- Expanded `perms` overflow the token for a principal in hundreds of nodes. Decided: raise the bound, not project the
  token. IAM now signs a token the proxy injects toward a contract application up to 24 KiB (about 150 entries; it
  travels twice on a bearer request), and the platform starts an application's Bun server with a 64 KiB header limit.
  Client-sent tokens stay at 8 KiB. A compact, additive claim shape and the 1000-value `Within` cap remain
  ([backlog 100](../backlog/100-a-principal-in-many-scopes-gets-no-token.md)).

## Migrating the application in production

The application running in production declares `org › company › {contact, deal › task}` and grants global roles at
`org` nodes. Under the Layer 1 role rule it needs no change to its contract, its IAM grants or its rows: `org` is an
opaque root (S3), established by the actor's own grant and unchecked under an application-wide grant, and its rows stay
reachable whatever grants remain on their org.

- **Precondition:** the application resolves `@fabrika/app` from the registry within the support window (ADR-0062 rule 1)
  before any step ships.
- **Preflight:** inventory its grants (`app` equal to the application or NULL) and classify them: role at org,
  application-wide, at another dimension, inline actions, custom roles, wildcards, `admin`. A wildcard or custom role is
  resolved by an approved catalog revision before wildcard support is removed.
- **Verify:** per principal, the set of (action, node) that resolution yields is equal before and after each step. The S4
  own-dimension change affects lists only for holders of grants at contact or deal nodes, whose single-resource checks
  already admit those rows.

## Decided against

- **A shared evaluator or package.** The proxy has no data and can only ask whether an action is held somewhere; binding
  to an object happens in the application. A runtime that decides in process needs a different evaluator.
- **Pinning each grant to a catalog version.** The proxy and the application would have to hold every live revision.
  Approved revisions that name what they widen give the same protection.
- **Wildcards** in application vocabularies: they hide widenings from the approval diff.
- **Ancestor delegation:** IAM is flat, so the same grant data would mean different things on the two sides.
- **Deny grants:** guardrails in code cover the need without the explanation cost.
- **The built-in `admin` role at a contract application.** It keeps resolving to nothing there: an application's
  administrator is a role of its own catalog, which the approval shows.
- **Lifting the creator-role clamp.** A scope's creator role keeps ending no later than the grant that let its holder
  create the scope (S8); creating a value is delegation like any other.

## Open questions

- Whether a node registry in IAM should replace opaque roots.
- Attribute claims beyond `email`: which ones, issued how, and their freshness.
