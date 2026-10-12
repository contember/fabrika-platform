---
id: 117
title: An application test cannot inject a database fault
blocked-by: []
---

# 117 — An application test cannot inject a database fault

**Summary.** `fabrika-check` refuses Bun's SQL driver and `process.env` in test files too, so an application test
cannot open its own connection to make a statement fail; the job clock is the only fault it can inject. Effort: S–M.

## Problem

The checker's rules do not exempt test files. `'SQL'` (and `sql`) imported from `bun` is `forbidden-global` as a
database driver (`packages/check/src/rules/modules.ts:78`, `:140`), and `process.env` is `env-read` everywhere but
the generated entrypoint (`packages/check/src/rules/runtime.ts:325`). Checked at HEAD: a
`src/__tests__/fault.test.ts` holding `import { SQL } from 'bun'` and `new SQL(process.env.FABRIKA_TEST_POSTGRES_URL)`
gets both findings. `testDatabase` (`packages/db/src/testing.ts:77`) hands the test only the layer's `database` and
the seeding helpers.

The CRM's review needed a fault: its `overdue` job must survive an attempt that fails after it committed part of
its work. A raw-SQL trigger that fails the Nth write was refused by the checker, so the test makes the attempt time
out through its `JobClock` instead (`examples/crm/src/tasks/__tests__/overdue.test.ts`). A deadlock, a refused
constraint mid-batch or a lost connection cannot be staged at all.

## Approach / acceptance

- Decide the form: a fault seam in `@fabrika/db/testing` (for example `testDatabase(…).failNext({ table, operation,
  sqlState })`, run through the test database's own connection), or a test-file exemption of the two rules for
  `@fabrika/db/testing`'s connection only. The seam is preferable: the exemption would also admit a driver that
  bypasses the data layer in a test that is supposed to prove the layer's isolation.
- Whatever the form, it is reachable from a test file only (`test-only-import`) and refused once
  `markProductionProcess` ran, like the rest of `@fabrika/db/testing`.
- Witness: the CRM's `overdue` test stages a write that fails with a database error after some tasks committed, and
  the run succeeds on the next attempt; the checker passes on it.

## Touch points

`packages/db/src/testing.ts`, `packages/check/src/rules/{modules.ts,runtime.ts}`,
`packages/app/skill/references/tests.md`, `examples/crm/src/tasks/__tests__/overdue.test.ts`.

<!-- Origin: the paved-road sprint, WU11 review round 1 (item 2). -->
