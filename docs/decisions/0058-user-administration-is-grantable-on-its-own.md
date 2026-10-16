---
id: 0058
title: User administration is grantable on its own, and stops at the installation
status: accepted
date: 2026-10-15
---

# 0058 — User administration is grantable on its own, and stops at the installation

## Context

An operator wants a person who manages the people of the installation's applications. That person invites people,
disables them, signs them out, sends them a password link, and gives them roles in the applications, possibly only in
one application. That person must not deploy, read secrets, triage in Operations, or administer IAM. Today IAM cannot
express this.

- **IAM administration is one action.** Every `/admin/rpc` procedure requires `iam.admin`
  (`packages/iam/src/admin/router.ts:42`, `packages/iam/src/admin/rpc.ts:41-203`). It is resolved at IAM's own app id
  `propustka` (`router.ts:47`, `:121`), and only a global holding counts. The `/admin/*` REST surface checks the same
  action (`router.ts:179`). The one exception is `appPeople.*` (`rpc.ts:205-215`).
- **Only the built-in `admin` and a bootstrap mailbox hold it.** IAM registers no vocabulary for `propustka`: its
  config declares an empty schema (`packages/iam/fabrika.config.ts:235-236`). An installation registers only the
  console, `vozka` (`packages/provider-zerops/src/installation/deploy.ts:686-704` at HEAD,
  `packages/local-stack/src/app-registration.ts:54`). A grant must name a registered app
  (`packages/iam/src/admin/grant-support.ts:79-85`, `grants.ts:13-16`). A cross-app inline `iam.admin` fails the
  catalog check (`grant-support.ts:151-160`, `:177-188`). A cross-app grant names only a built-in role
  (`grant-support.ts:101-109`, `:141-144`). So `iam.admin` comes only from the built-in `admin` (`*`) or a bootstrap
  mailbox. Both also give everything on `vozka` and `operations` (`packages/iam/src/resolve.ts:100-104`).
- **`iam.admin` reaches every application anyway.** Its holder sets return origins (`rpc.ts:107-110`). It issues
  workload keys, membership keys (`rpc.ts:147-164`) and share links, and each acts at an application without a grant.
  So no role holding `iam.admin` can be narrower than the installation admin.
- **The installation's own apps are a registry.** `Config.platformAudiences` holds `propustka`, `vozka`, `operations`
  and every `ADMIN_AUDIENCES` entry (`packages/iam/src/services.ts:71-76`). Only a token for one of these apps carries
  cross-app grants and the bootstrap `admin` (`resolve.ts:269-290`). An application's id is `<app>@<env>`
  (`packages/auth-core/src/app-environment.ts:29-34`), so it never equals an installation app id.
