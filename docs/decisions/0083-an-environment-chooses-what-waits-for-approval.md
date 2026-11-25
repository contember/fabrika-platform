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

The other categories are actions with no deploy line. Each judges an action of a **non-person** (§3); a person acting
in the console is their own evidence, as before:

| Category         | Covers                                                                                                                                                                       | Default  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `deploy-request` | a manual run of the environment started by a non-person (ADR-0050 §4)                                                                                                        | `person` |
| `secrets`        | `apps.secrets.put/delete`, `vault.set/rotate/delete`, `rotateTokenKey`, the all-environments layer included                                                                  | `person` |
| `variables`      | `apps.variables.put/delete`, the all-environments layer included                                                                                                             | `person` |
| `data`           | `data.start` (maintenance modes, side restore), `data.recover`, suspend and resume, the backup schedule                                                                      | `person` |
| `registry`       | the trigger ref, domain and public origin, `apps.update`'s source and build fields, and `apps.environments.put`'s cross-origin list, provider target, artifact and namespace | `person` |
| `agent-grants`   | a grant an agent asks for at the application                                                                                                                                 | `person` |
| `credentials`    | a key an agent asks for, issued to someone other than the agent (§7)                                                                                                         | `person` |
| `grants`         | a person's own console grant, grant edit or revocation in IAM (§5)                                                                                                           | `off`    |

A write to the all-environments layer (`env: null`) is a write to every protected environment of the application, and
the strictest of their modes applies; the request names them all.

### 2. The modes and the gate

- `off`: nothing is needed. The change applies at once and is recorded. A non-person's action then runs with the
  **requester's** own authority, so `off` never lets an agent do what its credential cannot.
- `plan`: a covering plan entry, or a person's decision on the pending item. A change the plan does not cover waits for
  the person, who sees only the uncovered lines.
- `person`: only a person's decision on this pending item. A plan never counts.
- `refuse`: a non-person may not do it at all, not even by asking (403). The behaviour before requests existed.

The modes are ordered `off < plan < person < refuse`, and a change waits until the evidence satisfies the strictest
mode among its categories. **One function decides**, `gate(changes, policy, plan)` in `@fabrika/control-contract`,
answering `pass`, `wait` with the uncovered lines and the strictest mode, or `refuse`. Control's deploy gate, the
request path and the console all call it; it replaced `waitsForApproval`. An unprotected environment has every category
`off`.

Not every mode fits every category. `plan` applies only to the deploy categories, the ones a pull request carries;
`refuse` only to a non-person's action; `grants` takes `off` or `person`. Saving any other pair is refused with a 400,
so the gate never meets a mode it cannot decide.

A plan entry binds the content of one subject of the snapshot before and after, never a pull request. Until plans are
built, no entry exists, and `plan` waits for a person exactly as `person` does: today's approval of a parked run.

### 3. Who is a non-person

The gate counts as a person only a user principal without OAuth or link claims (`isPerson`) acting in a console
session, a request without an `Authorization` header: the rule of approving (ADR-0050 §5). Every bearer is a
non-person, a person's own `px_` key included, so an agent handed that key cannot pass the gate as its owner. A service
principal, the builder key (ADR-0042), the command-line client's device-grant token and an MCP token are non-persons.

### 4. The choice and its settings are stored with the environment

`app_envs.approval_policy` holds a mode per category as its difference from the defaults, so a category a later
release adds applies to every environment that did not set it. Null is the defaults. It succeeds
`app_envs.approval_categories`, the earlier list of added and removed categories, which is still written beside it so
a Control rolled back reads it as before: an added category converts to `person`, or `plan` for a closer-review one
other than `deletes-data`; a removed one to `off`; null stays null.

The settings are nullable columns beside it, null reading as the default. Each lands with the step that first uses it:

