---
id: 214
title: Raw SQL on SQLite
blocked-by: []
---

# 214 — Raw SQL on SQLite

**Summary.** `ctx.sql` is refused on SQLite (reason `sql_dialect`): its classifier reads Postgres's lexical rules,
and a Durable Object has no runtime role under it. P3, size M.

## Problem

On Postgres the runtime role is the boundary under an application's raw SQL (ADR-0017) and the classifier only
narrows it. A Durable Object's SQLite has no roles, so the classifier would be the only boundary
(ADR-0065 decision 7). `packages/app/src/implement/boot.ts` (`sqliteProblems`) refuses a contract that declares raw
SQL on SQLite; `packages/db/src/sql.ts` refuses at run time.

## Approach / acceptance

A SQLite lexer for the classifier (identifiers, string and blob literals, comments, `?NNN`/`:name` parameters) and an
allowlist of statement shapes strict enough to be the only boundary: no `ATTACH`, `PRAGMA`, `VACUUM`, no reference
to a framework table or `sqlite_*`. Witness: the classifier's corpus run on both dialects, with SQLite-only escapes.

## Touch points

`packages/db/src/sql.ts`, `packages/app/src/implement/boot.ts`, ADR-0065.
