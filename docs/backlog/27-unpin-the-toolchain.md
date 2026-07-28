---
id: 27
title: Unpin the toolchain and fix what it finds
blocked-by: []
---

# 27 — Unpin the toolchain and fix what it finds

`@cloudflare/workers-types` is pinned to `4.20260610.1` and biome to `2.5.0` via the
root `package.json` — the versions the merged code was written against. The pin was
deliberate: it made merge damage distinguishable from toolchain drift while the
merge was in flight. That reason has expired.

## What a bump surfaces

Both findings are real; neither was fixed, because fixing them inside the merge
would have defeated the pin's purpose:

- **A newer `ExecutionContext` requires a `tracing` member.** `Tracing` includes
  `Span: typeof Span`, so faking it in a test double means constructing an abstract
  class — awkward without a cast, and casts are forbidden here.
- **A newer biome flags `noUnsafeOptionalChaining`** in `packages/engine`'s tests:
  `rec.provisions[0]?.definition` short-circuits to `undefined` and is then
  immediately dereferenced, so an empty array throws a `TypeError` instead of failing
  the assertion cleanly. The same line also carries an `as unknown as` cast and an
  `eslint-disable` comment in a repo that uses biome, not eslint.

## Acceptance

Both pins removed, both findings fixed without casts or suppressions, and the suite
green on current versions.
