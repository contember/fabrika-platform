---
id: 103
title: Control's `runs` keeps an unused `pending_access_json` column
blocked-by: []
---

# 103 — Control's `runs` keeps an unused `pending_access_json` column

**Summary.** Since applications without a contract are refused, nothing reads or writes
`runs.pending_access_json`; a later migration release drops it. Small effort.

## Problem

- `0005_approved_access.sql` added the column on both engines (`packages/control/migrations/`,
  `packages/control/migrations-postgres/`). It held the artifact access a Cloudflare deploy found waiting for a
  human (ADR-0050, before contracts were required).
- Work unit B10g removed every consumer but left the column, so the destructive migration ships in a release of
  its own. `RunRow` in `packages/control/src/db/runs.ts` no longer lists it.

## Approach / acceptance

- In a later migration release, add a new D1 and Postgres migration pair that drops it. Never edit `0005_approved_access.sql`; on SQLite follow the `runs` rebuild rules in
  `packages/control/DATABASE.md`.
- Witness: the migration tests on both engines show the column gone, and the run repository tests still pass.

## Touch points

- `packages/control/migrations/`, `packages/control/migrations-postgres/`
- `packages/control/src/db/runs.ts` (the comment that names the column)
