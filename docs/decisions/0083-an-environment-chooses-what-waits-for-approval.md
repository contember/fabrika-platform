---
id: 0083
title: An environment chooses which kinds of change wait for approval
status: accepted
date: 2026-11-24
---

# 0083 — An environment chooses which kinds of change wait for approval

## Context

[ADR-0050](0050-approved-access.md) gives each environment one switch, `protected`. On a protected environment a
deploy waits for a person when one of its lines needs closer review: a step off the paved road, something anyone sets
off without signing in, a mutation served on `GET`, people becoming visible, a file collection adopted or released, a
terminal naming who signs in, or a migration statement not known to keep every stored value. Every other change
publishes at once.

Two kinds of permission change never wait:

- **In the contract.** A role that gains an action, a role opened to external principals and a new role are plain
  widenings: they publish on `prod` at once and are reviewed after the fact.
- **In the console.** A grant, an edit of a grant and a revocation through IAM's administration API
  (`grants.*`, and an application administrator's `appPeople.grant` / `appPeople.revoke`) apply in their own
  transaction and are only audited.

Some teams want a person to approve those too, on some environments and not on others. A second switch per kind would
multiply the console's settings; a fixed stricter list would bring back the prompt fatigue ADR-0050 avoids. The
choice belongs to whoever may protect the environment, per environment.

## Decision

**We will let each protected environment choose, from a fixed list of change categories, which ones wait for a
person.** The defaults are exactly ADR-0050's closer-review reasons, so an environment nobody configures behaves as
before.

### 1. The categories

A category is a fact the diff already records on a line (ADR-0050 §3), never a new judgement:

| Category        | A line belongs to it when                                                                                                                                  | Default |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `off-road`      | it needs closer review for reason `off-road` (SQL, unscoped tables, connect, link issuing, a contract outside the staged kit, access views, database code) | on      |
| `anyone-calls`  | reason `anyone-calls` (a public procedure, the actions it newly holds, a kick from it)                                                                     | on      |
| `get-mutation`  | reason `get-mutation`                                                                                                                                      | on      |
| `people`        | reason `people`                                                                                                                                            | on      |
| `adoption`      | reason `adoption`                                                                                                                                          | on      |
| `terminal`      | reason `terminal`                                                                                                                                          | on      |
| `deletes-data`  | reason `deletes-data` (a migration statement not known to keep every stored value)                                                                         | on      |
| `role-actions`  | it widens with rule `role.grants` or `role.via`: a role gains an action, directly or through a relation                                                    | off     |
| `role-external` | it widens with rule `role.external`: a role opened to external principals                                                                                  | off     |
| `role-added`    | rule `role.added`: a new role                                                                                                                              | off     |
| `public`        | it widens with rule `endpoint.public`, or is rule `endpoint.added` with audience `anyone`: an endpoint (an SPA among them) anyone opens without signing in | off     |
| `csp`           | it widens with rule `csp.source`: a CSP directive admits another origin                                                                                    | off     |
| `grants`        | a console grant, grant edit or revocation in IAM (section 4), not a deploy line                                                                            | off     |

A closer-review line stored before lines carried a reason belongs to every closer-review category, so it waits
whenever any of them is chosen. The mapping is one pure function in `@fabrika/control-contract`
(`changeCategories`), which Control's deploy gate and the console share, as they shared `waitsForApproval` before.

### 2. The choice is stored with the environment

`app_envs.approval_categories` holds the choice as its difference from the defaults: the categories added and the
default ones removed. Null is the defaults. A category a later release adds to the defaults therefore applies to every
environment that did not remove it by name. The column is kept in `app_env_protection` with the `protected` flag, so a
recreated environment starts from the choice its deleted predecessor left (ADR-0050 §4).

The choice applies only while the environment is protected; an unprotected environment waits for nothing, as before.
It changes through `apps.environments.protect`, which gains an optional `categories` list (omitted keeps the stored
choice). The same rules hold as for the flag: `access.approve` at the coordinates, a person in the console, the
environment's deployment lease, a refusal while a run is `running`, and one audit row (`access.protect`, with the
categories before and after). The change advances `protection_revision` and `generation`, so a run classified under
the old choice classifies again.

### 3. The deploy gate

A run waits when its environment is protected and one of its lines belongs to a chosen category
(`waitsForApproval(changes, categories)`), whatever the outcome. The stored classification records the categories it
was classified under (`StoredClassification.categories`), so the approval page and the run's status say why it waits;
a classification stored before them reads as the defaults. Nothing else of ADR-0050 changes: the approval binds both
digests, an approved run classifies again, and a lost compare-and-swap classifies again under the choice that holds
then.

### 4. A console grant waits as a grant request

IAM keeps whether an application's grants wait, per IAM application id `<app>@<env>` (`app_grant_approvals`), because
IAM is where a grant is written. Control is the only writer, and IAM enforces that: `grantApproval.set` answers only
the provisioning key, never an installation administrator, who could otherwise switch the gate off, grant, and switch
it back. Every protection change of an environment sets the gate under the environment's deployment lease, carrying
the environment's protection revision, and IAM ignores a revision older than the one it holds, so a caller that lost
the lease cannot undo its successor's gate. Control writes the stricter side first: a change that leaves grants waiting
writes IAM (at the revision its own write will reach) before its own row, one that releases them writes its own row
before IAM. Nothing reverts IAM after a failed Control write: a failure in between leaves IAM gating while the console
may say it does not, the console reports it, and the next protection change converges both. A platform audience is
refused: no grant at the console or IAM waits.

