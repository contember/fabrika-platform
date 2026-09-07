---
id: opice
kind: technology
title: opice (AI-driven E2E browser tests)
slot: e2e-tests
provides: [e2e-browser-tests, acceptance]
requires: []
recommends: [bun]
conflicts: []
npm: ["@opice/harness@^0.6.1", "@opice/cli@^0.6.1"]
status: wip
sources:
  - where: "opice (repo) + `@opice/harness` / `@opice/cli` on npm (installed types)"
    read: "How browserTest/step/invariant work and how the harness runs under `bun test`. Read the installed types — do not guess."
  - where: "The opice-* skills (opice-plan / opice-author / opice-batch / opice-reeval)"
    read: "The authoring procedure: skeletons → authored steps → CI re-eval."
---

# opice

## What it is

The acceptance layer for fabrika: markdown scenarios → LLM-generated `*.test.ts`
under `tests/browser/` → deterministic `bun test` runs. `browserTest` + `step` +
`invariant`, with metadata (`url`, `seeds`, `roles`) that fabrika **induces issues
from**.

## When & why to use

- Always, in a fabrika builder build — opice skeletons are the contract every issue satisfies; `url`/`seeds`/`roles` drive foundation-issue induction.

## Impacts & gotchas

- **Skeleton metadata is a contract**: `url` → a route must exist; `seeds: ['x']` → `seeds/x.sql` must exist; `roles` → an auth foundation. fabrika `induce` unions these.
- Selector priority: **byRole → byLabel → getByText → el(testid)**. The app must be accessibility-first (every interactive element named, every section a heading) or opice-author has no stable selector.
- Runs against the **running** dev server (`APP_URL`); `bunx opice test <file>` for one, `bun test tests/browser` for all. WIP — read installed types.

## Relationships — why

- Standalone (no hard tech deps) — it tests whatever stack the app is built on; runs under **`bun test`** (recommends `bun`) and pairs with `named-seeds` for the seed contract.
