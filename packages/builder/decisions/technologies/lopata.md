---
id: lopata
kind: technology
title: lopata (local Cloudflare runtime, local-first)
slot: cf-dev-runtime
provides: [local-cf-runtime, cf-dev-server, local-d1, local-bindings]
requires: [cloudflare]
recommends: [oblaka, bun, vite]
conflicts: [cloudflare-vite-plugin]
npm: ["lopata@^0.18.4"]
status: wip
sources:
  - where: "lopata (repo) + installed CLI/plugin source"
    read: "Worker entry, standalone dev command, optional vite-plugin wiring and the d1 CLI."
  - where: "lopata examples"
    read: "Vite integration, resource config, development commands, and multi-worker service bindings."
---

# lopata

## What it is

A drop-in CF runtime for **local dev** that runs on Bun (not workerd). Bindings are
backed by SQLite + FS under `.lopata/`, with a dashboard at `/__dashboard`. Lets
the whole stack run locally with **no CF credentials**.

## When & why to use

- Local-first development: D1/KV/R2 emulated on disk, zero account.
- The cf-lightweight path; `bunx lopata d1 …` for migrations/seeds/queries.

## When NOT to use

- You need the **real workerd** behavior or a binding lopata doesn't emulate yet → use `cloudflare-vite-plugin` (workerd) instead. lopata is **WIP — expect churn**, so verify what it emulates.

## Impacts & gotchas

- **Buzola SPA / Worker split:** run lopata as the standalone Worker dev server;
  run Vite separately and proxy only `/rpc`/`/api`/`/internal` to it. No lopata
  Vite plugin is needed in this shape.
- **Integrated SSR shape:** when using `lopata/vite-plugin`, verify its current
  `viteEnvironment`/config options. The `'ssr'` environment is specific to the
  SSR-on-Workers path, not a requirement for a client-only SPA.
- `CF=1` can swap lopata → `@cloudflare/vite-plugin` (real workerd) in stacks that
  explicitly implement that seam. The two share the `cf-dev-runtime` slot.
- Local D1 under `.lopata/d1/*.sqlite`; CLI `bunx lopata d1 migrations apply` / `execute DB --file …`.
- Generate `wrangler.jsonc` from oblaka/the shared Vozka resource builder before
  starting lopata. Never maintain local bindings in a second hand-written config.

## Relationships — why

- **requires `cloudflare`** (it emulates CF). Vite is recommended, not required:
  lopata can run the Worker separately from a Vite SPA.
- **conflicts `cloudflare-vite-plugin`** — same `cf-dev-runtime` slot; they're swappable dev paths (env-toggled), not used together. **lopata is our preferred default** (local-first, Bun); reach for the cloudflare-vite-plugin only when you need workerd fidelity.
- **recommends `bun`** — lopata is Bun-based; part of our bun/lopata preference.
