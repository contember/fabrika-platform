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

Two kinds of permission change never waited:

- **In the contract.** A role that gains an action, a role opened to external principals and a new role are plain
  widenings: they publish on `prod` at once and are reviewed after the fact.
- **In the console.** A grant, an edit of a grant and a revocation through IAM's administration API
  (`grants.*`, and an application administrator's `appPeople.grant` / `appPeople.revoke`) apply in their own
  transaction and are only audited.

Some teams want a person to approve those too, on some environments and not on others. A second switch per kind would
multiply the console's settings; a fixed stricter list would bring back the prompt fatigue ADR-0050 avoids. The
choice belongs to whoever may protect the environment, per environment.

A coding agent also acts through its own credential, and the person who drives it mostly reads a phone. It can deploy,
write secrets and variables, run data operations and change registry rows. Some of those were refused outright to a
non-person on a protected environment (a manual deploy, the trigger ref, the domain), and the rest applied at once for
any key that held the action, with nothing able to make them wait. An agent also had no way to ask for what only a
person may do (a deploy of a protected environment, a grant, a key) and hand the person one link to answer it.

Teams differ here as well. Some want a person to approve what an agent does; others give their agents full access, as
they already do with their cloud accounts. The answer to any approval requirement is a setting, not a fork of the code.

## Decision

**We will judge every change that reaches a protected environment with one gate, over a mode per category that the
environment chooses.** A change is a deploy run's lines, or one action of a non-person. Each category has a mode, `off`,
`plan`, `person` or `refuse`, which says what evidence lets a change of that category through. A deploy's evidence is a
person's decision on the parked run, or a plan entry approved ahead of the deploy; any other action's evidence is a
person's decision on an **approval request** that Control stores, inert and exact, and that the agent hands the person
as one link. Two presets are first-class: **strict**, the default, where a person approves what an agent asks for, and
**permissive**, where an agent configures and deploys with no approval.

### 1. The categories

A deploy category is a fact the diff already records on a line (ADR-0050 §3), never a new judgement:

| Category        | A line belongs to it when                                                                                                                                  | Default  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `off-road`      | it needs closer review for reason `off-road` (SQL, unscoped tables, connect, link issuing, a contract outside the staged kit, access views, database code) | `plan`   |
| `anyone-calls`  | reason `anyone-calls` (a public procedure, the actions it newly holds, a kick from it)                                                                     | `plan`   |
| `get-mutation`  | reason `get-mutation`                                                                                                                                      | `plan`   |
| `people`        | reason `people`                                                                                                                                            | `plan`   |
| `adoption`      | reason `adoption`                                                                                                                                          | `plan`   |
| `terminal`      | reason `terminal`                                                                                                                                          | `plan`   |
| `deletes-data`  | reason `deletes-data` (a migration statement not known to keep every stored value)                                                                         | `person` |
| `role-actions`  | it widens with rule `role.grants` or `role.via`: a role gains an action, directly or through a relation                                                    | `off`    |
| `role-external` | it widens with rule `role.external`: a role opened to external principals                                                                                  | `off`    |
| `role-added`    | rule `role.added`: a new role                                                                                                                              | `off`    |
| `public`        | it widens with rule `endpoint.public`, or is rule `endpoint.added` with audience `anyone`: an endpoint (an SPA among them) anyone opens without signing in | `off`    |
| `csp`           | it widens with rule `csp.source`: a CSP directive admits another origin                                                                                    | `off`    |

A closer-review line stored before lines carried a reason belongs to every closer-review category, so it takes the
strictest of their modes. The mapping is one pure function in `@fabrika/control-contract` (`changeCategories`).

The other categories are actions with no deploy line. Each judges an action of a **non-person** (§6); a person acting
in the console is their own evidence, as before:

| Category         | Covers                                                                                                                                                                                                        | Default  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `deploy-request` | a manual run of the environment started by a non-person (ADR-0050 §4)                                                                                                                                         | `person` |
| `secrets`        | `apps.secrets.put/delete`, `vault.set/rotate/delete`, `rotateTokenKey`, the all-environments layer included                                                                                                   | `person` |
| `variables`      | `apps.variables.put/delete`, the all-environments layer included                                                                                                                                              | `person` |
| `data`           | `data.start` (maintenance modes, side restore), `data.recover`, suspend and resume, the backup schedule                                                                                                       | `person` |
| `registry`       | `apps.update` and `apps.environments.put`, every field of each: the trigger ref, domain, public origin, cross-origin list, provider target, artifact and namespace, the application's source and build fields | `person` |
| `agent-grants`   | a grant an agent asks for at the application environment: one role its approved contract declares, for the agent or another principal, for at most 30 days (§4)                                               | `person` |
| `credentials`    | a key an agent asks for, issued to someone other than the agent: exact Control actions at one application, for at most 30 days, encrypted to the agent's public key (§8)                                      | `person` |
| `grants`         | a person's own console grant, grant edit or revocation in IAM (§4)                                                                                                                                            | `off`    |

A write to the all-environments layer (`env: null`) is a write to every protected environment of the application, and
the strictest of their modes applies; the request names them all. An `apps.update` reaches every environment of the
application the same way.

Each action category holds on every direct write of the procedures it covers. The write meets the gate before it runs:
under `off` it applies with the requester's authority; under `refuse` it is a 403 naming the category; under `person` it
does not apply, and Control stores it as an approval request with the procedure as its kind and its input as asked,
exactly as `approvals.requests.create` would (§8). The answer is an RPC error, 409, of type `approval_requested`: its
message names the link, and its data is `{ id, url, state }` with a secret's fingerprint. A write that did not apply
never answers 200, so a client older than requests shows the message with the link and never mistakes it for an applied
write; the command-line client prints the request and exits 75, or follows it with `--wait`. A write that changes
nothing (every field it names already holds that value, as the request page would show "Changes: none") applies as
under `off`; a secret is never judged so, since that would take reading a plaintext. A person in the console applies
directly. An environment that does not exist yet has nowhere for a request to wait, so on one that starts
protected (`prod`, or one deleted while protected) a non-person's write is refused (403), and so is a registration
that names its trigger ref, domain or public origin. `apps.environments.put` and `apps.update` bind
the mode they were judged under to the environment's `generation`, so a stricter mode saved between the check and the
write refuses the write. A table test lists every mutation of Control's router with its category or the reason it is
exempt (§9).

### 2. The choice and its settings are stored with the environment

`app_envs.approval_policy` holds a mode per category as its difference from the defaults, so a category a later
release adds applies to every environment that did not set it. Null is the defaults. It succeeds
`app_envs.approval_categories`, the earlier list of added and removed categories, which is still written beside it so
a Control rolled back reads it as before: an added category converts to `person`, or `plan` for a closer-review one
other than `deletes-data`; a removed one to `off`; null stays null.

The settings are one nullable column beside it, `approval_settings`, holding their difference from the defaults as
`approval_policy` does, so a setting a later step adds needs no migration; null and an absent key read as the default.
`approvers` takes every category but `grants`, whose two-person rule IAM keeps (§4). Each setting lands with the step
that first uses it:

| Setting                | Default                                        | Alternative                                                                                      |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `deployRequestCommits` | `merged`                                       | `any`: an unmerged commit may be requested, still never a workspace ref                          |
| `requestTtlHours`      | 24, for requests and parked runs               | 1–168                                                                                            |
| `requesterMayApprove`  | `true`, per category, grants and keys included | `false`: someone other than the requester's person decides                                       |
| `approvers`            | 1, per category                                | 2: two different people decide, each on the same digest                                          |
| `stepUp`               | `webauthn` for `credentials`, `none` elsewhere | `webauthn` (a passkey assertion bound to the decision) or `none`, any category but `grants`      |
| `credentialCeiling`    | `requester`: actions the requester holds       | `approver`: actions the approver holds in Control, the page warning which exceed the requester's |
| `planEvidence`         | `console`                                      | `console+github`, once the access-diff GitHub check is built                                     |
| `planBinding`          | `transition`                                   | `after-state`                                                                                    |
| `planTtlDays`          | 30                                             | 1–365                                                                                            |

The policy and the settings are kept in `app_env_protection` with the `protected` flag, so a recreated environment
starts from the choice its deleted predecessor left (ADR-0050 §4). They apply only while the environment is protected;
an unprotected environment's requests are decided under the defaults.
They change through `apps.environments.protect`, under the rules of the flag: `access.approve` at the coordinates, a
person in the console, the environment's deployment lease, a refusal while a run is `running`, and one audit row
(`access.protect`, with the policy and the settings before and after). A change that weakens what deciding takes in a
category with `stepUp: webauthn` also takes a passkey assertion bound to the change (ADR-0050 §5), and the audit row
names the passkey; turning `credentialCeiling` to `approver` weakens `credentials`. The change advances
`protection_revision` and `generation`, so a run classified under the old choice classifies again. There is no installation level of defaults or floors yet.

### 3. The modes and the gate

- `off`: nothing is needed. The change applies at once and is recorded. A non-person's action then runs with the
  **requester's** own authority, so `off` never lets an agent do what its credential cannot.
- `plan`: a covering plan entry, or a person's decision on the pending item. A change the plan does not cover waits for
  the person, who sees only the uncovered lines.
- `person`: only a person's decision on this pending item. A plan never counts.
- `refuse`: a non-person may not do it at all, not even by asking (403). The behaviour before requests existed.

The modes are ordered `off < plan < person < refuse`, and a change waits until the evidence satisfies the strictest
mode among its categories. **One function decides**, `gate(changes, policy, plan)` in `@fabrika/control-contract`,
answering `pass`, `wait` with the uncovered lines and the strictest mode, or `refuse`. Control's deploy gate, the
request path and the console all call it; it replaces `waitsForApproval`. An unprotected environment has every category
`off`.

Not every mode fits every category. `plan` applies only to the deploy categories, the ones a pull request carries;
`refuse` only to a non-person's action; `grants` takes `off` or `person`. Saving any other pair is refused with a 400,
so the gate never meets a mode it cannot decide.

A plan entry binds the content of one subject of the snapshot before and after, never a pull request: a later push that
changes the subject no longer matches it. Entries compose as a chain: a line is covered when approved transitions lead
from the baseline's fragment to the candidate's (`planBinding: transition`), or, under `after-state`, when the
candidate's fragment is approved whatever it replaced. An entry is consumed in the compare-and-swap of the publication
it covered, so an approved widening that was shipped and narrowed again cannot come back unseen. Until plans are built,
no entry exists, and `plan` waits for a person exactly as `person` does: today's approval of a parked run.

### 4. A console grant waits as a grant request

IAM keeps two gates per IAM application id `<app>@<env>` (`app_grant_approvals`): whether the environment's grants
wait, because IAM is where a grant is written, and its `credentials` mode (`off` when unprotected), because IAM is
where a key is issued (§8). Control is the only writer, and IAM enforces that: `grantApproval.set` answers only the
provisioning key, never an installation administrator, who could otherwise switch a gate off, grant or issue, and
switch it back. Every protection change of an environment writes both gates in one call under the environment's
deployment lease, carrying the environment's protection revision, and IAM ignores a revision older than the one it
holds, so a caller that lost the lease cannot undo its successor's gates. Control writes the stricter side first, gate
by gate: a change that tightens either gate writes IAM the stricter of before and after (at the revision its own write
will reach) before its own row, and the looser side after its row, at the row's revision. A failed first write
changes nothing (502); a failed second write leaves IAM the stricter (502). Nothing reverts IAM after a failed Control
write: a failure in between leaves IAM stricter while the console may say it is not, the console reports it, and the
next protection change converges both. A new environment's gates reach IAM before its row, as it starts and at its
starting revision (registration, and an `apps.environments.put` that creates one): a key that acts in every environment
of an application counts only the environments IAM knows, so a `prod` IAM did not know would not count. One that starts
protected is not created when IAM does not take them (503). Control's maintenance pass writes the gates of every
environment IAM has not taken at its current protection revision (`iam_gate_mirrors` records what IAM took), so a new
environment whose write failed, a failed second write and an installation upgraded to the `credentials` mirror converge
with no operator step; until then IAM reads an environment it knows and holds no mode for as `person`. A platform audience is refused: no grant at the console or IAM
waits. `grants` waits when its mode is `person`.

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

This gate stays as it is beside the agent's requests. **An agent's grant** (`agent-grants`, the request kind
`iam.grants.create`) is one role at one application environment, for the agent's own principal or another one: an
agent's own credential comes from the device flow and holds nothing at an application, so asking for itself is the
common case, and the person sees for whom. The role must be one the environment's approved contract declares (not
IAM's built-in `admin`, not a custom policy), granted application-wide or in a value of its dimension as the contract
says, and the grant ends at most 30 days after it is asked for. The requester holds `access.request` at the
application; the request binds the principal (its label and its grants at the application) and the role as the
approved contract declares it, so a change of either before the execution closes it `stale`. Control reads that with
its provisioning key, so only the deciders see it, never the requester; and a principal IAM does not know is not refused
when the request is created, so asking tells the agent nothing about which principals exist. The application's IAM
administrators decide it (§8). An approval makes the grant as the approver's own console grant (`grants.create`), through the IAM
gateway's transport with the approver's console token, so IAM runs every check it runs for the console, and its
audit row names the Control request and its requester. Where the application's `grants` waits, IAM turns that call
into its grant request for a second administrator, on top of the request's approval: the request is then `executed`,
linking IAM's grant request, and is never executed again; IAM's request records the Control request, and its
approval's record names IAM's request. An execution whose outcome Control did not see is followed through IAM's
grants and open grant requests, read with the provisioning key. Under `off`, including an unprotected environment,
there is nothing to approve: an agent's credential grants nothing in IAM, so the request is refused (409) rather
than executed with the requester's authority (§3).

### 5. The console

The application's "Access approvals" section shows each protected environment's mode per category and its settings,
the defaults marked, with the strict and permissive presets and one save for a holder of `access.approve`. Loosening a
category asks for a confirmation, as turning approvals off does. Everyone else reads them. The Approvals page lists the
parked deploys, the open requests and the open grant requests the viewer may decide, and every item opens on its own
link, mobile-first: who asked (the person and the client), exactly what, against what it replaces, with text the agent
wrote escaped and marked as the agent's. The link is a read-only GET; only the page's POST decides. A grant form that
gets `pending` says the change waits for another administrator.

### 6. Who is a non-person

The gate counts as a person only a user principal without OAuth or link claims (`isPerson`) acting in a console
session, a request without an `Authorization` header: the rule of approving (ADR-0050 §5). Every bearer is a
non-person, a person's own `px_` key included, so an agent handed that key cannot pass the gate as its owner. A service
principal, the builder key (ADR-0042), the command-line client's device-grant token and an MCP token are non-persons.

### 7. The presets

A preset is a set of modes and settings that the console's modes page writes in one step, per environment. Neither is
a special case in the code, and every value stays editable afterwards.

- **Strict**, the default for a new installation and for an environment that becomes protected: the defaults of §1
  and §2. A team tightens it per category with `requesterMayApprove: false`, `approvers: 2` and `stepUp`.
- **Permissive**: every category `off`, `stepUp` `none` and `deployRequestCommits` `any`. The environment stays
  protected, so its access lines are still classified and recorded, and going back to strict is one step. An agent
  configures, deploys, writes secrets and runs data operations with no approval, with its own credential's authority
  and nothing more.

### 8. An approval request is the pending registry write

A deploy's pending item is its parked run (ADR-0050 §4–5). **Any other action of a non-person that waits is an
`approval_requests` row in Control**, IAM-owned actions included, because an agent reaches only Control's `/api/rpc`
and must have no path to IAM's administration. The service that executes the change keeps the request; for an IAM
action that is Control, which on approval calls IAM through its IAM gateway with the approver's console token, so IAM
checks the approver as it does today.

- **Inert and exact.** The row holds the kind and the canonical input with its SHA-256; the coordinates; the
  requester (principal, OAuth client id and grant id from the verified token); the **before-state** the action depends
  on (an environment's `generation` and the stored value or its digest, an `apps.update` patch's expected before-value
  per field, the provider target and artifact an `apps.environments.put` replaces, a restore's serving object and
  object list); the state, the decision, the result and an absolute deadline. Rows are never edited: a different
  action is a new request. A secret value is sealed in the vault under the request's own purpose, and the page shows
  its name, length and fingerprint (the first 8 hex characters of its SHA-256), which the agent prints beside the link.
- **The requester's right to ask** is checked when the request is created, from the requester's own token: the action
  itself, or `access.request` at the application for a grant or a key, which the agent cannot execute itself.
- **The decision** posts the request id and the digest it showed. It is one conditional update, `pending` → `approved`
  under a fresh decision id, checked against the deadline in the same write; a second tap changes nothing. The
  approver's right to execute is checked at decision time, and the action executes with the approver's authority and
  the requester recorded beside them. At execution, under the environment's lease, Control compares the bound
  before-state with the current one; a mismatch closes the request `stale`, and the agent asks again.
- **The lifecycle** is `pending → approved | rejected | expired`, then `executing (operation id) → executed | failed |
  unknown`, and `stale`. The operation id is recorded before any external effect: a secret the provider keeps binds
  the provider's own version of it (never the value, which a sensitive provider variable does not return), IAM's key
  issuance takes the request id as its idempotency key, and a data operation records its own steps (ADR-0069) under the
  request's operation id, so `unknown` retries or follows it. A provider secret is followed, never put again: an
  unchanged version says the value did not land, a moved one that it did.
- **Who approves.** A person in the console with the action's approval right (`access.approve` at the coordinates, the
  application's IAM administration for an IAM action: `iam.admin`, or `iam.users.manage` at that application
  environment, which Control asks IAM's `me` for with the person's console token; `access.approve` alone decides no IAM
  action). The person may approve their own agent's request, grants and keys
  included. `requesterMayApprove: false` makes someone other than the requester's person decide. A service key's request
  has no human owner, and no verified token names the key's issuer, so there it fails closed: nobody approves it, and
  anyone with the approval right may refuse it. `approvers: 2` takes two different people on the same digest; the item
  stays `pending` after the first, and a rejection by either closes it. Both apply to parked runs too, and the stricter
  among a change's categories wins. `stepUp: webauthn` makes the decision carry a passkey assertion bound to it: the
  approval page calls Control's `approvals.challenge` or `approvals.requests.challenge`, and Control calls IAM over its
  IAM client for a single-use challenge, bound to the item's kind, id and digest and to the decision; the page posts the
  assertion with the decision, and Control has IAM verify it with the approver's console token against the binding of
  the item it decides, and decides nothing otherwise. Changing a `webauthn` category's settings in the weaker direction
  takes a passkey too (§2). Neither the console token nor the proxy changes (ADR-0050 §5 says why).
