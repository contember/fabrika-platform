---
id: workers-ai
kind: technology
title: Cloudflare Workers AI
slot: ai-runtime
provides: [generative-ai, ai-binding, inference]
requires: [cloudflare]
recommends: [queue, cron-triggers, oblaka]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/workers-ai (Workers binding, models, limits, observability)"
    read: "The current env.AI binding, model catalog, request/response types, limits and pricing."
  - where: "Cloudflare Workers AI examples"
    read: "Binding declarations, guarded inference, and failure handling outside the request critical path."
---

# Cloudflare Workers AI

## What it is

Cloudflare-hosted model inference exposed to a Worker through an `AI` binding.
It fits workloads where the deterministic application result is produced first
and AI adds a summary, prioritization or explanation afterwards.

## When & why to use

- The app already runs on Workers and needs model inference without another API
  client or credential.
- AI output is supplementary and can run in a queue or scheduled invocation.
- You want Cloudflare-side model observability and optionally an AI Gateway.

## When NOT to use

- The model result is the source of truth for authorization, billing or a
  deterministic verdict.
- The required model/context/latency is outside Workers AI's current limits.

## Impacts & gotchas

- Bind as `env.AI`; verify the current model id and response types against the
  installed Workers types and live model catalog.
- There is no local model simulation. Keep opice/unit tests on a deterministic
  provider; when deliberately exercising real inference from local Worker code,
  configure the AI binding as remote using the current Wrangler/Vite mechanism.
- Treat model failure as an explicit degraded state. Persist the deterministic
  result first; store AI status/error separately and retry off the request path.
- Long inference belongs in `queue()` or `scheduled()`, not an HTTP request's
  critical path.
- If `vozka-config`/oblaka lacks a first-class Workers AI resource, use a small
  structural `Bindable` that emits `{ ai: { binding } }`; keep that workaround
  isolated and remove it once the IaC package exposes a supported primitive.

## Relationships — why

- **requires `cloudflare`** — inference is a Worker binding.
- **recommends `queue` / `cron-triggers`** — durable or scheduled work keeps slow
  inference away from user-facing requests.
