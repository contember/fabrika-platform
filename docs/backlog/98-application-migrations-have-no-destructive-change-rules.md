---
id: 98
title: Application migrations have no destructive-change rules
blocked-by: []
---

# 98 — Application migrations have no destructive-change rules

**Summary.** The checker accepts any SQL in an application migration: a dropped column, a renamed table, a changed
type or a `GRANT` passes, although the design keeps migrations expand-only. Medium effort.

## Problem

Application migrations are expand-only: a drop, rename or type change ships in a later release than the one that
stopped using the object. The decided protection is squawk rules (`ban-drop-column`, `ban-drop-table`,
`renaming-column`, `renaming-table`, `changing-column-type`, `adding-required-field`), a `-- fabrika:contract` marker
that names the release which stopped using a dropped object, and a refusal of `GRANT` and
`SECURITY DEFINER` (views, triggers, functions and policies are deviations since ADR-0017's rewrite). None of this is built:

- The checker has one migration rule, `migration-name` (`packages/check/src/rules/migrations.ts:20`).
  `packages/check/CLAUDE.md:253` lists squawk rules and destructive-migration markers as not built.
- The runner refuses transaction-control and setting statements (`refusedStatement`). In an application plan it
  refuses what `classifyMigration` (`@fabrika/platform-node/sql`) refuses, a foreign schema included, admits views, triggers, functions and policies as deviations, and rolls
  back a file that leaves an escape or an undeclared object in the schema (`databaseCodeCheck`). The checker
  reports none of it before the deploy.
  The runner covers the timeouts itself, so `require-lock-timeout` and `require-statement-timeout` are not needed.

The previous release keeps serving while a migration runs, and a rollback starts old code on the new schema, so a
destructive statement breaks the running release.

## Approach / acceptance

- Checker rules over the migration files, on the tokenizer the runner already has (`sqlTokens`, `statementStarts`)
  or on squawk; decide which before building.
- A destructive statement without `-- fabrika:contract` naming an earlier release is a finding; the non-DDL
  statements above are a finding with no marker that allows them. That finding calls the runner's
  `classifyMigration`, so the checker and the runner refuse the same statements.
- Witness: one fixture migration per rule in `packages/check`'s suite, each a finding; the example application's
  migrations stay clean.

## Touch points

`packages/check/src/rules/migrations.ts`, `packages/check/CLAUDE.md`, `@fabrika/platform-node/sql`
(the shared tokenizer and classifier), `docs/reference/application-runtime.md`.

<!-- Origin: deferred from A9 of the application framework plan (docs/archive/sprint-2026-10-08-a-m2-data.md). -->
