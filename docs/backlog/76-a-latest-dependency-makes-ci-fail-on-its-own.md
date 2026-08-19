---
id: 76
title: A `latest` dependency makes CI fail on commits that did not change
blocked-by: []
---

# 76 — A `latest` dependency makes CI fail on commits that did not change

**Summary.** Three packages declare `"lopata": "latest"`. CI installs with `--frozen-lockfile`, so the
committed lockfile goes stale the moment lopata publishes and every subsequent commit fails at
`Install dependencies` until someone re-commits `bun.lock`. Effort S.

## Problem

`packages/iam/package.json`, `packages/control/package.json` and `examples/app/package.json` all pin
`lopata` to `latest`. `latest` is not a range a lockfile can hold: a resolve after an upstream publish
produces a different lockfile than the committed one, and `.github/workflows/ci.yml` runs `bun install
--frozen-lockfile`.

Measured on 2026-08-19: `0de4e95` failed all four CI jobs with `error: lockfile had changes, but
lockfile is frozen`, and the change was `lopata@0.20.1 → 0.20.2`, which that commit did not touch. The
previous commit had passed an hour earlier and would fail an identical re-run.

The failure is also misleading. It lands on whoever pushed next, names no dependency, and reads as if
their change broke the install.

## Approach / acceptance

Give lopata a real range and bump it deliberately, the way `oblaka-iac` is already treated
(root `CLAUDE.md`: "resolves from npm, pinned to `^0.0.18` — bump the pin deliberately, in every
package"). fabrika and lopata are co-developed, so the same argument applies: a version this repository
did not choose should not arrive on a push.

Decide at the same time whether the three declarations must agree — the refresh that unblocked CI left
`@fabrika/iam` and `@fabrika/example-app` on `0.20.1` while the root moved to `0.20.2`, which is two
versions of one dev tool in one workspace.

Witness: an upstream lopata release does not change what `bun install --frozen-lockfile` produces here,
and a green commit stays green on re-run.

## Touch points

`packages/iam/package.json`, `packages/control/package.json`, `examples/app/package.json`, `bun.lock`,
and the root `CLAUDE.md` invariant list if lopata joins oblaka there.

<!-- Origin: found when CI failed on a commit that changed no dependency, 2026-08-19. -->
