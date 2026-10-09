---
id: 0050
title: Publish only approved access
status: accepted
date: 2026-10-08
---

# 0050 — Publish only approved access

## Context

An application declares its access surface in one contract and its table policies
([ADR-0012](0012-fabrika-app-runtime.md)). The proxy enforces the contract per endpoint
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), and IAM holds the roles. Both read what
Control publishes.

The person who drives a coding agent often does not read the diff. The agent is competent but
optimizes for "it works". When a request is refused, it loosens whatever refused it: an endpoint's
callers, a role's actions, a table policy. Two authoring paths reach the platform: a local agent with a
builder key ([ADR-0042](0042-connect-local-builders-through-human-consent.md)), and a hosted agent over
MCP ([ADR-0049](0049-author-applications-through-mcp-in-control.md)). In both, a widened contract is
visible only in the pull request, and nobody has to look at it.

Today Control has no record of what access an environment has. `app_envs.provider_artifact_json` is one
mutable value. Several paths publish a proxy manifest or reconcile IAM from it: the deploy,
`apps.environments.put`, namespace reconcile and the provider's reconcile paths. The IAM schema comes
from the uploaded artifact on Zerops and from the runner's outcome on Cloudflare. Each of these is a
self-report of the build the agent controls.

## Decision

**We will publish an application's access only from an approved snapshot, and we will make every
widening on a protected environment wait for a human.**

Built in work unit B6 (`packages/control/src/approval/`). Details the sections below leave open:

- The migration checksum is the SHA-256 of the file's text, the checksum the application's ledger records;
  every file under `db/migrations/` is listed.
- The snapshot digest covers the canonical contract, the migration list and the artifact access, not the
  checker version.
- A commit without `fabrika.contract.ts` has a snapshot without a contract. Dropping the contract from a
  commit is a widening.
- An application without a contract is approved by its **artifact access**: its gates and IAM schema
  (`ArtifactAccess`, `artifactAccessDigest` in `@fabrika/auth-core`). The snapshot holds it. The digest is
  over `canonicalArtifactAccess`: catalogs (scopes, actions) are sorted by identifier and sets (permissions,
  assigners, link grants, OAuth scopes) by value; gate rules keep their order, which is precedence. A list
  that repeats an identifier is refused, not sorted. Every change
  from the approved one is a widening, a removal included, so the first deploy to a protected
  environment waits, and so does a contract removed (1 → 0). A provider receives the approved digest
  (`ProviderEnvironment.artifactAccess`). It applies an artifact's gates and schema only when they hash to
  that digest. Without approved access a provider routes nothing, reconciles no IAM schema and refuses a
  non-dry deploy.
- On Zerops, Control reads the artifact access from the registry's artifact before the deploy
  (`ControlProvider.artifactAccess`). A registry write changes the artifact and advances `generation`,
  so a run that classified the old one classifies again.
- On Cloudflare the access is known only once the runner loads the config. A run without a contract
  publishes the approved artifact access unchanged. The job carries its digest and the protection. The
  executor reads the config's gates and schema once, before `resources()` runs, and hashes that frozen copy;
  the proxy, the report and the IAM schema all come from it. On a protected mismatch it stops before provisioning
  and reports them. Control fails that run and creates a new run, parked in `awaiting_approval` with
  that access as its candidate. A new run, so the runner never sees a run id twice. Approving it
  deploys with the approved digest. Otherwise the deploy reports what it applied. IAM applies only a
  reported schema that matches the approved digest, or any on an unprotected environment. Control then
  records it in the publication (`recordDeployedArtifactAccess`).
- The published snapshot is stored on `app_envs.published_snapshot_json`, written by the same
  compare-and-swap as `published_run_id`.
- Control reads the snapshot at the provider's `applicationRoot`, the directory the provider executes
  from, with the same normalization (`checkoutRelativeDirectory` on Cloudflare). A root outside the
  repository fails the run.
- The Cloudflare runner job carries the approved access: the contract and its digest, or the artifact
  approval. The runner hands it to the executor in a file beside the checkout. The deployer builds the
  proxy table and `FABRIKA_CONTRACT_DIGEST` from it, never from the checkout. Every framework variable
  in each generated wrangler config must equal the value the platform wrote, so a binding's
  `configureBinding` cannot overwrite the digest.
