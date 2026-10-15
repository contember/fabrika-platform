---
id: 172
title: A list of values cannot show each value's last sign-in
blocked-by: []
---

# 172 — A list of values cannot show each value's last sign-in

**Summary.** A staff list of a dimension's values (one row per company, say) cannot show when anyone of each value
last signed in without one IAM call per row and an action that manages the members. Effort: S–M; needs a privacy
decision first.

## Problem

A last sign-in is personal data, so IAM answers it only to a manager:

- **Per value**: `ctx.members.list(ref)` carries `lastSignInAt` only to a holder of the dimension's `members.manage` in
  that value (`packages/auth-core/src/membership.ts:258`, `:276`). A list endpoint of N values makes N calls and needs
  the manage action, not the list's own read action.
- **Across values**: the application directory lists every holder of a role, scopes included, but answers
  `lastSignInAt` only to the application's `members.manage` held globally (`membership.ts:330`, `:341`;
  `packages/app/src/implement/membership.ts:97`–`:125`). It also needs the vocabulary to declare application people
  (`members`), and an application whose people exist only per value does not declare them. Its pages hold 100
  principals, so a list of values still reads every page.

An application built on the paved road therefore showed the last sign-in on a value's detail page only and dropped the
column from the list.

## Approach / acceptance

- Decide what a list may see. The smallest answer: the latest sign-in **per value** (no principal, no address),
  answered to the holder of the dimension's `members.list` across the values it holds, in one IAM call. For a value
  with one member it still reveals that person's last sign-in; the decision must accept that or keep it with
  `members.manage`. Record it in [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md), whose rule "a
  member's last sign-in is personal data" (`:538`) it narrows.
- Then a `ctx.members` call (or a `Within` form of `list`) answering `{ value, lastSignInAt }[]` for the caller's
  values. Witness: a kit test with three values lists each value's latest sign-in in one call; a caller without
  `members.list` there is refused, and no principal id or address is in the answer. The stand-in IAM answers the same.

## Touch points

`packages/auth-core/src/membership.ts`, `packages/iam/` (the membership RPC), `packages/app/src/implement/membership.ts`,
`packages/app/src/testing/membership.ts`, `packages/app/skill/references/endpoint.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