- **`appPeople.*` already delegates per application.** It is
  [ADR-0022 rule 6](0022-the-proxy-is-the-only-enforcement-point.md#6-an-application-token-is-minted-for-one-application-in-one-environment).
  The application declares `members: { manage, list }`, and a person holding `manage` globally there grants that
  application's global roles. It grants only roles whose every action that person holds
  (`packages/iam/src/admin/app-people.ts:96-110`), never invites, and works from a signed-in session only.

The real question is where the user administrator's authority ends, and what stops it from becoming the installation
admin through a grant or a password reset.

## Decision

**IAM registers its own vocabulary under `propustka`, with one new action, `iam.users.manage`, optionally scoped to one
application. Its holder grants anything at the applications in its scope, nothing at the installation's own apps, and
acts only on people whose every grant it could have made.**

### 1. IAM's vocabulary

IAM's vocabulary is code in `@fabrika/iam-contract` (`IAM_APP_SCHEMA`), as the console's names live in
`@fabrika/control-contract`. Both providers and IAM import it:

- `displayName`: `Access`.
- One scope dimension: `app` (label `Application`). Its value is an application's IAM id, `<app>@<env>`.
- Two actions:
  - `iam.admin`: administer identity and access for the installation.
  - `iam.users.manage`: manage the people of applications.
- One preset role: `user-admin` → `iam.users.manage`.

There is no `iam-admin` role: a role holding `iam.admin` alone would be the installation admin by another name (see
Context). The built-in `admin` keeps working unchanged.

The installation registers `propustka` in the step that registers the console, with the same provisioning key:

- **Zerops:** the console registration of `platform deploy`.
- **Cloudflare:** the control-plane stage of `platform deploy`. A platform deploy is the installation's own trusted
  path, so it reconciles a component's schema with IAM directly. An application deploy still only reports its schema
  to Control. IAM cannot register itself in its own stage, because its signing and provisioning keys are synced after
  its Worker deploys.
- **The local stack:** beside the console.

No migration is needed: the next platform deploy adds the vocabulary, and existing grants are untouched.

### 2. Who holds it, and where

An operator with `iam.admin` grants `user-admin` at `propustka`:

- **Globally.** The holder manages people at every application that is not an installation app.
- **In `app` value X.** The holder manages people at application X only.

Nothing new is needed in resolution. A grant's scope is free-form and is not checked against the declared dimensions
(`grant-support.ts:115-124`). The user administrator's own grants at `propustka` resolve as they do today
(`router.ts:121`). IAM then asks the two functions behind `scopedTo()` (`packages/auth-core/src/permissions.ts:41-83`):

- `permits(perms, 'iam.users.manage', { type: 'app', value: X })`: may this caller manage people at X?
- `scopedValues(perms, 'iam.users.manage', 'app')`: which apps? `null` means all of them, and a list means only those.

The scope dimension is declared so that the console can offer it.

The procedure gate changes in one place. `.require(ADMIN_ACTION)` requires a global holding. A procedure open to user
administrators admits a caller that holds `iam.admin` globally, or holds `iam.users.manage` globally or in at least one
`app` value. Each use case then checks the specific app.

### 3. What it opens

| Opened to `iam.users.manage`                                         | Stays `iam.admin` only                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `me`                                                                 | `principals.promote`                            |
| `principals.list`, `get`, `invite`, `update`                         | `apps.setReturnOrigins`                         |
| `sessions.list`, `revoke`, `revokeAll`                               | `policies.create`, `update`, `delete`           |
| `passwords.issueEnrollment`, `issueReset`, `disable`                 | `apiKeys.*`, `workloads.*`, `membershipKeys.*`  |
| `grants.create`, `delete` of a person                                | `shareLinks.*`, a grant of an API key           |
| `apps.list`, `apps.getSchema`, `roles.list`, `policies.list` (reads) | `audit.*`, and the closed `/admin/*` REST paths |

The rules below apply only to a caller without `iam.admin`.

### 4. Grants: anything inside the scope, nothing at the installation

The caller creates or deletes a grant at app X only when all of these hold:

- X is a registered app.
- X is not in `Config.platformAudiences`.
- The caller holds `iam.users.manage` there (`permits` with scope `app: X`).

Within X, `grants.create` takes what it takes from an installation admin:

- any role X knows: a declared role, a custom policy, or the built-in `admin` (`*` at X);
- inline permissions from X's catalog;
- globally or in one of X's scope values.

The existing rules still apply. A contract application refuses a wildcard, so it also refuses the built-in `admin`
(`packages/iam/src/contract-rules.ts:31-53`). A membership role is granted only in its own dimension. An external
principal holds only external roles ([ADR-0051](0051-external-principals.md)).

The caller is refused:

- a cross-app grant (`app: null`);
- any grant at `propustka`, `vozka`, `operations` or another platform audience;
- deleting a grant there;
- creating or deleting a grant of a service principal. An API key's permissions are its principal's grants, so such a
  write edits the key, and keys stay `iam.admin`'s with the rest of `apiKeys.*`.

So a user administrator cannot make another user administrator; that stays with `iam.admin`.

**The caller does not need to hold what it grants.** This is safe because the authority it hands out cannot leave the
application:

- **An action means something only to its application.** A grant row at X counts only when IAM resolves permissions
  at X: `getActiveGrantsForApp` matches `app = X`, and cross-app rows only for a platform audience
  (`packages/iam/src/repositories/grants.ts:117-129`).
- **The built-in `admin` granted at X is `*` at X only.** It expands where X's grants resolve (`resolve.ts:85-98`,
  `packages/iam/src/roles.ts:17-19`). It never reaches another application, another environment of X, or the
  installation.