- The snapshot is logged before the run's secrets are known, so redaction cannot cover it. Its log
  lines carry fixed codes and counts only, never a name from the checkout. The change lines stay in
  the classification the approval page shows. For artifact access they cover every field of the IAM
  schema: each entry type has a field table the compiler holds complete (`IAM_SCHEMA_FIELDS`), and a
  change no field describes still shows as a change.
- A run records its actor as `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>` or `poll`.
- `approvals.complete` approves or refuses; a refused run fails. The protected flag changes through
  `apps.environments.protect`. A parked run can be cancelled.
- A provider that pins no commit (`resolveSource` absent) reads no snapshot and publishes nothing new.

### 1. A deploy run holds the snapshot

Right after a run's commit is pinned, Control reads the contract, its schema modules,
`src/db/tables.ts` and the migration list with checksums at that commit. It parses them with the static
reader of [ADR-0005](0005-compile-app-config-to-static-manifest.md). The run stores the result as its
**snapshot**:

- the parsed contract and table policies;
- the migration list with checksums;
- the checker version;
- the baseline the candidate was compared with;
- the approval, when one was needed.

Uploads carry no gates and no IAM schema. A snapshot comes only from the commit.

### 2. Publication is a compare-and-swap on the environment

`app_envs` gains `published_run_id`, `generation` and `protection_revision`. The published run's
snapshot is the environment's **active snapshot**.

One function, `approvedSnapshot(app, env)`, feeds every path that publishes a proxy table or
reconciles IAM:

- the deploy;
- `apps.environments.put` and `delete`, and `apps.delete`;
- `namespaces.reconcile` and the namespace jobs;
- the Zerops `reconcile-schema` step, cancel and reconcile;
- the Cloudflare deploy and reconcile.

A run publishes with `UPDATE … WHERE generation = ? AND protection_revision = ?`, inside the existing
namespace lease. A concurrent publication therefore loses. A change of the `protected` flag advances
both values, so a run that classified under the old flag also loses. A registry write advances
`generation` too. The counters are monotonic per `<app>@<env>` and survive deletion (section 4).
`apps.environments.put`, `apps.environments.delete` and `apps.delete` apply only while the environment
is at the generation they read, so a protection change between their check and their write refuses them.
A refused put commits nothing, its namespace claims included.

Every write of an `<app>@<env>` — create, put, delete, protection change, publication — first ensures
the coordinates' `app_env_protection` row and locks it, and only then reads the tombstone or the
environment. A write that may create an environment, and an application's deletion, lock the `apps`
row first. On Postgres concurrent writes of one environment therefore run one after another; SQLite
and D1 run one batch at a time anyway.

A protection change takes the environment's deployment lease and is refused (409) while a run holds it
or is still `running` without it: a job deploys what the flag allowed when it started.

A run that loses the compare-and-swap is classified again against the new active snapshot. This holds
while the run waits and after it is approved. An approval is valid only for the baseline digest it
recorded. When the new diff still widens, the run needs a new approval.

**Invariant: a pending change is published nowhere.** No path publishes a proxy table or reconciles IAM
from anything other than `approvedSnapshot(app, env)`.

### 3. Classification is a conservative diff

Control compares the normalized access data of the candidate snapshot with the environment's active
snapshot. An environment with no published run has the empty snapshot as its baseline. The comparison
covers:

- endpoint callers, access forms and output fields;
- containment, roles and their actions, membership rules;
- table and column policies;
- anonymous kinds, link mounts and link-reachable file collections;
- job and webhook actions, connector exports and imports;
- CSP extensions;
- migrations: any new or changed file.

The rule has three outcomes:

- **No change** passes.
- **A change that only removes** passes, with two exceptions (below).
- **Everything else** waits for approval on a protected environment.

**A removed endpoint can widen access.** The proxy selects the most specific endpoint
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), so a literal endpoint can shadow a
broader parameter or wildcard endpoint. Removing the literal would send its paths to the broader one.
A removal of an endpoint therefore passes only when none of its former paths matches another endpoint
in the candidate table: `planEndpoint` over the candidate table selects no endpoint for those paths, so
they become denied. Otherwise Control classifies the removal as a widening, and it waits like any other.

**A removed column read policy widens access.** Without its own read policy, a column falls back to the
table's read action. Removing a column's read policy is therefore a widening, and it waits. Removing a
whole table or a whole column stays a removal.

The diff is a pure function. It produces plain-language lines for the approver, for example "Role
`editor` gains `notes.delete`" or "New endpoint `api.notes.export` for editors".

### 4. Only production is protected by default

