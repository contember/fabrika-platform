---
id: 20
title: packages/iam violates the config-is-source-of-truth invariant
blocked-by: []
---

# 20 — `packages/iam` violates the config-is-source-of-truth invariant

The root `CLAUDE.md` states: `fabrika.config.ts` is the single source of truth for a
worker's resources and `oblaka.ts` is a thin shim. `packages/iam` does not follow it,
and the root file says so explicitly so nobody copies the pattern.

## Problem

`packages/iam/oblaka.ts` and `packages/iam/fabrika.config.ts` are near-duplicate
resource graphs. They have **already drifted**: `oblaka.ts` validates required env
vars and throws, `fabrika.config.ts` silently defaults to `''` — so the same deploy
surface behaves differently depending on which file is used. A comment in
`fabrika.config.ts` claims `oblaka.ts` imports `buildPropustkaWorker`; it does not,
it redefines the whole Worker inline.

Separately, `oblaka.ts` uses `as string` casts after its own `missing` check, against
the repo's no-casts rule.

## Acceptance

`oblaka.ts` is a thin shim over `fabrika.config.ts` with no second graph, the
env-var validation behaviour is one behaviour rather than two, and the casts are
gone. Then delete the parenthetical exception from the root `CLAUDE.md`.