- **Expiry.** Every pending item has an absolute deadline, `requestTtlHours` after it starts waiting: a request when it
  is created, a parked run when it parks. Past it the item is `expired`; a parked run that expires fails and deploys
  nothing. The sweep only cleans up; it authorizes nothing. The final approval executes in the same call, under
  the environment's lease, so an approval does not wait to expire: a policy made stricter since the request was made
  applies at that execution, where `gate()` and the deciders are judged again, and closes the request `stale`. An
  approved request whose execution never started (Control stopped in between) is closed `failed` by the sweep, nothing
  having changed, and the agent asks again.
- **Audit.** The row itself is the record of authority: requester, approver, decision id and times, written in the
  transition. `auth.audit` records follow as for any change.
- **Outcome.** Creating answers `{ id, url, state }`, the link `<console>/approvals/requests/<id>` (a parked run keeps
  `<console>/approvals/<run id>`). The agent reads the request's state; Fabrika sends no notification.

A key for someone else (`credentials`, the kind `iam.apiKeys.provision`) holds exact Control actions at one application,
scoped to it, never `access.approve` or an action Control checks only as a global grant (400, naming it), so it acts in every environment of the application and the strictest protected one judges it; where none
gates `credentials` (none is protected, or it is `off`) the request is refused (409), since an agent's credential issues
nothing in IAM. The agent sends the application, the actions, a label, an expiry at most 30 days ahead and a public
P-256 or X25519 JWK (a private one, another curve, a point no key agreement works with or a later expiry is 400). The stored input adds the key's RFC 7638
thumbprint, which the page shows and the agent prints beside the link, and the actions the requester's own token lacks
at the application: under `credentialCeiling: requester` such an action is refused when the request is created (403),
under `approver` the page warns of each. An IAM installation administrator decides it, since only `iam.admin` issues a
key, and the approver must hold every action of the key in Control. On approval Control calls IAM's
`apiKeys.provisionRequested` with the approver's console token and the request id as the idempotency key. IAM issues the
key as the approver, its audit row naming the request and the requester, enforces the 30-day ceiling, and answers the
key only encrypted to the agent's public key (compact JWE, `ECDH-ES` with `A256GCM`, the thumbprint as `kid`), so the
plaintext reaches neither the approver's browser nor Control. An `unknown` execution is followed by asking IAM for the
key under the request id with the provisioning key, so a retry never issues a second key. Control keeps the JWE until
the requester (the same principal through the same OAuth client, or through no client for a key) fetches it once with
`approvals.requests.fetchKey`, which deletes Control's copy; at the request's deadline, or an hour after the key was
issued when that is later, the sweep drops an unfetched one and revokes the key in IAM. IAM keeps its own copy of the
JWE under the request id, readable by `iam.admin` (`apiKeys.requested`) and useless without the private key. No DTO,
audit row or log line carries the JWE.

