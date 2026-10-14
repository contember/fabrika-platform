---
id: 156
title: A member directory has no sign-in time and no list across values
blocked-by: []
---

# 156 — A member directory has no sign-in time and no list across values

**Summary.** `ctx.members.list(ref)` answers one value's members and open invitations, with no last sign-in. A staff
overview of every partner organization cannot show who signed in or who accepted. Effort: M.

## Problem

- `MemberItem` (`packages/auth-core/src/membership.ts:244`–`:254`) holds the principal, label, e-mail, roles, the
  disabled flag and the affiliation; no sign-in time.
- The directory is per value and only under the dimension's `members.manage`
  (`docs/reference/application-runtime.md:605`–`:612`). A list of values cannot ask it for each without one IAM call
  per value.
- An application built on the paved road shows each person as active, invited or disabled, and on the overview only
  the count of people it invited, not whether one of them signed in.

## Approach / acceptance

- Decide whether IAM serves a member's last sign-in, and to whom (it is personal data).
- Decide whether a global holder of `members.list` gets one call over many values (bounded, paged).
- Witness: the directory of the test kit answers the new field, and a staff overview lists per-value counts in one call.

## Touch points

`packages/auth-core/src/membership.ts`, `packages/iam/src/membership.ts`, `packages/app/src/implement/membership.ts`,
`packages/app/src/testing/membership.ts`.

<!-- Related: 91 (an organizational directory), 126 (a global-grant application has no people). -->
