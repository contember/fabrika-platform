---
id: 168
title: The error union drops the refusal's type
blocked-by: []
---

# 168 — The error union drops the refusal's type

**Summary.** A page cannot tell a failed challenge from any other 400 and cannot map a field error by its issue code.
Effort: S–M.

## Problem

- **`toFabrikaError` drops the refusal's `type`.** It reads `type` only to detect `auth`
  (`packages/app/src/react/errors.ts:68`); every other 400 is `{ kind: 'validation', fields }`. A form refused with
  `challenge_failed` (`packages/app/src/implement/dispatch.ts`, `#challenge`) carries no issues, so it reads as a validation
  error with empty `fields`, the same as a handler's own `BadRequestError`. A page that must ask the visitor to solve
  the challenge again has to guess.
- **The issue `code` is lost.** The server sends each issue as `{ path, code, message }` (`dispatch.ts:969`), but
  `issuesOf` keeps `path` and `message` only (`errors.ts:39`). The messages are the schema library's English texts. A
  page in another language therefore keeps a message table per form and per input path, instead of one table by code.

## Approach / acceptance

- Carry the refusal's `type` on every member of `FabrikaError` (or add a `challenge` kind), and carry each issue's
  `code` beside its message (`fields` stays the first message per path). Witness: a `hooks.test.tsx` case maps a
  `challenge_failed` 400 and a handler's 400 to distinguishable values, and a validation 400 keeps each issue's code.

## Touch points

`packages/app/src/react/{errors.ts,hooks.ts}`, `packages/app/src/client/`, `packages/app/src/react/__tests__/`,
`packages/app/skill/references/{public-intake.md,spa.md,errors.md}`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
