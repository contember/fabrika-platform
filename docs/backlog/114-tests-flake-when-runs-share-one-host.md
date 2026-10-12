---
id: 114
title: Tests flake when concurrent runs share one host
blocked-by: []
---

# 114 — Tests flake when concurrent runs share one host

**Summary.** Several suites fail intermittently when other test runs use the same host at the same time: they share a
host resource (a directory, a Postgres catalog row) with the other run, or they hold a wall-clock budget that load
stretches. Effort: S–M; one fix per suite.

## Problem

`6bf104fa` fixed one case: `platform-source.test.ts` (provider-zerops) saw another run's `fabrika-platform-source-*`
directories in the shared tmpdir, and now gives itself a private `TMPDIR`. These suites remain:

- **`packages/cli/src/__tests__/db.test.ts`.** The test-isolation case writes `bunfig.toml` and `skip-everything.ts`
  into the committed fixture directory itself (`:319`–`:330`), which every other run of the suite in the same
  checkout copies (`isolationApp`, `:86`). `setDefaultTimeout(30_000)` is set only inside the Postgres describe
  (`:295`); the scaffold cases (`:95`–`:196`) copy the fixture and run the whole checker under the 5 s default.
- **`packages/platform-node/src/__tests__/application-postgres-roles.test.ts`.** Every run grants and revokes
  `CREATE ON DATABASE` on the one shared database row (`:81`, `:85`, `:351`, `:363`, and `createTestProvisioner`,
  `packages/platform-node/src/postgres-test-provisioner.ts:47`), as does every `fabrika db test-isolation` run on the
  same server. Concurrent changes of that row can fail in Postgres with `tuple concurrently updated`. That is the
  likely mechanism; it has not been reproduced on its own.
- **`packages/app/src/__tests__/connect-hardening.test.ts`.** The deadline cases expect an exact number of attempts
  inside a 300 ms or 90 ms budget (`:255`–`:280`), and each case boots two test kits under the 5 s default.
- **The Cloudflare control IAM options test** (`packages/control/src/__tests__/platform-cf.test.ts:65`) runs a whole
  provider deploy under the 5 s default.

## Approach / acceptance

- A suite that writes files writes them only below a directory it created (`mkdtemp`, or a private `TMPDIR` as in
  `6bf104fa`); the test-isolation case runs on a copy of the fixture, never the committed directory.
- Postgres catalog changes that every run makes on one shared object are retried on `tuple concurrently updated`
  (SQLSTATE `XX000` with that message) or serialized by an advisory lock the test runs share.
- A case that measures a deadline asserts what the deadline guarantees (a `timeout` outcome, every body cancelled),
  not how many attempts fit; a case that boots kits or runs a deploy states its own timeout.
- Witness: each listed suite passes 20 times in a row while a second copy of the full `bun run test` runs on the
  same host and Postgres.

## Touch points

`packages/cli/src/__tests__/db.test.ts`, `packages/platform-node/src/__tests__/application-postgres-roles.test.ts`,
`packages/platform-node/src/postgres-test-provisioner.ts`, `packages/app/src/__tests__/connect-hardening.test.ts`,
`packages/control/src/__tests__/platform-cf.test.ts`.

<!-- Origin: the paved-road sprint's merge gates, where these suites failed under concurrent runs. -->
