---
id: 183
title: A red main blocks a release, and no local command equals CI
blocked-by: []
---

# 183 — A red main blocks a release, and no local command equals CI

**Summary.** `main` was red locally because test fixes were not pushed, and a flaky timing test failed a release
publish. Add one command that runs locally what CI runs, and make "green before push" an explicit expectation.
Medium effort.

## Problem

- CI (`.github/workflows/ci.yml`) runs four gates: quality (format, lint, typecheck, the Zerops artifact check), the
  full test suite with PostgreSQL and S3, the deployable builds, and the release artifacts. Locally these are
  separate commands. `bun run test` without `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` skips suites that
  CI runs, so a local green run can be a CI red run.
- A release from `main` was not possible because `main` was red; the fixes existed only in an unpushed checkout.
- `release.yml` runs `ci.yml` as its `verify` job, so one flaky test blocks a publish. A timing-dependent test did so
  during the v0.4.x hotfixes.

## Decision

`bun run check:ci` runs the steps of `ci.yml` in the same order and with the same backends: it starts the throwaway
PostgreSQL and SeaweedFS containers that the suites already describe, sets the variables, and removes the containers
at the end. The root `CLAUDE.md` states the expectation: run `check:ci` before a push to `main`. A test that fails
without a code change is made deterministic or deleted on the same day; CI never retries it.

## Scope

- In: the `check:ci` script under `scripts/` (it takes a `cpu-lease` where the root `CLAUDE.md` asks for one), the
  pre-push expectation in the root `CLAUDE.md`, a comment in `ci.yml` that points at the script.
- Out: a git pre-push hook (agents and operators push from many checkouts), CI changes beyond the pointer.

## Acceptance criteria

- `bun run check:ci` on a clean checkout runs every `ci.yml` step with no suite skipped for a missing backend, and
  stops at the first failure with the name of the step.
- A test asserts that `check:ci` and the `run:` steps of `ci.yml` name the same commands.
- The timing-dependent test that failed the release publish takes an injected clock (as the registry wait in
  `scripts/release.ts` does) or is removed.

## Touch points

`package.json`, `scripts/`, `.github/workflows/ci.yml`, `CLAUDE.md`, the flaky test.
