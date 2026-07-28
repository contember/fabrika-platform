---
id: 01
title: Phase 1 — extract platform ports (CF implementations only)
blocked-by: []
---

# 01 — Phase 1 — extract platform ports (CF implementations only)

**Summary.** Introduce the port interfaces the control plane will need on any
platform, implement them for Cloudflare only, and retire the `DeployLock` Durable
Object. No second platform yet — this rung is pure seam-cutting.

## Problem

The control plane calls Cloudflare primitives directly (D1, Queues, R2, Durable
Objects, service bindings, `ASSETS`, `scheduled`, `waitUntil`). Nothing can run
elsewhere until those calls go through an interface. See
[`../reference/portability-surface.md`](../reference/portability-surface.md) for
the full inventory and the chosen answer per primitive.

## Approach / acceptance

Extract these ports: `Db`, `Blob`, `Lock`, `Queue`, `Assets`, `Cron`, `waitUntil`.
Ship Cloudflare implementations for all of them.

Replace the **`DeployLock` Durable Object** with a **TTL-bounded conditional
`UPDATE` on a DB row**. This works identically on SQLite and Postgres, so the DO is
deleted on **both** platforms — this is the one port that makes Cloudflare simpler
too, not just more portable.

Acceptance: the existing test suite passes unchanged; no direct Cloudflare
primitive access remains outside the CF port implementations; the `DeployLock` DO
class and its binding are gone, and concurrent-deploy tests still prove mutual
exclusion against the DB-row lock.

## Touch points

`@fabrika/control`, `@fabrika/engine`, `wrangler` config (DO binding removal).
