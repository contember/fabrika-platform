---
id: 152
title: The test kit serves no SPA build
blocked-by: []
---

# 152 — The test kit serves no SPA build

**Summary.** `kit.browser(caller)('/admin/')` answers an empty document, and there is no local run of a contract
application. Clicking through an application's screens needs a hand-written harness. Effort: M.

## Problem

- The kit's `serve` stub answers `<!doctype html><title></title>` for every SPA (`packages/app/src/testing/kit.ts:135`);
  the built `dist/` is never served. The skill does not say so.
- `fabrika` has no `app dev`: nothing serves the SPAs with the API behind a local proxy and IAM.
- An application built on the paved road tested its views as pure mappings and its calls through the typed client,
  and clicked through the screens with an uncommitted harness that served `dist/` and forwarded the API to
  `kit.browser(caller)`, one port per caller.

## Approach / acceptance

- The kit serves an SPA's `dir` when it exists, as the deploy does, so a test reads the built page.
- Decide whether `fabrika app dev` (the kit behind a local port, with a caller picker) is in scope, or whether the
  skill documents the harness.
- Witness: a kit test that fetches the built `index.html` of an SPA through `kit.browser(caller)`.

## Touch points

`packages/app/src/testing/kit.ts`, `packages/cli/src/`, `packages/app/skill/references/tests.md`.
