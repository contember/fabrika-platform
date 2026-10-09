---
id: 102
title: A contract application cannot hand its browser the Operations DSN
blocked-by: []
---

# 102 — A contract application cannot hand its browser the Operations DSN

**Summary.** The browser SDK of a contract application has no way to learn `FABRIKA_OPERATIONS_DSN` and
`FABRIKA_RELEASE`, so browser error reporting works only in an application without a contract. Small effort.

## Problem

- `serveContract` takes every `FABRIKA_*` variable out of the process before the application loads, and `deps`
  receives only the application's own variables (`packages/app/src/implement/environment.ts`). No handler can
  return the DSN, and a contract application has no raw route that could.
- `boot` uses the DSN only for `connect-src` and the job reports (`packages/app/src/implement/boot.ts`). The SPA mount
  serves static files and injects nothing.
- `docs/reference/application-runtime.md` ("Browser error reporting") allows an application to pass the two values to
  a browser. The Zerops example did that at `/operations-sdk` until it moved to the contract; the witness now lives in
  the local stack as an application without a contract (`packages/local-stack/src/operations-witness/`).

## Approach / acceptance

- The framework serves the two browser-safe values to a signed-in SPA, for example as a generated
  `<prefix>/__fabrika-config.json` of each `c.spa` mount, and nothing else of the environment.
- Witness: the Zerops example's SPA initializes `@sentry/browser` from it; `tests/browser/operations-sdk-ingest.test.ts`
  runs against the example again, and the local-stack witness is deleted.

## Touch points

`packages/app/src/implement/` (dispatch of `spa`), `packages/app/skill/SKILL.md`, `examples/zerops-app`,
`packages/local-stack/src/operations-witness/`, `tests/browser/operations-sdk-ingest.test.ts`.

<!-- Origin: A17b of the application framework plan (docs/archive/sprint-2026-10-09-a-m4-companions.md). -->
