---
id: 153
title: Only the generated endpoint tests stand in for IAM's membership writes
blocked-by: []
---

# 153 — Only the generated endpoint tests stand in for IAM's membership writes

**Summary.** `kitMembership` answers scope creation, member management and share links under IAM's rules, but only
the endpoint access kit boots with it. `testKit` and the policy isolation kit refuse every write, so an application
that manages members cannot test it, and a table that names its dimension's `members.manage` fails its generated
policy test. Effort: S–M.

## Problem

- `testKit` boots with `'refused'` (`packages/app/src/testing/kit.ts:158`–`:160`); only `standInIamKit`, used by
  `endpointAccessKit`, passes `'stand-in'`. `@fabrika/app/testing` does not export the stand-in
  (`packages/app/src/testing/index.ts`). The skill says to pass an own `IamMembershipRpc`
  (`references/tests.md:202`).
- `policyIsolationKit` boots its probe through `testKit` (`packages/app/src/testing/policy-isolation.ts:228`, `:379`).
  A table whose policy names a dimension's `members.manage` action gives a probe endpoint of that action, which
  `writesThroughIam` (`packages/app/src/testing/membership.ts:171`) marks as writing through IAM, and boot throws
  `BootError`. tsc and `fabrika-check` pass.
- An application built on the paved road wrote its own four-call stand-in (no rule checks) with an `accept` helper,
  and moved its member log table to the dimension's manage action plus `unscoped` writes (a declared deviation).

## Approach / acceptance

- `testKit(app, { membership: 'stand-in' })` (or the default when the contract writes through IAM) boots with
  `kitMembership`, and the kit exposes accepting an invitation as a test step.
- `policyIsolationKit` boots its probe with the stand-in.
- Witness: an application test that invites, accepts and removes a member through the stand-in; the policy test of a
  table that names `members.manage` passes.

## Touch points

`packages/app/src/testing/{kit.ts,index.ts,membership.ts,policy-isolation.ts}`, `packages/app/skill/references/tests.md`.
