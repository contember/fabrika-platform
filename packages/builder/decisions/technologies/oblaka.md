---
id: oblaka
kind: technology
title: oblaka (Cloudflare IaC / bindings as code)
slot: iac
provides: [iac, binding-definitions, wrangler-generation]
requires: [cloudflare]
recommends: []
conflicts: []
npm: ["oblaka-iac@^0.0.18"]
status: wip
sources:
  - where: "oblaka (repo) + `oblaka-iac` on npm (installed types)"
    read: "The CURRENT binding API, programmatic deploy surface and how `bunx oblaka <file>` generates wrangler.jsonc. Read the live types — do not guess."
  - where: "vozka packages/core + vozka-config"
    read: "How Vozka materializes the same oblaka resource graph for production while an app keeps a thin local-dev shim."
---

# oblaka

## What it is

A TypeScript DSL for Cloudflare IaC: define the Worker + its bindings in
`oblaka.ts`, run `bunx oblaka oblaka.ts` to **generate `wrangler.jsonc`**. One typed
source of truth for Workers, D1, KV, R2, Queues, DO, Analytics Engine and cron.
Vozka uses oblaka programmatically for production provisioning; standalone
`oblaka.ts` remains useful as the local lopata config shim.

## When & why to use

- Any CF stack — declare bindings as code instead of hand-writing `wrangler.jsonc`.
- A Vozka app — the resource builder in `vozka.config.ts` is still an oblaka
  `Worker`; reuse it from the local shim rather than duplicating the graph.

## Impacts & gotchas

- **`wrangler.jsonc` is GENERATED — never hand-edit it.** Change `oblaka.ts` and regenerate.
- Standalone/local shape: `define(({ env }) => buildWorker({ env, domain: undefined }))`,
  where `buildWorker` is exported from `vozka.config.ts`. For a non-Vozka app,
  build the `Worker` inline as before.
- **Verify every binding constructor against the installed `oblaka-iac` types** — it's WIP and a stack may use bindings (Queue consumer, AE, cron) the constructor surface for which moves. If a binding type is missing, generate the wrangler entry per Cloudflare docs.
- `vozka-config` and oblaka publish raw TypeScript in some versions; if the app's
  main `tsc` excludes config files, validate them by actually materializing the
  config and running a wrangler dry-run/config check.

## Relationships — why

- **requires `cloudflare`** — it exists to configure CF. Recommended by every CF binding decision (`d1`/`kv`/`r2`/`queue`/`durable-objects`/`cron-triggers`).
