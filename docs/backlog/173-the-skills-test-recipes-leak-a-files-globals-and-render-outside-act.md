---
id: 173
title: The skill's test recipes leak a file's globals and render outside act
blocked-by: []
---

# 173 — The skill's test recipes leak a file's globals and render outside `act`

**Summary.** Three places where an application that follows the skill's text gets a slow suite, a noisy one, or a
checker hint the skill tells it to ignore. Effort: S (text and one helper).

## Problem

- **`spyOn(globalThis, 'fetch')` for an outbound stand-in.** `tests.md` recommends it
  (`packages/app/skill/references/tests.md:296`), and `public-intake.md`'s `standInMail` uses it
  (`packages/app/skill/references/public-intake.md:1397`, `:1418`). An application built on the paved road traced a
  suite that slowed down file by file under `bun test --isolate`, until server tests hit the 5 s timeout, to this spy.
  Bun's spy keeps the global object it patched, so each file's booted application, kit and SQL clients stay alive
  until the run ends. `mockRestore()` did not help; a plain assignment of `globalThis.fetch`, restored in `afterAll`,
  kept the run flat (about 600 s with failures before, about 150 s green after). This was measured in that
  application, not reproduced here.
- **The screen-test example renders outside `act`.** `installDom` sets `IS_REACT_ACT_ENVIRONMENT`
  (`packages/app/src/react/testing.ts:57`). `type` and `waitForText` wrap their work in `act` (`testing.ts:125`,
  `:140`), but `spa.md`'s example calls `root.render` and `root.unmount` directly
  (`packages/app/skill/references/spa.md:719`), and nothing wraps a click. Each prints "An update to … was not wrapped
  in act(...)".
- **The skill and the checker disagree on a "test e-mail to yourself".** `public-intake.md` builds it as a
  `{ member: true }` endpoint that calls the provider (`public-intake.md:1346`, `:1359`; also `endpoint.md:60`–`:65`).
  In an application with an external role, `fabrika-check` hints `member-admits-external` on it and suggests
  `{ action, app: true }` (`packages/check/src/rules/contract.ts:62`–`:69`). An endpoint the generated tests cover may
  not call the provider, so following the hint breaks the generated cases. The application resolved it with a
  staff-only endpoint that records an outbox row a job sends.

## Approach / acceptance

- Rewrite the stand-in recipe to assign `globalThis.fetch` and restore it in `afterAll`, with one line on why not
  `spyOn`. Before that, reproduce the retention once with a few kit-booting files under `--isolate`. If the kit can
  take a stand-in `fetch` for outbound calls instead, prefer that. Witness: no `spyOn(globalThis` left in
  `packages/app/skill/`, and the skill's own recipe tests (if any cover `standInMail`) pass.
- Make the screen-test example render, unmount and click inside `act`, or export small `render`/`click` helpers from
  `@fabrika/app/react/testing` that do so, and use them in the example. Witness: a `testing.test.tsx` case that
  renders, clicks and unmounts prints no act warning (capture `console.error`).
- Show the staff-only outbox form as the recipe for a test e-mail when the application declares an external role, and
  keep `{ member: true }` only where every member is internal; make the checker's `allowed` text point at that recipe.
  Witness: the recipe's contract passes `fabrika-check` with no `member-admits-external` hint.

## Touch points

`packages/app/skill/references/{tests.md,public-intake.md,spa.md,endpoint.md}`, `packages/app/src/react/testing.ts`,
`packages/app/src/react/__tests__/testing.test.tsx`, `packages/check/src/rules/contract.ts`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
