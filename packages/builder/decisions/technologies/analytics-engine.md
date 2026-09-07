---
id: analytics-engine
kind: technology
title: Cloudflare Analytics Engine (counts / time-series)
slot: null
provides: [timeseries-counts, metrics]
requires: [cloudflare, count-store]
recommends: [d1]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/analytics/analytics-engine (writeDataPoint, SQL API, _sample_interval)"
    read: "writeDataPoint limits (≤20 blobs/doubles, 1 index), the SQL HTTP query endpoint, and SUM(_sample_interval) sampling."
---

# Cloudflare Analytics Engine

## What it is

High-cardinality, append-only time-series counts. You `env.AE.writeDataPoint(...)`
on the write path (no UPDATE, no hot row) and query aggregates over the **SQL HTTP
API** with `SUM(_sample_interval)`. The right home for "how many of X, grouped by
Y, over time" at error-storm volume.

## When & why to use

- Event counts / trends / grouping where per-row UPDATE in D1 would be hot-row contention (e.g. error-tracker issue counts).
- Append-only metrics you read as aggregates, not individual rows.

## When NOT to use

- Mutable state or exact read-after-write → `d1` / `durable-objects`.
- Anything you need locally without an account, **unless** abstracted (see below).

## Impacts & gotchas — the load-bearing one

- **No local runtime.** `writeDataPoint` is a no-op locally and queries hit the account HTTP SQL API (needs a CF token). So **counts MUST go behind `count-store`** (local/in-memory/D1 impl for dev+tests, AE impl for prod) — otherwise build/opice tests need a CF account.
- `writeDataPoint`: ≤20 blobs + ≤20 doubles + **1 index**; queries use `SUM(_sample_interval)` to account for sampling.

## Relationships — why

- **requires `cloudflare`** (binding) **and `count-store`** (the abstraction that keeps dev/test account-free).
- **recommends `d1`** — the local/test `count-store` impl typically aggregates from a D1 table.
