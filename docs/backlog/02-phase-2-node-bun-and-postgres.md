---
id: 02
title: Phase 2 — Node/Bun entrypoints and Postgres
blocked-by: [./01-phase-1-platform-ports.md]
---

# 02 — Phase 2 — Node/Bun entrypoints and Postgres

**Summary.** Make the control plane and the IAM service runnable as long-running
Node/Bun processes against Postgres, behind the ports from phase 1.

## Problem

The ports exist but have only Cloudflare implementations. The second
implementation set is where dialect and runtime assumptions actually surface —
particularly SQL, since `@fabrika/iam`'s `db.ts` is ~883 lines of D1
prepared-statement calls (see
[`../reference/portability-surface.md`](../reference/portability-surface.md)).

## Approach / acceptance

**Port the test harness first, before any production code.** This is the sequencing
rule for this rung and it is deliberate: dialect bugs must surface against real
tests rather than against production traffic. A harness that runs the existing
suite on Postgres is the acceptance gate for starting the rest of the work.

Then: Node/Bun entrypoints (the HTTP layer is already fetch-style
`Request → Response`, so this is entrypoint work, not rewrite work); a Postgres
`Db` implementation; the `Queue` port backed by a Postgres job table using
`SKIP LOCKED` plus an in-process poller.

Leading approach for SQL is a thin adapter over a D1-shaped interface: mechanical
`?` → `$n` rewriting, SQL kept to a common subset (both dialects support
`ON CONFLICT` and `RETURNING`; timestamps are already generated caller-side).
Kysely is the alternative — justified mainly if a third backend is ever expected.
Expect **migrations, not queries, to be the real cost**.

Acceptance: the full existing suite green on Postgres under Node/Bun **and** still
green on D1 under Workers.

## Touch points

`@fabrika/iam` (`env.ts`, `index.ts`, `db.ts`, test harness), `@fabrika/control`,
migrations.