- **An action that X names `iam.admin` is X's own string.** IAM resolves its administration at `propustka`
  (`router.ts:121`), never at X.
- **The only grants that reach the installation are forbidden.** These are grants at a platform audience and
  cross-app grants. Nothing the user administrator hands out therefore reaches deploys, secrets, Operations or IAM.

The cost is plain. Within its scope, a user administrator is as powerful as each application's own admin, because it
can grant itself any role there. The operator grants exactly that.

### 5. Principals: only people whose every grant it could have made

The caller may invite a person, internal or external. An invitation admits that person past the OIDC allowlist's
known-principal bypass. That is the job, and the invited person holds nothing until a grant follows.

The caller acts on an existing principal (`principals.update`, `sessions.*`, `passwords.*`) only when every active
grant of that principal is one the caller could create under section 4. That excludes:

- anyone with a grant at an installation app, which covers deployers, console admins and Operations triagers;
- anyone with a grant at `propustka`, which covers every IAM administrator and every other user administrator;
- anyone with a cross-app grant;
- for a scoped caller, anyone with a grant at an application outside its scope;
- a bootstrap mailbox, which holds `admin` without a grant row;
- a service principal.

A principal with no grant, such as a fresh invitation, qualifies. The check reads the target's grants just before the
change. The one window is an installation admin granting the target an installation role in the same instant. For a
manual password URL, IAM checks again after issuing it, and withholds the URL if the target no longer qualifies.

**Password actions.** A user administrator issues an enrollment, a reset or a password disable only for a principal it
may act on. A reset of a deployer, a console admin or an IAM administrator is refused before any link exists. Delivery:

- **With an email sender**, every link goes by email to the principal's own mailbox.
- **Without one**, IAM returns the manual URL (`packages/iam/src/admin/passwords.ts:32-33`) to a user administrator only
  for an enrollment of a principal that has never signed in (status `invited`). That is onboarding. The account has no
  password and no history, and its grants are ones the caller could give an account of its own, by inviting its own
  mailbox. So the URL hands over nothing the caller lacks.
- **A reset of an existing account** is refused to a user administrator without email, and only `iam.admin` receives
  a reset URL. A reset URL signs its holder in as an established person. That gives no new authority, but it gives
  the person's identity: the records an application keeps for that person alone, and the person's name in the audit
  trail. "Never signed in" is stricter than "never set a password" for the same reason: a person who signs in only
  through OIDC has no password, but has a history.

The caller works from a signed-in session only, as in `appPeople`; a `px_` key administers only with `iam.admin`.

**Invariant:** user administration stops at the installation. A caller without `iam.admin` never writes a grant at a
platform audience or a cross-app grant. It never acts on a principal holding a grant it could not have written.

### 6. Relation to `appPeople`

The two mechanisms stay separate, because they bound different holders:

- **`appPeople` is authority the application gives its own staff.** Its `members.manage` is an action in the
  application's approved contract ([ADR-0050](0050-approved-access.md)). Its holder may be less than the application's
  admin, so it grants only what it holds, and it never invites.
- **`iam.users.manage` is authority the operator gives.** Its bound is the application boundary, not the holder's own
  roles.

Merging them would either let an application's staff grant themselves the application's `admin`, or bind the user
administrator by what it holds, which is the narrower design this ADR replaces. The procedures differ too: `appPeople`
works by mailbox with global roles, and a user administrator needs invitation, scoped roles, inline grants, sessions and
passwords. The admin RPC already has all of these.

The two meet in the console only.

### 7. Audit

- Every change already writes its `audit_events` row in its own transaction (`iam.grant.create`, `iam.principal.*`,
  `iam.password.*`), with the actor.
- The `iam.admin.access` row (`rpc.ts:233-243`) is written for every caller that passes an administrative gate,
  `iam.admin` or `iam.users.manage`.
- A login of a principal holding either action is `privileged = 1` in `auth_log`.
- Reading the audit log stays with `iam.admin`. `iam.audit.read` is deferred.

