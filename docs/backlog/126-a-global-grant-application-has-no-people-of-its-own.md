---
id: 126
title: A global-grant application has no people of its own
blocked-by: []
---

# 126 — A global-grant application has no people of its own

**Summary.** An application whose roles are all global grants gets no member directory and no role management of its
own. It cannot name the author of a change from a directory, and its administrator cannot grant its roles inside the
application. Effort: M; it needs a decision first.

## Problem

- **No directory.** `ctx.members` exists only under a dimension that declares `members`
  (`packages/app/src/contract/context.ts:235`–`:241`). A role without `member` is a global grant that an administrator
  gives in IAM (`packages/app/skill/references/public-intake.md`, the `hr` role). The handler knows only
  `ctx.principal` (`{ id, label }`), whose label is the token's label at request time
  (`packages/app/src/implement/principal.ts:50`). The dogfood stored the principal id with the label as it was when the
  person acted, beside each status change, note and withdrawal. That snapshot is right for an audit row, but the
  application cannot show a current name or list its staff.
- **No role management in the application.** A role's `assignableBy` exists only on a membership role
  (`packages/app/src/contract/define.ts:78`–`:79`). The application's own administrator ("manages users and roles")
  therefore has nothing to call. In-app member management needs a dimension with `members`.

## Approach / acceptance

Decide one of these:

- **(a) Delegated IAM administration per application.** IAM lets a holder of an application-admin role grant and
  revoke that application's global roles, in IAM's console, audited by IAM. The application builds nothing. The
  member directory is a `members.list` over the principals that hold any of the application's roles, under a
  declared directory reach.
- **(b) One organisation value.** The skill's recipe for a single-tenant application declares one top-level dimension
  with `members`, and the roles become membership roles with `assignableBy`. This needs 113, and it makes every endpoint
  carry a scope that has one value.

(a) fits the single-tenant case without an invented scope, and it overlaps
[91](91-add-an-organizational-directory-to-iam.md). (b) works with what exists once 113 lands.

- Witness: the public intake recipe names an author from the directory, and its administrator grants the staff role
  through the chosen path, with an audit row in IAM.

## Touch points

`packages/iam/` (admin API and console), `packages/app/src/contract/{context.ts,define.ts}`,
`packages/app/src/implement/membership.ts`, `packages/app/skill/references/public-intake.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
