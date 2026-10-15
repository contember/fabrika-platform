---
id: 173
title: The skill's test recipes leak a file's globals and render outside act
blocked-by: []
---

# 173 — The skill's test recipes leak a file's globals and render outside `act`

**Summary.** Two places where an application that follows the skill's text gets a slow suite or a noisy one. Effort:
S (text and one helper).

## Problem

- **`spyOn(globalThis, 'fetch')` for an outbound stand-in.** `tests.md` recommends it
  (`packages/app/skill/references/tests.md:305`). E-mail no longer needs it (`kit.mail`), but any other outbound
  dependency does. An application built on the paved road traced a
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

## Approach / acceptance

- Rewrite the stand-in recipe to assign `globalThis.fetch` and restore it in `afterAll`, with one line on why not
  `spyOn`. Before that, reproduce the retention once with a few kit-booting files under `--isolate`. If the kit can
  take a stand-in `fetch` for outbound calls instead, prefer that. Witness: no `spyOn(globalThis` left in
  `packages/app/skill/`.
- Make the screen-test example render, unmount and click inside `act`, or export small `render`/`click` helpers from
  `@fabrika/app/react/testing` that do so, and use them in the example. Witness: a `testing.test.tsx` case that
  renders, clicks and unmounts prints no act warning (capture `console.error`).

## Touch points

`packages/app/skill/references/{tests.md,spa.md}`, `packages/app/src/react/testing.ts`,
`packages/app/src/react/__tests__/testing.test.tsx`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
