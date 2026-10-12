---
id: 121
title: The skill's gaps found by the private dogfood
blocked-by: []
---

# 121 — The skill's gaps found by the private dogfood

**Summary.** A fresh agent built a public intake application (a candidate registration module of one of our projects)
from the application skill alone. Where the skill was silent or wrong, it found the answer by probing tsc or the
runtime. Each entry below is a documentation fix; none changes behaviour except the one type export. Effort: S.

## Problem

Each entry was checked at `debb4e58`. The reference files are under `packages/app/skill/`.

- [ ] **A reference table's policy.** `references/table-and-migration.md:196`–`:198` names `{ reference: '<why>' }`
      only. `ReferencePolicy` requires `actions: { read }` (`packages/db/src/policy.ts:97`–`:100`), so the documented
      form fails tsc with `Property 'actions' is missing`. Fix: add a reference table (a code list) to the example
      policies, with `actions: { read: '<action>' }`, and say it takes no other key.
- [ ] **The handles of a reference and a child table.** `ctx.db.reference.<table>` has `list` and `count` only
      (`packages/db/src/orm-types.ts:353`–`:356`). A child table has `list`, `get`, `insert`, `update(key, values,
      { expectVersion })` and `remove`, and no `getForUpdate` (`orm-types.ts:295`–`:307`). `references/endpoint.md:77`
      says "a child table's `list`, `get`" and "child writes". Fix: list each handle's methods, and show a reference
      lookup by id as a `list` with a `where` on `id`.
- [ ] **A form's answer.** `references/public-intake.md:11` says a form answers `{ received: true }`; the body is
      `{ result: { received: true } }` (`packages/app/src/implement/dispatch.ts:670`, `:684`, `:748`, `:782`).
      `references/files.md:37` says a collection's `list` answers `{ items, next }`; it answers the same envelope.
      Fix: write the real bodies, or say once that every answer is wrapped in `result`.
- [ ] **A challenge token is single use.** A second submission with the same token answers 400 `challenge_failed`,
      also when the test's `challengeFetch` answers success (`packages/app/src/implement/challenge.ts:4`). Fix: say so
      in `references/tests.md`, and make each test submission send a fresh token.
- [ ] **How a test stands in for an outbound dependency.** `TestKitOptions` (`packages/app/src/testing/kit.ts:50`–`:73`)
      has no `deps` override. The checker refuses `Bun.serve` in a test file (`forbidden-global`). What works:
      `env` points the dependency at a test URL, and `spyOn(globalThis, 'fetch')` answers that URL only. Fix: show
      that form in `references/tests.md`, or decide to add a `deps` override (then this becomes code).
- [ ] **The types the kit options take.** `IamMembershipRpc` (from `@fabrika/auth-core`), `ChallengeFetch` and
      `FileScanner` (from `@fabrika/app/implement`) are not exported by `@fabrika/app/testing`
      (`packages/app/src/testing/index.ts:6`–`:7`), and the skill gives none of their shapes. The agent derived them
      from `Parameters<typeof testKit>[1]`. Fix: re-export the three types from `@fabrika/app/testing`, and name
      `clamscanScanner` (`@fabrika/app/bun`) as the real scanner in `references/tests.md:194`.
- [ ] **One column, one write action.** A state that two actions change (a link holder confirms an address, a
      reviewer then moves the record) cannot be one column: `columns: { <column>: { write } }` gives a column one
      action (`references/table-and-migration.md:204`–`:205`). Fix: show the pattern of two columns (a verification
      column and a review status) and a derived status in `logic.ts`.
- [ ] **A form's submission time.** A form writes its input fields only, so the time of a submission is the job's
      `now()` unless the inbox has a column with `DEFAULT now()`. Fix: put such a column in the recipe's inboxes and
      say why. The evidence a form cannot record is [127](127-a-form-records-no-request-evidence.md).
- [ ] **A multi-word form field.** The recipe's forms have one-word fields only, so it never shows that a form's
      input field is named exactly like its inbox column (`first_name`, not `firstName`). Fix: add one such field to
      the recipe. The missing check is [123](123-a-form-field-that-is-no-inbox-column-passes-tsc-and-the-checker.md).
- [ ] **Counting clicks on a public page.** There is no event primitive. What works is an anonymous form without a
      challenge that appends one row per click to its own inbox, posted with `keepalive`. Anyone can inflate the
      counts, and nothing drains the inbox. Fix: describe the pattern and both limits in `references/public-intake.md`,
      or say that an application should not count clicks.
- [ ] **An inbox read through `ctx.sql`.** It needs no scope fragment and works under the inbox policy's `read`
      action. Fix: one line in `references/endpoint.md`'s raw SQL section.
- [ ] **A `where` built from several optional filters.** Each tuple of a conditional spread needs `as const`
      (`...(x === undefined ? [] : [['title', 'ilike', pattern] as const])`); `references/endpoint.md:120` shows one
      conditional only. Fix: show two.
- [ ] **The formatter outside the platform repository.** `SKILL.md:227`–`:229` names the platform repository's dprint
      and biome. An application outside it has neither configuration, so the agent formatted nothing. Fix: say what an
      application outside the repository uses, or ship the two configurations with `references/start.md`.
- [ ] **Where logins and grant changes are audited.** The agent recorded "logins and permission changes are not
      visible to the application, and the skill says nothing". The first half is right. But IAM does audit both:
      logins in its auth log (`packages/iam/src/auth/sessions.ts:123`) and grants as `iam.grant.create`/`.revoke`
      admin events (`packages/iam/src/admin/audit.ts`). Fix: say so in the skill, so that an application does not
      try to rebuild either. Access by an operator to the database or the provider's console is outside fabrika.
- [ ] **A nullable foreign key outside the chain.** `references/tests.md:41` advises "give it a default or make it
      nullable". For a text column that is wrong today: the seed writes a marker into it anyway. Fix: correct the
      advice when [122](122-the-generated-tests-cannot-seed-a-foreign-key-outside-the-chain-or-name-a-child-row.md)
      lands, or before that, say that the column must not be text.

## Approach / acceptance

- Each entry is fixed in the reference file it names. Code samples are compiled by `skill-code.test.ts`, like the rest
  of the skill.
- The re-export of the three test types has a type-level test in `packages/app`.
- Witness: a fresh agent given only the skill builds the same kind of application without a tsc probe for any of these
  points.

## Touch points

`packages/app/skill/{SKILL.md,references/table-and-migration.md,references/endpoint.md,references/tests.md,`
`references/public-intake.md,references/files.md,references/start.md}`, `packages/app/src/testing/index.ts`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood; docs/sprints/sprint-2026-10-11-paved-road-framework.md). -->
