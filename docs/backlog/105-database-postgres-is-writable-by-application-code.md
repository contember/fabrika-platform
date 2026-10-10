---
id: 105
title: Database.postgres is writable by application code
blocked-by: []
---

# 105 — `Database.postgres` is writable by application code

**Summary.** An application module can replace the static `Database.postgres` before the framework calls it and
receive the database URL, and the checker reports nothing. A defect against the data layer's claim that it makes a
bypass conspicuous. Small effort.

## Problem

`packages/db/CLAUDE.md` claims the layer "stops honest mistakes and makes a bypass conspicuous", and it already closes
the cheap same-process patches it knows of (a frozen Kysely compiler, captured built-ins, a frozen
`Database.prototype`). One remains:

- `Database` is a root export of `@fabrika/db` (`packages/db/src/index.ts:3`). `database.ts:102` freezes
  `Database.prototype`, but not the class, so its static `postgres` and `fromDialect` are writable.
- `serveContract` imports the application before it opens the database (`packages/app/src/bun.ts:217–218`:
  `load()`, then `openApplicationDatabase`, which calls `data.Database.postgres` with `FABRIKA_APP_DATABASE_URL`).
- So a module-level `Reflect.set(Database, 'postgres', wrapper)` in `src/` sees the URL, credentials included, and can
  hand the framework a working connection.

Reproduced on `main` (4f02fcd8) without a database: `Reflect.set` returns `true`, the replacement receives a synthetic
URL, and `checkApplication` over the clean fixture plus that module reports zero findings. `prototype-assignment`
(`packages/check/src/rules/runtime.ts:186–211`) looks for writes through `.prototype`, not to a class's own members.

## Approach / acceptance

- Freeze the class in the module that owns it: `Object.freeze(Database)` beside the prototype freeze, so both statics
  are non-writable and non-configurable.
- Capture the factory before any application module loads: `serveContract` and `runContractJob` read
  `data.Database.postgres` into a local before `load()`, so even an unfrozen copy of the package cannot be patched in
  time.
- Extend the checker: a write (assignment, `Reflect.set`, `Object.defineProperty`/`assign`, `delete`) to a member of a
  value imported from `@fabrika/*` or `zod` is a finding, with the allowed form "framework objects are read-only".
- Witness: a `hardening.test.ts` case that assigning `Database.postgres` throws in strict mode and `Reflect.set`
  answers `false`; a checker fixture for each write form; the existing hardening suites stay green.

## Touch points

`packages/db/src/database.ts`, `packages/db/src/__tests__/hardening.test.ts`, `packages/app/src/bun.ts`,
`packages/check/src/rules/runtime.ts`, `packages/check/CLAUDE.md`, `packages/db/CLAUDE.md`.

<!-- Origin: the security critique of docs/ideas/agent-friendly-app-framework.md. -->
