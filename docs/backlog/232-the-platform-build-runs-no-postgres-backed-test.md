---
id: 232
title: The platform build runs no Postgres-backed application test
blocked-by: []
---

# 232 — The platform build runs no Postgres-backed application test

**Summary.** The Zerops build has no database, so every test file that opens `testDatabase` skips. Only the generated
isolation tests run on the platform, at container start. Recommended: a throwaway Postgres inside the build container,
with a skip turned into a failure. Effort M; it needs live Zerops facts first.

## Problem

`generatedBuildCommands` (`packages/provider-zerops/src/execution.ts`) runs the application's tests with
`bun test --isolate --pass-with-no-tests` and sets no `FABRIKA_TEST_POSTGRES_URL`. Each file that opens
`testDatabase` (`packages/db/src/testing.ts`) prints `<label> skipped: set FABRIKA_TEST_POSTGRES_URL to run the
Postgres-backed tests` and registers no test, so the step passes. An end-to-end stage deploy of the Notes example
skipped four such files.

The deploy's init commands run `fabrika db test-isolation` against a throwaway schema of the application's database.
That command runs only the generated files (policy isolation and endpoint access), whose bytes the checker compares
with what the scaffold writes. The author's own Postgres-backed tests (for example `examples/crm`'s `overdue.test.ts`
and `deals.test.ts`) run nowhere on the platform.

The build's tests command now says so: it counts the skip lines and prints
`fabrika-tests: N Postgres-backed test files did not run, because the build has no database: <labels>`, which the run
log relays. The count includes the generated files, which run again at container start.

## Options

| Option                                                                        | Runs authored code against                                | Gates the deploy        | Cost                                                                         | Verdict                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- | ------------------------ |
| A. Throwaway Postgres in the build container                                  | a local, empty cluster that dies with the build container | yes, before any version | Postgres install and `initdb` per build (cache unverified); one more process | **recommended**          |
| B. Authored DB tests in the deploy's init commands, on a scratch schema/role  | the environment's real database server                    | yes, at activation      | the 180 s readiness window already holds the CRM's ~3 min of generated cases | rejected                 |
| C. Only in the dev environment's `run_checks`                                 | the dev environment's database                            | no                      | none in the build; needs a test credential in the dev container              | complement, not the gate |
| D. Honest reporting only                                                      | nothing                                                   | no                      | none                                                                         | done (the report above)  |
| E. Require a green check run of the application's own CI on the pinned commit | the application's CI database                             | yes, through GitHub     | every application needs a CI with Postgres; Control trusts a foreign result  | rejected                 |

- **A.** The platform generates the install and start of a local Postgres (a `build.prepareCommands` of its own, or a
  build command) and runs the test step with `FABRIKA_TEST_POSTGRES_URL` naming that cluster's superuser and
  `FABRIKA_TEST_POSTGRES_REQUIRED=1`, so a skip fails. Nothing reaches an environment's database, and authored code
  only ever holds a credential of a cluster that is discarded with the build container. Risks: the Alpine package
  of the build base must carry the same Postgres major as the application's service (`postgresql:*@18`); an
  extension that a migration needs must be installed too; and every build pays the install unless Zerops keeps the
  prepared build image.
- **B.** `test-isolation` is safe because the platform wrote the cases it runs. An authored test is arbitrary code,
  and the init command runs where the provisioning credential of the real database is reachable. A scratch schema
  and a separate role do not change that: the code chooses what it connects to. It would also run on every
  container start, inside the readiness budget.
- **C.** Useful for the fast loop, but it gates nothing, and it is safe only where the dev environment's database is
  its own service. On a shared namespace Postgres the credential that creates roles reaches other environments.
- **E.** Moves the gate outside the platform, and Control would accept a result it cannot reproduce.

## Approach / acceptance

Option A, after the facts below are settled against a real account and recorded in
[`zerops-platform.md`](../reference/zerops-platform.md):

1. Whether `sudo apk add postgresql<major>` works in the `alpine/bun@1.3` build container, and how long it takes.
2. Whether the build user can run `initdb` and `pg_ctl start` on a local socket or `127.0.0.1`, and whether the
   process outlives one build command.
3. Whether a generated `build.prepareCommands` is cached between builds, and what invalidates that cache.

Then:

- The tests command starts the cluster, runs the tests with `FABRIKA_TEST_POSTGRES_URL` and
  `FABRIKA_TEST_POSTGRES_REQUIRED=1`, and stops the cluster. The URL is a credential of a throwaway cluster, but the
  command still prints none of it.
- `fabrika-tests:` then reports the files that ran against Postgres, and a skip no longer happens.
- Protocol (ADR-0062): an application whose Postgres-backed tests fail today deploys because they skip. Requiring
  them is a tightening of the build step, so it applies to an application whose framework minor is the one that
  ships it or newer. An older one runs them and reports the result without failing the build.
- A test in `packages/provider-zerops` runs the generated command against a fixture with one Postgres-backed test
  file, and the platform-facts table gains the rows above.

## Touch points

`packages/provider-zerops/src/execution.ts` and its tests, `docs/reference/zerops-platform.md`,
`docs/decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md` (the generated build),
`docs/reference/application-runtime.md`, `packages/provider-zerops/CLAUDE.md`.