While an application's grants wait, `grants.create`, `grants.update`, `grants.delete`, `appPeople.grant` and
`appPeople.revoke` at that application run every check they run today, then write a **grant request**
(`grant_requests`) instead of the change, with its record `iam.grant.request`, and answer `pending` with the request.
A cross-app grant reaches no application and never waits. Grants that are an application's own behaviour (membership
assignments and invitations, a scope's creator role, share links, device and workload keys) do not wait: they are not
console grants.

- **A pending request has no effect.** Nothing that resolves permissions reads `grant_requests`. The grant is written
  only when a person approves it.
- **Who approves.** An IAM administrator of the application (`iam.admin`, or `iam.users.manage` there), as a person in a
  signed-in session (never a `px_` key), who is not the requester. Approving is making the change: IAM runs the
  original use case's checks again with the approver as the administrator, and refuses (409) what the approver could
  not do now, the role and the application included. The requester may withdraw (reject) their own request, also an
  application's administrator who asked through `appPeople.grant` and administers nothing in IAM.
- **Atomic.** The approval claims the request (`pending` → `approved`, under a fresh decision id) and writes the grant
  change guarded on that claim in one transaction, so two approvers make one change. A change that writes nothing
  despite the checks (a concurrent change took its place) closes the request `failed` in the same transaction. A
  request that renews an expired role renews it in place, as the direct path does.
- **Audit.** The request writes `iam.grant.request`; the approval writes the change's own record
  (`iam.grant.create` / `update` / `revoke`) with the request id and the requester, under the approver; a rejection
  writes `iam.grant.request.reject`. Each in its change's own transaction.
- **Expiry.** A request expires 7 days after it was made (`GRANT_REQUEST_TTL_SECONDS`); an expired request cannot be
  approved and leaves the list of open requests. A grant request made through `appPeople.grant` keeps the expiry its
  requester's authority allowed (S8).

### 5. The console

The application's "Access approvals" section lists the categories under each protected environment's switch, the
defaults marked, with one save for a holder of `access.approve`. Removing a chosen category asks for a confirmation,
as turning approvals off does. Everyone else reads the chosen categories. The Approvals page lists the open grant
requests the viewer may decide beside the parked deploys, with approve and reject, each with the expiry of the grant
it would write, and a requester's own with withdraw. A grant form that gets `pending` says the change waits for another
administrator.

## Consequences

- An environment nobody configures behaves exactly as under ADR-0050: the defaults are its closer-review reasons, and
  no grant waits.
- An environment that chooses permission categories makes a role change in the contract, or a console grant, wait for
  a person. A team can protect `prod` this way and leave `stage` open.
- The `grants` choice lives in two stores, Control's environment and IAM's application. Control writes both and the
  stricter one first, under a revision IAM orders by; a partial failure fails closed and is reported, and the next
  protection change repairs it. Nothing else can write IAM's row.
- Approving a grant takes a second IAM administrator. An installation with one administrator cannot approve its own
  grants; it turns the category off first, which takes `access.approve` and is audited.
- Variables, secrets and domains are registry writes with no run to park; they do not wait (section "Alternatives").
- **Rollout.** Both changes are additive migrations: `app_envs.approval_categories` and
  `app_env_protection.approval_categories` (null), IAM's `app_grant_approvals` and `grant_requests` (empty). An
  existing installation converges on upgrade with nothing to do: every environment reads the defaults, and no
  application's grants wait until someone chooses `grants`. Rolling Control back below this release ignores the
  column, and the deploy gate falls back to the defaults. A run classified under a non-default choice stores it, which an
  older Control's strict classification reader refuses, so that run classifies again or fails; one classified under the
  defaults stores nothing new. Rolling IAM back leaves requests unread and grants ungated.

## Alternatives considered

- **One switch per kind of change, outside the protection flag.** Rejected: the flag also limits who deploys a
  protected environment (ADR-0050 §4); categories without it would split that rule in two.
- **Store the chosen list as is.** Rejected: a closer-review reason a later release adds would not apply to any
  environment that ever saved a choice. The difference from the defaults keeps new defaults on.
- **Keep the grant gate only in IAM, set from IAM's console.** Rejected: whoever may grant would also switch the gate
  off; changing it takes `access.approve` in Control, a separate authority, like the flag.
- **Let anyone with Control's `access.approve` approve a grant.** Rejected: IAM decides grants and does not resolve
  Control's vocabulary; an IAM administrator of the application is who may make the grant.
- **Gate variables, secrets and domain changes.** Deferred: they are registry writes that apply in their request,
  with no run to park; gating them needs a pending registry write of its own.
- **Gate membership assignments and invitations.** Rejected: they are the application's own behaviour, decided by
  its contract's `assignableBy`, and a prompt per invitation would stop the application.
