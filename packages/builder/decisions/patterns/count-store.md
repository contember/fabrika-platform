---
id: count-store
kind: pattern
title: CountStore abstraction (counts: local vs Analytics Engine)
slot: null
provides: [count-abstraction]
requires: [d1]
recommends: [analytics-engine]
conflicts: []
npm: []
status: stable
sources:
  - where: "Pattern (no library). Reference: the cf-fat stack + app/lib/count-store.ts it prescribes."
    read: "The interface shape and the two impls (local/in-memory/D1 vs Analytics Engine)."
---

# CountStore abstraction

## What it is

A pattern, not a library: a `CountStore` interface — `record(event)` +
`query(filters) -> {fingerprint, count, first, last}` — with **two impls selected
by env**: a local one (in-memory in tests, D1 aggregation in dev) and an
**Analytics Engine** one (writes `env.AE.writeDataPoint`, queries the AE SQL HTTP
API with `SUM(_sample_interval)`) for prod.

## When & why to use

- You chose `analytics-engine` for counts but need build + opice tests to run **locally with no CF account** (AE has no local runtime).
- Any "swap the metrics backend by env" requirement.

## When NOT to use

- Counts are exact, low-volume, and fine to keep in D1 → just use `d1`, skip the abstraction.

## Impacts & gotchas

- The interface is the contract; loaders/handlers depend on it, **never** call `env.AE` directly so dev/test never need a token.
- Local impl must produce the same shape the AE impl does (count + first/last seen), so tests assert behavior, not backend.

## Relationships — why

- **requires `d1`** — the local/dev impl aggregates counts from a D1 table.
- **recommends `analytics-engine`** — the production backend this abstraction exists to hide. (It's also `analytics-engine`'s hard requirement, reciprocally.)
