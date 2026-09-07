---
id: durable-objects
kind: technology
title: Cloudflare Durable Objects (coordination / strong consistency)
slot: null
provides: [coordination, stateful-objects, strong-consistency, websockets]
requires: [cloudflare]
recommends: [oblaka]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/durable-objects (class binding, storage API, alarms, WebSocket hibernation)"
    read: "The DO class + binding model, transactional storage, alarms, and WebSocket hibernation."
---

# Cloudflare Durable Objects

## What it is

Single-instance stateful objects addressed by id, giving **strong single-object
consistency** and **coordination** — the thing D1/KV can't: a serialized point of
truth per entity. Each DO has transactional storage, alarms, and WebSocket support.

## When & why to use

- Per-entity coordination: rate limiters, locks, counters that must be exact, live presence.
- Real-time: WebSocket fan-out / rooms (hibernation keeps idle sockets cheap).
- A serialized actor where concurrent requests to the same id must not race.

## When NOT to use

- Plain relational/queryable state → `d1`. Hot cache/sessions → `kv`.
- High-cardinality append metrics (one DO per series doesn't scale) → `analytics-engine`.

## Impacts & gotchas

- Routed by id (`idFromName`/`idFromString`) — design the id space deliberately; all requests for one id serialize through one instance.
- Storage API is transactional but per-object; no cross-object queries.
- Local emulation under workerd/lopata; declare the class binding + migration in `oblaka.ts`.

## Relationships — why

- **requires `cloudflare`** — CF binding. **recommends `oblaka`** to declare the DO namespace/class.