| Setting                | Default                                        | Alternative                                                                     |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `deployRequestCommits` | `merged`                                       | `any`: an unmerged commit may be requested, still never a workspace ref         |
| `requestTtlHours`      | 24, for requests and parked runs               | 1–168                                                                           |
| `requesterMayApprove`  | `true`, per category, grants and keys included | `false`: someone other than the requester's person decides                      |
| `approvers`            | 1, per category                                | 2: two different people decide, each on the same digest                         |
| `stepUp`               | `webauthn` for `credentials`, `none` elsewhere | `webauthn` or `none` for any category                                           |
| `credentialCeiling`    | `requester`                                    | `approver`: up to the approver's own rights, the page warning what exceeds them |
| `planEvidence`         | `console`                                      | `console+github`, once the access-diff GitHub check is built                    |
| `planBinding`          | `transition`                                   | `after-state`                                                                   |
| `planTtlDays`          | 30                                             | 1–365                                                                           |

The policy and the settings are kept in `app_env_protection` with the `protected` flag, so a recreated environment
starts from the choice its deleted predecessor left (ADR-0050 §4). They apply only while the environment is protected.
They change through `apps.environments.protect`, under the rules of the flag: `access.approve` at the coordinates, a
person in the console, the environment's deployment lease, a refusal while a run is `running`, and one audit row
(`access.protect`, with the policy before and after). The change advances `protection_revision` and `generation`, so a
run classified under the old choice classifies again. There is no installation level of defaults or floors yet.

### 5. The presets

A preset is a set of modes and settings that the console's modes page writes in one step, per environment. Neither is
a special case in the code, and every value stays editable afterwards.

- **Strict**, the default for a new installation and for an environment that becomes protected: the defaults of §1
  and §4. A team tightens it per category with `requesterMayApprove: false`, `approvers: 2` and `stepUp`.
- **Permissive**: every category `off`, `stepUp` `none` and `deployRequestCommits` `any`. The environment stays
  protected, so its access lines are still classified and recorded, and going back to strict is one step. An agent
  configures, deploys, writes secrets and runs data operations with no approval, with its own credential's authority
  and nothing more.

### 6. A console grant waits as a grant request

IAM keeps whether an application's grants wait, per IAM application id `<app>@<env>` (`app_grant_approvals`), because
IAM is where a grant is written. Control is the only writer, and IAM enforces that: `grantApproval.set` answers only
the provisioning key, never an installation administrator, who could otherwise switch the gate off, grant, and switch
it back. Every protection change of an environment sets the gate under the environment's deployment lease, carrying
the environment's protection revision, and IAM ignores a revision older than the one it holds, so a caller that lost
the lease cannot undo its successor's gate. Control writes the stricter side first: a change that leaves grants waiting
writes IAM (at the revision its own write will reach) before its own row, one that releases them writes its own row
before IAM. Nothing reverts IAM after a failed Control write: a failure in between leaves IAM gating while the console
may say it does not, the console reports it, and the next protection change converges both. A platform audience is
refused: no grant at the console or IAM waits. `grants` waits when its mode is `person`.

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

This gate stays as it is beside the agent's requests: an agent's grant (`agent-grants`) is executed as the approver's
console grant, so where the application's `grants` waits, IAM opens its grant request for a second administrator on
top of the request's approval.

