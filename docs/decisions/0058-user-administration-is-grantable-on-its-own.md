---
id: 0058
title: User administration is grantable on its own, and never widens its holder
status: proposed
date: 2026-10-15
---

# 0058 — User administration is grantable on its own, and never widens its holder

## Context

An operator wants a person who manages users: invites them, disables them, signs them out, sends them a password
link, and gives them a role. That person must not deploy, read secrets, or administer IAM itself. Today IAM cannot
express this.

- **IAM administration is one action.** Every `/admin/rpc` procedure requires `iam.admin`
  (`packages/iam/src/admin/router.ts:42`, `packages/iam/src/admin/rpc.ts:41-203`), resolved at IAM's own app id
  `propustka` (`router.ts:47`, `:121`), global only. The `/admin/*` REST surface checks the same action
  (`router.ts:179`). The one exception is `appPeople.*` (`rpc.ts:205-215`), where an application's own administrator
  grants that application's roles.
- **Only the built-in `admin` and a bootstrap mailbox hold it.** IAM registers no vocabulary for `propustka`: its
  config declares an empty schema (`packages/iam/fabrika.config.ts:235-236`), and an installation registers only the
  console, `vozka` (`packages/provider-zerops/src/installation/deploy.ts:686-704` at HEAD,
  `packages/local-stack/src/app-registration.ts:54`). A grant must name a registered app
  (`packages/iam/src/admin/grant-support.ts:79-85`, `grants.ts:13-16`). A cross-app inline `iam.admin` fails the
  catalog check, because no registered app declares it (`grant-support.ts:151-160`, `:177-188`). A cross-app grant
  names only a built-in role (`grant-support.ts:101-109`, `:141-144`). So `iam.admin` comes from the built-in `admin`
  (`*`) or a bootstrap mailbox, and both also give everything on `vozka` and `operations`
  (`packages/iam/src/resolve.ts:100-104`; platform audiences in `packages/iam/src/services.ts:71`).
- **Grant creation does not check the grantor.** `createGrantUseCase` records `grantedBy` and checks nothing the
  grantor holds (`grants.ts:7-75`). This is safe today only because every `iam.admin` holder already holds `*`.
- **`iam.admin` reaches every application anyway.** Its holder sets return origins (`rpc.ts:107-110`), issues workload
  and membership keys (`rpc.ts:147-164`) and share links. Each of those acts at an application without a grant. So
  `iam.admin` cannot be made smaller than the installation admin by itself.
