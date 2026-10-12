---
id: 130
title: Codegen reports an empty migration bundle as a connection failure
blocked-by: []
---

# 130 — Codegen reports an empty migration bundle as a connection failure

**Summary.** `fabrika db codegen` in an application with an empty `db/migrations/` says that the database connection
failed. The real error is that the migration bundle is empty. `fabrika db migrate` names it correctly. Effort: S.

## Problem

`codegen` calls `migrations.objects()` inside its `try` (`packages/cli/src/db.ts:139`–`:144`). `objects()` reads the
bundle (`packages/platform-node/src/application-postgres-migrations.ts:98`–`:104`), and `validateBundle` throws a plain
`Error` for an empty bundle: `Postgres migration bundle app is empty`
(`packages/platform-node/src/postgres-migrations.ts:228`). `reportable` (`packages/cli/src/db.ts:96`–`:105`) passes
through only `PostgresMigrationError`, `CodegenError` and a server error. Every other error becomes "the database
connection failed; check FABRIKA_APP_DATABASE_URL". The connection error is withheld because it may contain the URL,
and this message is withheld with it.

Reproduced at `debb4e58` in a scratch directory with an empty `db/migrations/`. `codegen` printed the connection
message, and `migrate` printed `Postgres migration bundle app is empty`.

## Approach / acceptance

- `validateBundle` throws `PostgresMigrationError` for each of its refusals (an empty bundle, an empty file, a
  duplicate, a bad name). Each refusal names files only and never a URL, so `reportable` can pass it through.
- Witness: a `db.test.ts` case where `codegen` with an empty `db/migrations/` prints the bundle message and no
  connection message, and needs no database.

## Touch points

`packages/platform-node/src/postgres-migrations.ts`, `packages/cli/src/db.ts`, `packages/cli/src/__tests__/db.test.ts`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood's setup). -->
