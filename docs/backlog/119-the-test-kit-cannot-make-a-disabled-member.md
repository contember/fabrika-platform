---
id: 119
title: The test kit cannot make a disabled member
blocked-by: []
---

# 119 — The test kit cannot make a disabled member

**Summary.** The test kit's member directory answers `disabled: false` for every member, so an application cannot
test the branch that refuses a disabled member it was handed. Effort: S.

## Problem

IAM lists a disabled principal with `disabled: true` (`MemberItem.disabled`,
`packages/auth-core/src/membership.ts:182`), and an application that assigns a picked person must refuse one: the
CRM's `picked` throws for `member.disabled` (`examples/crm/src/orgs/logic.ts:7`). The kit's stand-in directory
hard-codes `disabled: false` in both `list` (`packages/app/src/testing/directory.ts:71`) and `findMember` (`:102`),
and `TestCallerOptions` (`packages/app/src/testing/caller.ts:20`) has no way to disable a caller. So the CRM tests an
outsider, an unknown id and a forged label, but not a disabled member.

A global grant, the trial's other test-kit finding, is already possible: a grant without `scope` is global
(`caller.ts:15`), and an `over` endpoint then gets a `Within` of `'all'`
(`packages/app/src/implement/dispatch.ts:569`). WU10b documents that form in the skill; it adds no kit API.

## Approach / acceptance

- `kit.disable(caller)` (or `testCaller(grants, { disabled: true })`): the directory then lists and finds the
  caller with `disabled: true`, and the kit's IAM refuses to mint for its credentials, as IAM does for a disabled
  principal.
- Witness: a `test-kit.test.ts` case for both answers and the refused request; the CRM's `deals.assign` and
  `tasks.create` tests (`examples/crm/src/__tests__/crm.test.ts`, `src/deals/__tests__/deals.test.ts`) gain the
  disabled-member case (400); `references/tests.md` shows the form.

## Touch points

`packages/app/src/testing/{caller.ts,directory.ts,kit.ts}`, `packages/app/src/__tests__/test-kit.test.ts`,
`examples/crm/src/{__tests__,deals/__tests__}/`, `packages/app/skill/references/tests.md`.

<!-- Origin: the paved-road sprint, WU11 part 3 (the fresh-agent trial). -->