- **A precedent exists.** `appPeople.*` lets a person grant only an application's declared global roles whose every
  action that person holds globally there (`packages/iam/src/admin/app-people.ts:96-110`,
  [ADR-0022 rule 6](0022-the-proxy-is-the-only-enforcement-point.md#6-an-application-token-is-minted-for-one-application-in-one-environment)).
  It never invites, and it accepts only a signed-in session.

The real question is the escalation path. A user administrator who can create grants can grant itself `admin`. A user
administrator who can reset a password can take over the account of a person who holds more.

## Decision

**IAM registers its own vocabulary under `propustka`. One new action, `iam.users.manage`, opens the people surface of
`/admin/rpc`. Its holder only gives what it holds and never acts on an IAM administrator.**

### 1. IAM's vocabulary

IAM declares its vocabulary in code in `packages/iam`, like the console's `controlSchema`
(`packages/control/fabrika.schema.ts:23-73`):

- `displayName`: `Access`.
- Actions: `iam.admin` (administer identity and access for the installation) and `iam.users.manage` (manage people
  and pass on what you hold).
- One preset role: `user-admin` → `iam.users.manage`.

There is no `iam-admin` role. `iam.admin` reaches every application (see Context), so granting it alone is the
installation admin with an extra step. The built-in `admin` keeps working unchanged, cross-app or at `propustka`.

The installation registers `propustka` with the same call and the same provisioning key that register the console,
on every path: Zerops `platform deploy`, Cloudflare `platform deploy` (IAM's own `fabrika.config.ts` declares the real
schema), and the local stack. No migration is needed: the next platform deploy adds the vocabulary, and existing
grants are untouched.

### 2. What `iam.users.manage` opens

| Opened to `iam.users.manage`                                         | Stays `iam.admin` only                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `me`                                                                 | `principals.promote`                            |
| `principals.list`, `get`, `invite`, `update`                         | `apps.setReturnOrigins`                         |
| `sessions.list`, `revoke`, `revokeAll`                               | `policies.create`, `update`, `delete`           |
| `passwords.issueEnrollment`, `issueReset`, `disable`                 | `apiKeys.*`, `workloads.*`, `membershipKeys.*`  |
| `grants.create`, `delete`                                            | `shareLinks.*`                                  |
| `apps.list`, `apps.getSchema`, `roles.list`, `policies.list` (reads) | `audit.*`, and the closed `/admin/*` REST paths |

`iam.admin` keeps every procedure. A procedure open to both checks the narrower rules below only when the caller lacks
`iam.admin`.

### 3. The no-escalation rules

A caller that holds `iam.users.manage` and not `iam.admin`:

1. **Grants only what it holds.** It creates a grant only of a role an application declares (never a built-in, a
   custom policy or inline permissions), at a registered app (never cross-app), whose every permission it holds at
   that app, globally or in the grant's scope, resolved live there. This is the `appPeople` check, applied to every
   registered app, `propustka` included. A user administrator can therefore make another user administrator, and
   nothing more.
2. **Revokes only what it could grant.** A grant it could not create under rule 1 it cannot delete. It cannot strip
   an administrator.
3. **Never acts on an IAM administrator.** It does not disable, sign out, or issue or disable a password action for a
   principal that holds `iam.admin` or `iam.users.manage` at `propustka`: an installation admin, a bootstrap mailbox,
   or another user administrator. It does not act on a service principal. Only `iam.admin` manages IAM's administrators.
4. **Never receives a password link.** A password action it issues is delivered by email only. Without configured
   email, IAM refuses it; the manual URL (`packages/iam/src/admin/passwords.ts:32-33`) stays `iam.admin`'s, because
   the URL sets the target's password.
5. **Acts from a session only, under the authority it checked.** As in `appPeople`, a `px_` key administers only with
   `iam.admin`. A grant or a revoke writes only while the caller's grant revision and the app's schema revision are
   the ones its check read; otherwise it writes nothing and answers 409.

**Invariant:** user administration never widens its holder. A caller without `iam.admin` writes only grants of
declared roles whose every action it holds there, and never acts on a principal that holds an IAM action.

`principals.invite` stays open to a user administrator. An invitation admits a person past the OIDC allowlist's
known-principal bypass, and admitting people is the job. The invited principal holds nothing until a grant follows,
and that grant is bounded by rule 1.

### 4. Audit

- Every change already writes its `audit_events` row in its own transaction (`iam.grant.create`,
  `iam.principal.*`, `iam.password.*`), with the actor.
- The `iam.admin.access` row (`rpc.ts:233-243`) is written for every caller that passes an administrative gate:
  `iam.admin` or `iam.users.manage`.
- A login of a principal holding either action is `privileged = 1` in `auth_log`.
- Reading the audit log stays `iam.admin`'s.

### 5. The console

`me` answers a user administrator. It already returns the caller's permissions (`MeDto`,
`packages/iam-contract/src/index.ts:333-338`). The dashboard reads them instead of treating any `me` answer as an
installation admin (`packages/dashboard/src/lib/iam.ts:56-66`). The Access section shows People to a user
administrator, and hides keys, policies, share links and audit. The role picker offers only the roles rule 1 admits;
IAM answers that list, so the console does not compute it.

## Consequences

- An operator grants `user-admin` at `propustka`, and that person onboards and offboards people without any other
  authority.
- **A user administrator passes on only what it holds.** To let one hand out the console's `deployer`, the operator
  also grants that person `deployer`. A pure user administrator invites, disables and resets, and grants only
  `user-admin`.
- A user administrator can disable or sign out a console admin who holds no IAM action. That is a lockout,
  not an escalation, and it is part of the job. It cannot touch an IAM administrator.
- An installation without email cannot let a user administrator issue password links.
- `propustka` appears in `apps.list`. An external principal cannot hold `user-admin`: it is not declared external
  ([ADR-0051](0051-external-principals.md)).
- **The 409 risk.** The first registration cannot collide: a custom policy needs a registered app
  (`packages/iam/src/admin/policies.ts:69`), and `propustka` is not one today. After registration, an admin can
  create a custom policy at `propustka`. If a later IAM release declares a role with the same key, that platform
  deploy fails with a 409 that names the key (`packages/iam/src/admin/app-schema.ts:119-135`). Renaming the policy
  fixes it. This is the existing rule for every app.
- Splitting further later costs only a vocabulary change and a gate: for example `iam.audit.read`, or grants without
  the people lifecycle.
- Unlike Operations ([backlog 54](../backlog/54-give-operations-its-own-proxy-app-identity.md)), nothing moves. IAM
  already resolves administrative authority at `propustka` and not from the console token's audience
  (`router.ts:121`).

Follow-on work, after acceptance, is one backlog item: the vocabulary and its registration on all three paths, the
gates and rules 1–5 with a test per refusal, the audit changes, and the console's People view and role picker. Its
first check is the Cloudflare path: a platform component's `reconcile-schema` step only writes a runner outcome file
(`packages/provider-cloudflare/src/provider.ts:326-340`), and the scaffolded workflow sets none
(`packages/provider-cloudflare/src/collaborators.ts:142-148`), so how the console's vocabulary reaches IAM on
Cloudflare is not yet confirmed.

## Alternatives considered

### A cross-app inline `iam.users.manage` (or `iam.admin`) grant, with no registered vocabulary

Rejected. The catalog check refuses it today. Loosening the check leaves the action without a description, a preset
or a place in the console, and the grant would cross every platform audience.

### IAM's actions in the console's vocabulary

Rejected. IAM resolves administrative authority at `propustka` (`router.ts:121`), not at the gateway's audience, and
`ADMIN_AUDIENCES` may name more than one gateway. Reading `vozka` grants would make the console's vocabulary the source
of IAM's authority, and the console's `admin` role (`*`) would become an IAM administrator. ADR-0022 keeps the two
apart.

### A vocabulary built into IAM's code, with no registration

Rejected. The catalog, the role checks and the guarded grant writes (`eligibleGrantSql`) all read the `roles` and
catalog tables. A code-only vocabulary is a second source of role truth.

### Split now into `iam.users.manage`, `iam.grants.manage` and `iam.audit.read`

Deferred. Nobody asked for grants without people or for audit alone. Each extra action is one more gate to reason
about, and adding one later needs no migration.

### A user administrator who manages people but not grants

Rejected. Onboarding without a role is not managing users. Rule 1 makes grants safe.

### A user administrator who grants any declared role, except to itself

Rejected. It invites a second account it controls and grants that account the console's `admin`.

### Grants limited to applications other than IAM

Rejected. It does not stop escalation: the console's `admin` role reaches deploys and secrets.

### `appPeople` at `propustka`

Rejected. `appPeople` manages one application's own roles and never invites. A user administrator needs every
application's roles and the people lifecycle. Its check is reused as rule 1.

### An `iam-admin` role holding only `iam.admin`

Rejected. `iam.admin` sets return origins and issues workload, membership and share-link credentials, each of which
acts at an application. A role holding `iam.admin` alone would look smaller than `admin` but is not.
