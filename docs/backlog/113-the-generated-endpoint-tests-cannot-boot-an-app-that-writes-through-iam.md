---
id: 113
title: The generated endpoint tests cannot boot an application that writes through IAM
blocked-by: []
---

# 113 — The generated endpoint tests cannot boot an application that writes through IAM

**Summary.** An application with a `creates` endpoint, a `members.manage` endpoint or a share-link mount fails its
whole generated endpoint access test, because the kit it boots has no IAM stand-in for writes. Effort: M.

## Problem

`endpointAccessKit` boots the application with `testKit(app, { database, files })` and no `membership`
(`packages/app/src/testing/endpoint-access.ts:166`). The kit's own stand-in answers member directories only
(`packages/app/src/testing/directory.ts:33`, `:113`–`:116`), and `writesThroughIam` (`directory.ts:43`) gives a
contract that creates scopes, manages members or issues links no stand-in at all
(`packages/app/src/testing/kit.ts:197`). `boot` then refuses the contract (`packages/app/src/implement/boot.ts:752`),
so every generated case of the application fails, not only those of the writing endpoints. The application has no
slot to pass its own `IamMembershipRpc` into the generated test, which it may not edit.

What WU8 and WU22 cover: WU8 added the `own` case, seeds, the link-holder caller and the `in` + `sql` leak case;
WU22 made directory endpoints testable (a generated member, `get` and `list` from the kit's callers). Neither
reaches a write through IAM. A `creates` endpoint gets no case at all (`packages/check/src/scaffold.ts:134`), so the
gap is the boot, plus the cases of `on`/`in` endpoints whose action is `members.manage` or a link mount's
`issuedBy`. The skill says so under "Not built yet" (`packages/app/skill/SKILL.md:240`) and asks the agent to stop
and ask; the dogfood run recorded it as finding 6.

## Approach / acceptance

- The kit gets a membership stand-in for writes that IAM's rules bound: `createScope` for a `creates` endpoint,
  `assignMember`/`revokeMember` under the dimension's `members.manage` and the role's `assignableBy`, and
  `issueLink`/`revokeLink` under the mount's `issuedBy`, each checked against the test caller's grants. It records
  what it was asked; it is not IAM and grants nothing to the kit's callers.
- `endpointAccessKit` uses it, so such an application boots and its existing cases run; a `members.manage` and an
  issuing endpoint get the same `denied`/`leaked`/`own` cases as any `on`/`in` endpoint.
- Decide: whether a `creates` endpoint gets a case (a caller without the creation action is refused).
- Witness: the isolation fixture (`packages/cli/src/__tests__/fixtures/isolation-app/`) gains a `creates`, a
  `members.manage` and a link endpoint and its regenerated tests pass; `SKILL.md`'s "Not built yet" line goes.

## Touch points

`packages/app/src/testing/{directory.ts,kit.ts,endpoint-access.ts}`, `packages/check/src/scaffold.ts`,
`packages/cli/src/__tests__/fixtures/isolation-app/`, `packages/app/skill/{SKILL.md,references/tests.md}`.

<!-- Origin: the paved-road sprint, WU10's trial app and the dogfood finding 6. -->