Each environment has a `protected` flag, a column of Control's `app_envs`. `prod` is protected by
default; every other environment is not. Changing the flag requires `access.approve` from a human user
principal, the same rule as approving (section 5). Control's audit log records every change.

The flag outlives its environment. Deleting the environment or the application writes the flag and
both counters, `generation` advanced, to `app_env_protection`. Nothing deletes that row. A recreated
environment starts from it, else from the default. Deleting a protected environment, or an application
with one, takes the same human with `access.approve`.

Unprotected environments do not wait. Every environment with `protected = true` requires approval
for a widening, whatever its name or role. Staging and MCP authoring targets are unprotected by
default, so a change applies there at once. When the same commit is deployed to a protected
environment, Control classifies it again against that environment's active snapshot.

Staging must not hold production data. This is a rule for operators; the platform does not enforce it.

### 5. A human user approves, with `access.approve`

A run whose change waits enters the state `awaiting_approval`. Control serves `approvals.list`,
`approvals.get` and `approvals.complete` behind a new action, **`access.approve`**. The action is
outside the `deploy.*` wildcard, so the `operator` role does not grant it.

- **Only a user principal can approve.** A service principal, the builder key and any OAuth or MCP
  token are refused, even when they carry `access.approve`.
- **The approval happens in the dashboard**, with a same-origin request. The `access.approve` check and
  the user-principal check are authorization; the proxy's `Sec-Fetch-Site` check is admission, in the
  vocabulary of ADR-0022.
- **The approval records the candidate digest and the baseline digest.** It approves one change against
  one baseline.
- **Runs record their actor**, including runs created through MCP. MCP's `get_deployment` reports a
  parked run with the approval link.

**Invariant: only a human user principal approves an access change.** No credential that an agent or a
workload can hold completes an approval.

### 6. A rollback is a new deploy

A rollback deploys an older commit as a new run. Control classifies it like any other run, against the
environment's active snapshot. Publishing an older run's snapshot again is not a rollback path.

## Consequences

- An agent can no longer widen production access silently. A widening on `prod` waits until a human
  reads the plain-language lines and approves.
- A removal and a code-only change deploy without a prompt, unless the removal uncovers a broader
  endpoint or removes a column read policy. Unprotected environments, including
  staging and MCP authoring targets by default, do not wait.
- The first deploy to a protected environment always waits: against the empty snapshot, every item is
  an addition.
- An agent cannot unprotect an environment to avoid the prompt: the flag change needs the same human
  approval.
- Every path that touches published access goes through one function and one compare-and-swap. A new
  write path must use `approvedSnapshot(app, env)`; a path that reads the provider artifact for access
  data is a bug.
- The diff is conservative. It does not recognize a harmless addition and shows no head counts, so
  approvals on `prod` may be frequent. Approval fatigue is a real risk; the number of prompts per
  deploy must be measured. A reachability classifier is the next step when it is needed.
- The approval proves a signed-in user with `access.approve`, not a physical human. An agent that drives
  the approver's own signed-in browser can approve. The skill forbids it; WebAuthn on
  `approvals.complete` is the next step.
- A rollback that restores removed access waits for approval like any other widening.
- Approval exists only on protected environments. Staging is unprotected by default, so it must hold
  no production data.
- Control needs the static reader on both runtimes, and the dashboard needs an approval page.

## Alternatives considered

- **Rely on pull-request review.** Rejected: the change is visible only in the pull request, and the
  threat is a person who does not read the diff.
- **Keep reading access data from the provider artifact or the runner outcome.** Rejected: both are a
  self-report of the build the agent controls, and the artifact is one mutable value.
- **Store approvals in a separate record beside the run.** Rejected: a snapshot on the run keeps the
  candidate, the baseline and the approval together, and `published_run_id` points at one row.
- **Approve every deploy, or every change.** Rejected: a prompt for a code-only change teaches people
  to approve without reading.
- **Recognize harmless additions automatically.** Deferred: it needs a reachability classifier. v1
  gives it up and treats every addition as a widening.
- **Protect every environment by default.** Rejected: staging and MCP authoring targets must apply at
  once by default, or the authoring loop stalls. A human can still protect any environment.
- **Let the deploy permission approve.** Rejected: every operator holds `deploy.*`, and the builder key
  holds `deploy.trigger`.
- **Let a service principal, the builder key or an MCP token approve.** Rejected: the agent holds those
  credentials, so it could approve its own widening.
- **Roll back by republishing an older run's snapshot.** Rejected: that snapshot was approved against
  a different baseline. A new deploy is classified against the current one.
