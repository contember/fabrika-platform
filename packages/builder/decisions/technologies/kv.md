---
id: kv
kind: technology
title: Cloudflare KV (key-value store)
slot: null
provides: [kv-store, sessions, dedup-cache]
requires: [cloudflare]
recommends: [oblaka]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/kv (get/put/delete, TTL, eventual consistency)"
    read: "The KV binding API and its eventual-consistency / TTL semantics."
---

# Cloudflare KV

## What it is

Eventually-consistent key-value store. Used for **session tokens**, **API
keys / DSN lookups**, and **dedup caches** — small values read on the hot path,
keyed by a stable id. Bound as `env.KV`.

## When & why to use

- Session storage (`auth-password-kv`), API-key validation on ingest, idempotency/dedup keys.
- Hot-path lookups where eventual consistency is acceptable.

## When NOT to use

- Read-after-write strong consistency required → `d1` or `durable-objects`.
- Relational queries / joins → `d1`.

## Impacts & gotchas

- **Eventually consistent** — a freshly written key may not be readable immediately everywhere; don't rely on it for read-after-write invariants.
- Values are opaque blobs (string/ArrayBuffer); model structure yourself. Use TTL for ephemeral session/dedup keys.

## Relationships — why

- **requires `cloudflare`** — CF binding. **recommends `oblaka`** — declare `KVNamespace` in `oblaka.ts`.
