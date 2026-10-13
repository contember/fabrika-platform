---
id: 0051
title: External principals hold only roles declared external
status: accepted
date: 2026-10-13
---

# 0051 — External principals hold only roles declared external

## Context

An installation serves the organization's own staff, and some applications also give accounts to people outside it.
The driving case is an internal application whose partner companies get accounts: staff sign in through the
organization's OIDC provider, and each partner's people sign in with a password and see only their own company.

IAM had no way to tell those people apart. Every user principal was the same kind of thing, so three paths would give
a partner internal authority:

- **OIDC.** The callback claimed any principal with the IdP's verified mailbox and no `external_id`, a password-only
  one included, and a known principal skipped the human-admission allowlist. An IdP that presents a partner's address
  took over the partner's account.
- **The bootstrap mailbox.** The bootstrap `admin` was recognised by mailbox alone at resolution.
- **Administration.** An installation administrator could give any principal inline permissions, a custom policy, a
  cross-app grant or a built-in role.

The question is where "this person is from outside" lives, and what it forbids. Deriving it from the authentication
method or the mailbox domain fails both ways: staff may use a password, and a partner may share a domain with a
subsidiary.

## Decision

**Affiliation is an IAM fact about the person; eligibility is a contract fact about the role.**

- **The principal.** `principals.affiliation` is `internal` or `external`. Every existing row, and every service, is
  `internal`; the column's `CHECK` keeps a service internal. Two paths create an external
  principal: an installation administrator (`principals.invite` with `affiliation: 'external'`), and the acceptance of
  an application's invitation to a role declared external for a mailbox no principal holds, which creates it with its
  password and its grant in one transaction ([ADR-0020](0020-compose-human-authentication-methods.md)); IAM refuses
  such an invitation for a mailbox the organization names. An external principal becomes internal only through
  the administrator's `principals.promote`. Promotion writes no grant row, but it widens what the principal reaches:
  it may then hold any role, OIDC may claim it, and a mailbox listed in `IAM_BOOTSTRAP_ADMINS` makes it an
  installation admin at once. So in the change's own transaction it revokes every session the principal holds and
  spends its pending password actions, and `iam.principal.promote` records whether the mailbox is a bootstrap admin;
  the console warns before promoting one. There is no demotion.
- **The role.** A contract declares `external: true` on a membership role (`member: { scope, … }`): an external
  principal may hold it. `buildArtifact` refuses it on any other role, and IAM's schema parser refuses it again. The
  artifact carries it only when declared, so existing digests stay. IAM reconciles it into `roles.external`, whose
  `CHECK` admits it only on a membership role of `origin = 'app'`. The approval diff shows a role becoming external as
  a widening line and losing it as a removal.
- **The rule.** An external principal holds only grants of a role its application declares external: a grant of one
  application, of one role, never inline permissions, a custom policy, a built-in role or a cross-app grant. An
  internal principal may hold an external role too.

**Invariant:** An external principal holds only grants of a role its application declares external, and no grant
outside that rule ever contributes a permission to it — not the bootstrap `admin`, and not a cross-app grant.

The rule has three locks, like the membership-scope rule of
[ADR-0022 rule 6](0022-the-proxy-is-the-only-enforcement-point.md):

1. **Write.** Every grant-writing path carries the condition in the statement that writes, not only in a check
   before it: the admin `grants.create`, a membership assignment by principal id, an invitation's acceptance, scope
   creation's creator grant, and `createGrant`/`createRoleGrantUnlessHeld`. Each path names the reason first; the
   guarded write catches a reconcile that narrowed the role in between. On Postgres the condition reads the role row
   `FOR SHARE` and holds it to the write's commit, and a reconcile rewrites that row, so the two serialize: a grant
   write after a narrowing writes nothing, and a narrowing after a grant write meets its batch guard. An acceptance
   holds the row across both its statements, and rolls back, invitation and record included, if its grant writes
   nothing. An acceptance also writes only at the schema revision its authority check read, so a reconcile committed
   before it makes it write nothing too.
2. **Reconcile.** A schema that declares a role not external while an external principal holds it is a 409 naming
   the grants. A guard statement in the reconcile's own batch rolls back a narrowing a concurrent grant got past.
3. **Resolution.** In `computePermissions`, an external principal's grant that breaks the rule contributes nothing.
   An external principal is never a bootstrap admin and never sees a cross-app grant.

**Credentials.** An external principal issues only a key bound to itself, which resolves its live permissions at every
use. A service key, a standalone key and a device key hold authority of their own that would outlive the external role,
so `issueKey` refuses those modes for an external issuer, the credential's batch refuses it again, and device approval
and exchange admit only an internal approver, in the approving and claiming statements too. Share links stay under the
link mount's own contract.

**Authentication.** An external principal authenticates by password only
([ADR-0020](0020-compose-human-authentication-methods.md)). OIDC never claims an external principal and never creates
one: an IdP presenting its mailbox is refused with the fixed `LoginRefusal` `oidc_external_principal`, and the
allowlist's bypass for a known principal admits only an internal one. After promotion, OIDC may claim the row.

**What an application sees.** No new token claim and no endpoint marker. Endpoints require actions, and the external
role's actions in the partner's scope value are the boundary. The member directory (`listMembers`, `findMember`,
`ctx.members`) answers each member's `affiliation` so a staff UI can show who is external, and the console shows it on
the user list and detail. Because `{ member: true }` admits a holder of any permission of the application,
`fabrika-check` hints at every such endpoint in a contract that declares an external role: a staff-only surface names
an action only internal roles grant.

**Groups.** When org units and groups land (backlog 91), a group must not give an external principal an internal role
either: a group assignment is one more write path under lock 1.

## Consequences

- A partner's account cannot become staff by any path but an administrator's audited promotion.
- Every grant write carries one more `EXISTS` over `principals` and `roles`. The statements stay constant-width.
- A contract that admits externals says so per role, and the approval shows it.
- Narrowing a role that externals hold is a deliberate two-step: remove their grants, then deploy the narrowing.
- An administrator who wants to give an external person more must promote it first; nothing grows silently.
- An external principal is visible to the application that lists its members, which is the point: staff UIs need it.

## Alternatives considered

### Derive affiliation from the authentication method or the mailbox domain

Rejected. Staff may sign in with a password, and a partner may share a domain with the organization. The derived
signals stay guards (the OIDC refusal, the allowlist), not the source.

### Call it `audience`, or reuse `member`

Rejected. `audience` already means the token `aud`, `ADMIN_AUDIENCES` and the platform audiences, and `member` means
scoped membership. `affiliation` names the person's relation to the organization and nothing else.

### An affiliation claim in the token, or an endpoint marker for externals

Rejected. Endpoints require actions; a role that grants the partner actions in the partner's scope is already the
boundary, and a claim or marker would be a second place to decide the same thing. A requirement that staff never reach
a partner endpoint is a different one and would need its own decision.

### External-only roles

Rejected. Staff need the partner's view to support them. Eligibility admits externals; it does not exclude internals.

### Demotion

Deferred. Demoting would have to remove every incompatible grant atomically rather than leave them dormant; v1 has no
caller that needs it.