**IAM's direct path meets the same mode.** A `px_` key holding `iam.admin` issues keys without any person, so IAM's own
key issuance meets the `credentials` mode Control mirrors (§4) for every caller that is not a person in a signed-in
session (§6): `apiKeys.provision` and the REST `POST /admin/api-keys`, `apiKeys.rotate` (a new secret for the
principal's grants), `shareLinks.issue`, `workloads.issueKey`, `membershipKeys.issue`, and `issueKey` for a key for
someone else (a self-bound key is the caller's own identity). A key at an application environment takes its mode. A key
at Control's console audience acts in every environment of the application its `app` scope names, or of every
application under any other scope, and a cross-app key in every environment: such a key takes the strictest mode among
them. An environment IAM holds no mode for reads as `person`. Under `person` IAM answers 403 naming Control's request
path (`approvals.requests.create` of kind `iam.apiKeys.provision`, or `fabrika control access request-key`); under
`refuse`, 403. A person in the console issues as before. A key at IAM itself or Operations reaches no application and
keeps the installation's rule (§9). This is authorization in IAM's use cases, not an enforcement decision (ADR-0022).

A machine caller's grant to a key meets `credentials` too, since it widens a live credential as issuing one would:
`grants.create` and `grants.update` to a service principal judge the grant's reach by the same rules, before the grant
applies or waits as a grant request (§4). `policies.update` and `PUT /admin/apps/:app/schema` widen every holder of a
role at once; IAM does not judge whether one widens a key, so a machine caller is refused there wherever the
application's mode is `person` or `refuse`. A person and the provisioning key keep their rule on all four.

Two issuances keep their rule, both made with the provisioning key, the operator's own credential, which the check
exempts on every path: Control's own workload, membership and connector keys, which every deploy issues, and the
bootstrap `POST /admin/api-keys`, which makes the first machine caller before any console or key exists. A
non-provisioning key on that REST path meets the mode like any other caller.

`apiKeys.provision` takes an expiry at most 30 days ahead, as every other issuance does; a later one or none is refused
(400), not clamped, so the caller sees what it gets. The provisioning key is exempt: the local stack's machine key is
made with it and does not expire. Control's own workload and membership keys already take at most 30 days. A rotation
keeps the key's expiry, so an existing key is untouched; one that states a new expiry meets the same ceiling.

### 9. What no mode and no request reaches

These are not categories, and no mode or plan applies to them. They always take a person:

- the approval configuration itself (the flag, the modes, the settings), deciding a pending item, approving or revoking
  a plan entry;
- deleting a protected environment;
- installation administration in IAM (promotion, `iam.admin` grants, terminals, brand, password policy, bootstrap
  administrators, signing and vault keys, the provisioning key, the second-factor reset), which keeps its rule: a
  session where it needs one, and a `px_` key holding `iam.admin` where it accepts one, because a person chose to give
  that key `iam.admin`. Issuing a key is not installation administration where the key acts at an application: there it
  meets the application's `credentials` mode (§8). A key at IAM itself or Operations keeps this rule;
- source connections and builder pairing, a browser flow anyway.

No request may name any of them, nor these, which keep the rule they have today: namespace removal and claim release
(ADR-0034 frees resources the next application could adopt with their old secrets), reading data content (an approval
would deliver production content to the agent), and anything that would return a secret to the agent in a form Control
could read. A request of such a kind is refused when it is created (400 naming the kind), not at approval.

Every mutation of Control's router and of IAM's `/admin/rpc` is either gated by a category or listed as exempt with its
reason. A table test over both routers fails when a new mutation is neither. IAM's table gates every issuing mutation,
a grant to a key and the change of a role or policy by `credentials` (§8), a grant beside its `grants`, and lists the
provisioning key's two exceptions with their reason, and it checks that each gated one refuses a machine `iam.admin`
key under `person`. No mode applies to the installation's own
resources, which keep their rule: namespaces and the mail gate (`namespace.manage` and `mail.manage`, global, which no
command-line preset carries), and IAM's named policies and an application's return origins (`iam.admin`), save that a
machine caller's edit of a policy meets `credentials` (§8).

### Rollout

Each category takes effect only from the change that adds the requests it waits in: `deploy-request` with the parked
non-person run; `secrets`, `variables`, `data` and `registry` together, once their writes with an external effect go
through requests (decision D8); `agent-grants` with the agent's grant request; `credentials` with keys for others,
behind the WebAuthn step-up, and on IAM's direct path once the request exists to send a machine caller to. A hole is
closed by routing a write through a request, never by refusing it outright.

IAM's direct path converges with two additive migrations: IAM's `app_grant_approvals.credentials` (null) and Control's
`iam_gate_mirrors` (empty). From IAM's upgrade, an environment without a mode reads as `person`, so a machine caller
issues no key at an application environment until Control's first maintenance pass (every 5 minutes) writes each
environment's mode: the window fails closed, and no operator step is needed. An installation without the provisioning
key cannot write the mirror, and its IAM keeps reading `person`. From then on, `apiKeys.provision` takes an expiry at
most 30 days ahead; existing keys keep theirs.

Before D8 a non-person's secret, variable and data write applied at once, its write of the trigger ref, domain, public
origin or an application's source and build fields was refused, and its write of the cross-origin list, provider
target, artifact or namespace applied at once. From D8 on, an agent's secret, variable, data or registry write on a
protected environment waits for a person; setting those categories to `off` restores the earlier behaviour, and also
lets a non-person write the fields it was refused. An existing installation converges with no migration: an environment
whose policy is null reads the defaults, `person` for the four, from the upgrade on.

## Consequences

- An environment nobody configures behaves as under ADR-0050 for deploys: the closer-review categories wait, `plan`
  waiting for a person while no plan exists. An agent's action on it waits for a person, category by category as the
  requests land.
- An agent hands the person one link per pending item and learns the outcome by reading it; the person approves on a
  phone what the page shows, and nothing else can be approved through that link.
- A team that wants today's behaviour for secrets, variables and data sets those categories `off`; one that wants no
  agent deploys sets `deploy-request` `refuse`; one that trusts its agents applies the permissive preset.
- The `grants` choice lives in two stores, Control's environment and IAM's application, and so does `credentials`.
  Control writes both and the stricter one first, under a revision IAM orders by; a partial failure fails closed and is
  reported, and the next protection change or Control's maintenance pass repairs it. Nothing else can write IAM's rows.
- Approving a console grant takes a second IAM administrator. An installation with one administrator cannot approve its
  own grants; it sets the category `off` first, which takes `access.approve` and is audited.
- A request records the client that asked, not the task: until agent task keys add an `act` claim, the OAuth client id
  is the attribution.
- The gate decides what the platform's APIs do. On Cloudflare a deploy's executor runs with the account's credentials
  beside the repository's code (ADR-0048), so code in a deployed commit can still reach the account; the gate does not
  close that.
- **Rollout.** Every change is additive: the policy and settings columns (null), the request table (empty), IAM's
  passkeys (empty), IAM's `credentials` column (null) and Control's `iam_gate_mirrors` (empty). An existing environment reads the defaults, converted from the categories it chose. Behaviour that
  changes on an existing installation, each when its requests land: a person's own `px_` key stops passing the
  protected-environment checks and its manual deploy parks; parked runs start to expire, a run parked before the
  upgrade getting its deadline when the sweep first sees it; a non-person's secret, variable, data and registry write
  on a protected environment waits for a person; deciding a `credentials` item takes a passkey, and so does unprotecting
  an environment or loosening its `credentials` (the first passkey needs only the session); a machine key holding
  `iam.admin` that issues keys meets the `credentials` mode, refused everywhere until Control's first maintenance pass
  mirrors it, and `apiKeys.provision` takes an expiry at most 30 days ahead. No generated file and no environment variable changes.
  One operator step, for `planEvidence: console+github` only: an existing GitHub App gets the user-authorization
  callback URL and a client secret in its GitHub settings, documented in `docs/reference/` when that evidence is
  built; without it reviews count for nothing and console approvals still work.
  Rolling Control back below the policy reads the old column, and the deploy gate falls back to its categories; a run
  classified under a non-default choice stores it, which an older Control's strict classification reader refuses, so
  that run classifies again or fails. Rolling IAM back leaves requests unread, grants ungated and its key issuance unjudged by `credentials`; rolling
  Control back leaves IAM's `credentials` as last written until that older Control writes an environment's gates (a
  protection change), which carries no mode and sets it to null: IAM then reads that environment as `person`, never a
  looser mode left behind, and a machine caller issues no key there until Control is upgraded again.

## Alternatives considered

- **One switch per kind of change, outside the protection flag.** Rejected: the flag also governs who deploys a
  protected environment (ADR-0050 §4); categories without it would split that rule in two.
- **On/off per category.** Rejected: a closer-review line that a pull request's reviewer already approved would still
  wait, and a team that wants no agent deploys could not say so. Four ordered modes say both.
- **Store the chosen list as is.** Rejected: a category a later release adds would not apply to any environment that
  ever saved a choice. The difference from the defaults keeps new defaults on.
- **Keep the grant gate only in IAM, set from IAM's console.** Rejected: whoever may grant would also switch the gate
  off; changing it takes `access.approve` in Control, a separate authority, like the flag.
- **Let anyone with Control's `access.approve` approve a console grant.** Rejected: IAM decides grants and does not
  resolve Control's vocabulary; an IAM administrator of the application is who may make the grant.
- **Refuse a non-person's secret, variable and data writes on a protected environment.** Rejected: an agent that is
  refused works around the refusal; a request lets the person say yes from a phone.
- **One-action tokens through the device flow (RFC 9396 `authorization_details`), or a CIBA backchannel.** Rejected:
  the approval would happen in IAM without Control's access diff, end as a bearer credential the agent carries, and
  need a comparison per procedure and a spent-token table. A stored request in Control binds the exact action.
- **A standing pre-approval** ("this agent may deploy prod for four hours"). Rejected: it defeats protection.
- **A link to a prefilled console form for grants and keys.** Rejected: the person would type the change again, and
  the agent would learn the outcome only from the person.
- **Let an agent decide a pending item under the permissive preset.** Rejected: under strict it would void the
  approval, and under permissive nothing waits.
- **An installation level of defaults and floors.** Deferred: the environment level answers today's needs; it adds a
  one-row table and a floor in `gate()` later without changing the environment level.
- **Gate membership assignments and invitations.** Rejected: they are the application's own behaviour, decided by
  its contract's `assignableBy`, and a prompt per invitation would stop the application.
