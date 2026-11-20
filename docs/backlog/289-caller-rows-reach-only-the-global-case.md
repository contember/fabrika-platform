---
id: 289
title: The leak sweep's callers carry no caller rows and no principal-shaped id
blocked-by: []
---

# 289 — The leak sweep's callers carry no caller rows and no principal-shaped id

**Summary.** In an application whose handlers refuse a caller without its own record (a person's card bound to the
account), every swept endpoint answers 403 and the sweep checks nothing, only printing hints. Effort: S.

## Problem

- **No caller rows.** Each caller of the sweep's leak case comes from `callerFor(row, grants)`
  (`packages/app/src/testing/endpoint-access.ts`) without `callerRows`. `LeakSweepOptions` extends
  `EndpointAccessOptions`, so `callerRows` is accepted, but it reaches only the `global` case, which the sweep never
  runs: a silent no-op.
- **The id is not shaped like a principal id.** The kit's callers are `human-N` and `machine-N`
  (`packages/app/src/testing/kit.ts`); IAM issues UUIDv7, and only the global caller is a UUID now. A mutation that
  writes `ctx.caller.id` into a `uuid` column answers 500, which the sweep turns into a hint.
- **The key cannot be the principal id.** `applicationRowsPlan` refuses a value for a row's key (it is stamped).

## Approach / acceptance

- Seed `callerRows` for every caller the kit makes, the leak case's included; values the author gives carry no
  marker, so they never count as leaked.
- Issue each kit caller a UUID id, and let `GENERATED_CALLER` set a row's key.
- Acceptance: in a fixture application whose handlers refuse a caller without a card, the sweep compares every
  query with one `callerRows` entry and prints no "answered 403" hint.

## Touch points

`packages/app/src/testing/endpoint-access.ts`, `packages/app/src/testing/kit.ts`, `packages/app/src/testing/leak-sweep.ts`.

<!-- Origin: the global case's caller rows; rescoped to the leak sweep after the generated tests were removed. -->
