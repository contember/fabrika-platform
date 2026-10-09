---
id: 101
title: Two test files cannot both boot the application
blocked-by: []
---

# 101 — Two test files cannot both boot the application

**Summary.** An application's data layer binds once per process, and `bun test` runs every test file in one process
with one module registry. A test of the author's that boots the application on a database fails next to the
generated endpoint access test unless the run passes `--isolate`. Small effort.

## Problem

- `bind` throws on a second call: "the data layer is already connected" (`packages/db/src/store.ts:900`). An
  application exports one `scoped(tables)` from `src/db/database.ts`, and `boot` binds it
  (`packages/app/src/implement/boot.ts:291`).
- `testKit(app, { database })` boots the application (`packages/app/src/testing/kit.ts:116`). The generated
  `endpoint-access.test.ts` boots it too, through `endpointAccessKit` ("the application's layer is bound here and
  nowhere else in the process", `packages/app/src/testing/endpoint-access.ts:79`).
- Without `--isolate`, Bun 1.3.14 shares imported modules between test files, so whichever file boots second fails.
  `--isolate` runs each file in a fresh global and both pass. Nothing tells the author: no package doc, reference
  page or example script mentions it (`examples/*/package.json` run plain `bun test`).
- `fabrika db test-isolation` is not affected: it runs only the generated files, and only one of them boots the
  application. The Zerops build runs `bun test --pass-with-no-tests`
  (`packages/provider-zerops/src/execution.ts:223`) without a database, so the database tests skip there. The failure
  is the author's local `bun test` with `FABRIKA_TEST_POSTGRES_URL` set.

## Approach / acceptance

- Decide where `--isolate` is stated: the scaffold or template's `test` script, the platform's build command, or a
  checker finding for a `test` script without it. Document the rule in `docs/reference/application-runtime.md` and
  `packages/app/CLAUDE.md` either way.
- Witness: a fixture application with the generated tests and one hand-written `testKit` test on a database passes
  `bun run test` from its own root.

## Touch points

`packages/app/CLAUDE.md`, `docs/reference/application-runtime.md`, `packages/provider-zerops/src/execution.ts`,
`examples/zerops-app/package.json`, `packages/cli/src/__tests__/fixtures/isolation-app/`.

<!-- Origin: a finding of the application framework run (docs/ideas/app-framework-implementation-plan.md). -->