### 8. The console

`me` answers a user administrator. It already returns the caller's permissions (`MeDto`,
`packages/iam-contract/src/index.ts:333-338`). The dashboard reads those permissions instead of treating any answer from
`me` as an installation admin (`packages/dashboard/src/lib/iam.ts:56-66`).

A user administrator sees People in the Access section. It does not see keys, policies, share links or audit. The grant
form offers only applications that are not installation apps and that are in its scope.

The console shows one People area for both sources: the apps of `appPeople.apps`, and the apps of a user
administrator's scope.

## Consequences

- An operator grants `user-admin`, globally or for one application. That person onboards, offboards and assigns roles
  there, and holds no authority over the installation.
- A user administrator cannot touch the installation's own people. It cannot disable or reset a console admin, a
  deployer or an IAM administrator, so it cannot lock out the people above it. Making someone a user administrator,
  or giving someone a console role, stays an installation admin's job.
- **A person in two applications.** That person can be managed only by an unscoped user administrator, or by one
  whose scope covers both applications.
- Reads stay installation-wide. A scoped user administrator lists every principal, including their grants elsewhere, so
  that it can find a person to grant to. Only writes are scoped. A listing narrowed to the scope is
  [backlog 175](../backlog/175-a-scoped-user-administrator-lists-every-principal.md).
- An installation without an email sender cannot let a user administrator reset an existing person's password.
- `propustka` appears in `apps.list`.
- **The 409 risk.** The first registration cannot collide: a custom policy needs a registered app
  (`packages/iam/src/admin/policies.ts:69`), and `propustka` is not one today. After registration an admin can create a
  custom policy at `propustka`. If a later IAM release declares a role with the same key, that platform deploy fails
  with a 409 naming the key (`packages/iam/src/admin/app-schema.ts:119-135`), and renaming the policy fixes it. This is
  the existing rule for every app.
- `admin-rpc-gates.test.ts` gains the user-administrator procedures beside the `appPeople.*` exception.

- **Cloudflare registered nothing before this decision.** A platform deploy's `reconcile-schema` step only wrote a
  runner outcome file, which exists only inside the runner. So the scaffolded workflow's first stage, IAM, which
  declared an empty schema, stopped at that step, and the console's vocabulary never reached IAM. The fix applies a
  platform component's schema directly (section 1).

## Alternatives considered

### The grantor holds what it grants

Rejected. A pure user administrator could grant nothing, so onboarding would need the operator to make every user
administrator an admin of every application. The application boundary is the real limit, and section 4 enforces it.

### A cross-app inline `iam.users.manage` (or `iam.admin`) grant, with no registered vocabulary

Rejected. The catalog check refuses it today. Loosening the check leaves the action with no description, no preset, no
scope dimension and no place in the console.

### IAM's actions in the console's vocabulary

Rejected. IAM resolves administrative authority at `propustka` (`router.ts:121`), not at the gateway's audience, and
`ADMIN_AUDIENCES` may name more than one gateway. Reading `vozka` grants would make the console's `admin` role (`*`) an
IAM administrator. ADR-0022 keeps the two apart.

### A vocabulary built into IAM's code, with no registration

Rejected. The catalog, the role checks and the guarded grant writes (`eligibleGrantSql`) all read the `roles` and
catalog tables. A code-only vocabulary would be a second source of role truth.

### A scope per registry app (all environments of an app) instead of per IAM application

Deferred by decision. An IAM application is one environment, `<app>@<env>`, and that is what a grant names. Grouping environments
would need a new rule for matching scope values. Two scoped grants cover two environments.

### Extend `appPeople` instead

Rejected; see section 6.

### Split now into `iam.users.manage`, `iam.grants.manage` and `iam.audit.read`

Deferred. Nobody asked for grants without people or for audit alone. A later split needs only a vocabulary change and
a gate.

### An `iam-admin` role holding only `iam.admin`

Rejected. `iam.admin` sets return origins and issues workload, membership and share-link credentials, and each of
those acts at an application. Such a role would look smaller than `admin`, but it is not.
