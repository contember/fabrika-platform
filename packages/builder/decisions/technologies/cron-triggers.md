---
id: cron-triggers
kind: technology
title: Cloudflare Cron Triggers (scheduled jobs)
slot: null
provides: [scheduled-jobs, cron]
requires: [cloudflare]
recommends: [oblaka]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/workers/configuration/cron-triggers (scheduled handler, triggers.crons)"
    read: "The scheduled(event, env) handler and triggers.crons config in wrangler."
---

# Cloudflare Cron Triggers

## What it is

Scheduled invocation of a Worker on a cron expression. The Worker exports
`scheduled(event, env)`; the schedule is `triggers.crons` in `wrangler.jsonc`. For
periodic work — spike/anomaly detection, digests, cleanup.

## When & why to use

- Periodic background work with no incoming request (alert spike detection, rollups, GC of expired sessions).

## When NOT to use

- Sub-minute or event-driven timing → use `queue` (event-driven) or a `durable-objects` alarm (precise per-object timer).

## Impacts & gotchas

- Export a **`scheduled(event, env)`** handler alongside `fetch`/`queue`. Emulated locally by workerd/lopata; trigger manually in dev.
- Schedule lives in `triggers.crons` — declare it via `oblaka.ts`, never hand-edit the generated `wrangler.jsonc`.
- Put the real operation in a reusable function and call it from both
  `scheduled()` and a protected manual/internal endpoint used by local tests.
  Do not make the scheduled handler call its own public HTTP endpoint.
- When several schedules share one Worker, branch on `event.cron` explicitly;
  keep recovery/sweep operations idempotent because a trigger can overlap a
  queue retry or a manual run.

## Relationships — why

- **requires `cloudflare`** — platform feature. **recommends `oblaka`** to declare the cron trigger.
