---
id: cloudflare
kind: technology
title: Cloudflare Workers (platform)
slot: platform
provides: [platform, edge-compute, serverless]
requires: []
recommends: [d1, durable-objects, kv, r2, queue, oblaka, wrangler]
conflicts: []
npm: ["@cloudflare/workers-types@^4", "wrangler@^4"]
status: stable
sources:
  - where: "developers.cloudflare.com/workers (fetch/queue/scheduled handlers, bindings, compatibility flags)"
    read: "The Worker handler shapes (fetch/queue/scheduled), how bindings reach the handler via env, and compatibility flags (nodejs_compat)."
  - where: "oblaka and lopata public examples"
    read: "Resource definitions, local bindings, and multi-worker composition."
---

# Cloudflare Workers

## What it is

The serverless edge-compute platform fabrika's generated apps target: V8-isolate
Workers with first-party bindings to storage and messaging primitives
(`d1`, `kv`, `r2`, `queue`, `analytics-engine`, `durable-objects`) and
`cron-triggers` and Workers AI. Bindings arrive on `env`; a Worker exports
`fetch`, optionally `queue(batch, env)` and `scheduled(event, env)`.

## When & why to use

- The default platform for fabrika apps — SSR React + a database in one deployable unit, no cold-start servers.
- You want managed primitives (SQLite/KV/object-store/queue) without operating infrastructure.

## When NOT to use

- You need a long-lived process, raw TCP, or a runtime workerd/lopata can't emulate.
- Hard requirement on a non-CF managed service with no equivalent binding.

## Impacts

- App is a Worker: code runs in a V8 isolate (web APIs, `nodejs_compat` flag for selected Node built-ins) — **not** full Node.
- Bindings are defined in an oblaka resource graph, directly in `oblaka.ts` or
  through `vozka.config.ts` for a Vozka-managed app; never hand-edit the generated
  `wrangler.jsonc`.
- Local dev emulates D1/KV/R2/Queue/Cron (`lopata` or `wrangler dev`/workerd). **`analytics-engine` has no local runtime** (see `count-store`).

## Recommendations — why

- **d1 / durable-objects / kv / r2 / queue** — the storage/messaging menu; pick per workload (relational state → `d1`, coordination/strong-consistency → `durable-objects`, hot keys/sessions → `kv`, blobs → `r2`, buffering bursts → `queue`).
- **oblaka** — define bindings as code; **wrangler** — CLI for d1/dev/deploy.