### 7. An approval request is the pending registry write

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
  unknown`, and `stale`. The operation id is recorded before any external effect: a provider secret put is idempotent
  by name and value, IAM's key issuance takes the request id as its idempotency key, and a data operation records its
  own steps (ADR-0069), so `unknown` retries or follows it.
- **Who approves.** A person in the console with the action's approval right (`access.approve` at the coordinates, the
  application's IAM administration for an IAM action). The person may approve their own agent's request, grants and
  keys included. `requesterMayApprove: false` makes someone other than the requester's person decide; a service key's
  request has no human owner, so there it means anyone but the key's issuer. `approvers: 2` takes two different people
  on the same digest; the item stays `pending` after the first, and a rejection by either closes it. Both apply to
  parked runs too, and the stricter among a change's categories wins. `stepUp: webauthn` makes the decision take a
  console token whose `amr` names `webauthn`, at most five minutes old.
- **Expiry.** Every pending item, a parked run included, has an absolute deadline set when it is created:
  `requestTtlHours` after it. The sweep only cleans up; it authorizes nothing. An approval does not expire, and a
  policy made stricter after it applies at execution, where `gate()` runs again.
- **Audit.** The row itself is the record of authority: requester, approver, decision id and times, written in the
  transition. `auth.audit` records follow as for any change.
- **Outcome.** Creating answers `{ id, url, state }`, the link `<console>/approvals/requests/<id>` (a parked run keeps
  `<console>/approvals/<run id>`). The agent reads the request's state; Fabrika sends no notification.

A key for someone else (`credentials`) is issued by IAM on approval and encrypted there to a public key the agent sent
with the request (JWE, `ECDH-ES` with `A256GCM`), so the plaintext reaches neither the approver's browser nor Control's
database; the agent fetches it once. It is no wider than the requester by default (`credentialCeiling`), lives at most
30 days, and is revoked when it is not fetched by the deadline. IAM enforces the `credentials` mode on its own key
issuance for a machine caller too, mirrored from Control stricter side first as the grant gate is, so a `px_` key
holding `iam.admin` meets the same mode. Two issuances keep their rule: the provisioning key's own (workload,
membership and connector keys) and the bootstrap `POST /admin/api-keys`.

### 8. What no mode and no request reaches

These are not categories; they always take a person, and a request naming one is refused when it is created (400):

- the approval configuration itself (the flag, the modes, the settings), deciding a pending item, approving or revoking
  a plan entry;
- deleting a protected environment;
- installation administration in IAM (promotion, `iam.admin` grants, terminals, brand, password policy, signing and
  vault keys, the provisioning key, the second-factor reset), which keeps its rule: a session where it needs one, and a
  `px_` key holding `iam.admin` where it accepts one, because a person chose to give that key `iam.admin`;
- source connections and builder pairing, a browser flow anyway;
- namespace removal and claim release (ADR-0034), reading data content, and anything that would return a secret to the
  agent in a form Control could read.

Every mutation of Control's router and of IAM's `/admin/rpc` is either gated by a category or listed as exempt with its
reason. A table test over both routers fails when a new mutation is neither.

### 9. The console

The application's "Access approvals" section shows each protected environment's mode per category and its settings,
the defaults marked, with the strict and permissive presets and one save for a holder of `access.approve`. Loosening a
category asks for a confirmation, as turning approvals off does. Everyone else reads them. The Approvals page lists the
parked deploys, the open requests and the open grant requests the viewer may decide, and every item opens on its own
link, mobile-first: who asked (the person and the client), exactly what, against what it replaces, with text the agent
wrote escaped and marked as the agent's. The link is a read-only GET; only the page's POST decides. A grant form that
gets `pending` says the change waits for another administrator.

### Rollout

Each category takes effect only from the change that adds the requests it waits in: `deploy-request` with the parked
non-person run; `secrets`, `variables`, `data` and `registry` once their writes with an external effect go through
requests; `agent-grants` with the agent's grant request; `credentials` with keys for others, behind the WebAuthn
step-up. Until then a non-person's secret, variable and data write applies at once and its registry write is refused,
as before. A hole is closed by routing a write through a request, never by refusing it outright.

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
  reported, and the next protection change repairs it. Nothing else can write IAM's rows.
- Approving a console grant takes a second IAM administrator. An installation with one administrator cannot approve its
  own grants; it sets the category `off` first, which takes `access.approve` and is audited.
- A request records the client that asked, not the task: until agent task keys add an `act` claim, the OAuth client id
  is the attribution.
- The gate decides what the platform's APIs do. On Cloudflare a deploy's executor runs with the account's credentials
  beside the repository's code (ADR-0048), so code in a deployed commit can still reach the account; the gate does not
  close that.
- **Rollout.** Every change is additive: the policy and settings columns (null), the request table (empty), IAM's
  passkeys (empty). An existing environment reads the defaults, converted from the categories it chose. Behaviour that
  changes on an existing installation, each when its requests land: a person's own `px_` key stops passing the
  protected-environment checks and its manual deploy parks; parked runs start to expire, a run parked before the
  upgrade getting its deadline when the sweep first sees it; a non-person's secret, variable, data and registry write
  on a protected environment waits for a person; deciding a `credentials` item takes a passkey; a machine key holding
  `iam.admin` that issues keys meets the `credentials` mode. No generated file and no environment variable changes.
  Rolling Control back below the policy reads the old column, and the deploy gate falls back to its categories; a run
  classified under a non-default choice stores it, which an older Control's strict classification reader refuses, so
  that run classifies again or fails. Rolling IAM back leaves requests unread and grants ungated.

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
