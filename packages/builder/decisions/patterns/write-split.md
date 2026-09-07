---
id: write-split
kind: pattern
title: Three-store write split (AE counts / Queue→R2 payloads / D1 state)
slot: null
provides: [ingest-architecture]
requires: [analytics-engine, queue, r2, d1]
recommends: [count-store]
conflicts: []
npm: []
status: stable
sources:
  - where: "Pattern. Reference: the cf-fat stack (ingest route + queue consumer)."
    read: "How an error-tracker-style bursty write workload is split across primitives."
---

# Three-store write split

## What it is

An ingest architecture for **bursty write workloads** (error trackers, event
pipelines): split each write by shape —

- **counts → Analytics Engine** (append via `count-store`, no UPDATE),
- **full payloads → Queue → R2** (202 fast, consumer batches puts),
- **mutable state → D1** (only human-driven rows: issues, projects, config),
- **keys / dedup / session → KV**.

## When & why to use

- Per-event `UPDATE count` on a D1 row would be hot-row contention an error storm kills.
- High-volume ingest where the request path must stay fast and writes must absorb bursts.

## When NOT to use

- Low write volume / no spikes — a single `d1` store is simpler and correct.

## Impacts & gotchas

- Ingest route returns **202** and enqueues; it does **NOT** write D1 synchronously per event.
- The `queue` consumer does R2 payload write + D1 upsert + `count-store.record`.
- Frozen as a tech-gate decision when chosen — it shapes the whole data flow.

## Relationships — why

- **requires `analytics-engine` + `queue` + `r2` + `d1`** — it is precisely the composition of all four.
- **recommends `count-store`** — the counts arm goes through it so dev/test stay account-free.
