---
id: 123
title: A form field that is no inbox column passes tsc and the checker
blocked-by: []
---

# 123 — A form field that is no inbox column passes tsc and the checker

**Summary.** A form's input field must be named exactly like a column of its inbox. tsc and `fabrika-check` accept a
mismatch, and it first fails at boot, in `bun test`. Effort: S.

## Problem

`inboxProblems` (`packages/db/src/store.ts:1230`–`:1243`) refuses a form whose input field is not a column of its
inbox: `the input field 'firstName' of 'register' is not a column of its inbox registrations`. The data layer
runs it at boot (`:1163`). Nothing before boot checks it. `c.form('<path>', { input, appendTo })` takes any input
schema for any inbox, and the checker compiles the contract against the table policies, which name no columns. So
the agent used camelCase field names, as every RPC input in the skill has, over snake_case columns. tsc passed, the
checker passed, and the first failure was the whole test run. The recipe's forms have one-word fields only
(`packages/app/skill/references/public-intake.md`), so the skill never shows the rule.

## Approach / acceptance

- `c.form` types `input` against the inbox's columns. `appendTo` already names a table of `tables`, whose columns
  come from `schema.generated.ts`. A field outside them is an `Unavailable` that names the inbox and its columns,
  except the `honeypot` field and the challenge token.
- The contract compile refuses the same mismatch, so `fabrika-check` reports it in a file it reads without tsc.
- Witness: a `kit-mistakes` case for the type error and a checker test for the finding. The recipe gains a multi-word
  field ([121](121-the-skills-gaps-found-by-the-private-dogfood.md)).

## Touch points

`packages/app/src/contract/{define.ts,build.ts}`, `packages/db/src/store.ts`, `packages/check/src/contract.ts`,
`packages/app/src/__tests__/kit-mistakes/`, `packages/app/skill/references/public-intake.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
