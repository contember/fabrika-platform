---
id: 118
title: Member labels are nullable under a labels directory
blocked-by: []
---

# 118 — Member labels are nullable under a labels directory

**Summary.** `ctx.members` types every member's `label` as `string | null`, also where the dimension declares
`directory: 'labels'` and IAM always answers one, so every caller writes a fallback for a case that cannot occur.
Effort: S.

## Problem

`DirectoryMember.label` and `Member.label` are `string | null` (`packages/app/src/implement/membership.ts:40`, `:50`),
as is the wire type `MemberItem.label` (`packages/auth-core/src/membership.ts:178`). The context types pick
`MemberDirectory` or `MemberLookup` by the action alone (`packages/app/src/contract/context.ts:235`–`:241`); they do
not read the dimension's `directory`. Yet where a dimension declares `directory: 'labels'`, IAM answers a label to
every `members.list` and lookup caller, and a principal's label is `NOT NULL` in IAM
(`packages/iam/migrations-postgres/0001_init.sql:27`).

The CRM shows the cost: its `org` dimension declares `directory: 'labels'` (`examples/crm/src/vocabulary.ts:6`), yet
`orgs.members` declares `label: z.nullable(z.string())` (`examples/crm/src/orgs/endpoints.ts:7`), and `picked`
stores `member.label ?? member.principalId` (`examples/crm/src/orgs/logic.ts:8`), a branch no test can reach.

## Approach / acceptance

- The context types read the nearest directory's `directory` from the kit's dimensions: under `'labels'`,
  `get` answers `{ label: string }` and `list()` items carry `label: string`; elsewhere `label` stays `null` for a
  lookup caller (and `string | null` for a `members.manage` holder only if IAM can still answer null there).
- At runtime the framework refuses an IAM answer without a label under a labels directory (a `ServerFault`, like
  `iam_answer_mismatch`), so the type is not a promise the runtime breaks.
- Witness: a `kit-mistakes` case where `label.length` under a labels directory compiles and the same line elsewhere
  is refused; a `members-lookup` test of the refusal; the CRM drops its fallback and nullable schema.

## Touch points

`packages/app/src/contract/context.ts`, `packages/app/src/implement/membership.ts`,
`packages/app/src/__tests__/kit-mistakes/`, `packages/app/src/__tests__/members-lookup.test.ts`,
`examples/crm/src/orgs/`, `packages/app/skill/references/endpoint.md`.

<!-- Origin: the paved-road sprint, WU11 and WU22 (the CRM's owner and assignee pickers). -->
