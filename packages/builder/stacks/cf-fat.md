---
id: cf-fat
title: "React Router v7 SSR + vite + @cloudflare/vite-plugin + full CF bindings — fat"
goal: "From empty to a Worker serving an SSR React app (workerd dev) with D1/KV/R2/Queue/AE/Cron wired (AE behind CountStore), auth in KV, and a green opice smoke test — no CF account needed for build/test."
decisions:
  - cloudflare
  - cloudflare-vite-plugin
  - wrangler
  - oblaka
  - vite
  - react
  - react-router
  - d1
  - kv
  - r2
  - queue
  - analytics-engine
  - cron-triggers
  - count-store
  - write-split
  - auth-password-kv
  - named-seeds
  - opice
  - bun
  - tailwind
build: "see §build recipe below"
---

# Stack: cf-fat

The **heavy SSR stack**: **React Router v7 SSR on Workers** built with **vite** +
**`@cloudflare/vite-plugin`** (real workerd dev), plus the full CF primitive set an
error-tracker-class app needs (D1/KV/R2/Queue/Analytics Engine/Cron). Counts sit
behind `count-store` (AE has no local runtime) so build + opice tests run **locally
with no CF account**; an account is only needed for prod deploy. Replaces the old
`cf-realstack` and makes the "fat" (SSR + workerd + vite + many bindings) framing explicit.

## Composition

Platform/dev: `cloudflare` · `cloudflare-vite-plugin` (cf-dev-runtime — workerd, **not**
lopata) · `wrangler` · `oblaka` · `vite` · `bun`. UI: `react` + `react-router` (**SSR**) +
`tailwind`. Storage/messaging: `d1` · `kv` · `r2` · `queue` · `analytics-engine` ·
`cron-triggers`. Patterns: `count-store`, `write-split`, `auth-password-kv`. Tests:
`opice` + `named-seeds`.

requires-closure holds incl. `cloudflare-vite-plugin`→{cloudflare,vite,wrangler},
`react-router`→{react,vite}, `write-split`→{analytics-engine,queue,r2,d1},
`analytics-engine`↔`count-store`, `auth-password-kv`→kv. The **`cf-dev-runtime` slot** is
`cloudflare-vite-plugin` (workerd), which **conflicts with `lopata`** — this stack needs
workerd fidelity for Queue/Cron.

Read first: **`analytics-engine`/`count-store`** (no local AE), **`react-router`** (Worker
entry also exports `queue()`+`scheduled()`), **`write-split`** (202-fast ingest, no per-event
D1 UPDATE), **`oblaka`** (verify every binding constructor — many here).

## Build recipe (per-issue verify stage)

1. start `react-router dev` (workerd via @cloudflare/vite-plugin, background).
2. `bunx wrangler d1 migrations apply DB --local` + apply relevant `named-seeds`; stage R2/KV fixtures.
3. `bun test` the targeted opice scenarios.
4. collapse the result; between iterations the app stays up, reseed idempotently.

Ingest/queue/cron slices add a handler (`queue()`/`scheduled()` branch) instead of a page;
counts via `count-store`, payloads via Queue→R2, mutable state in D1 — never a per-event D1 count UPDATE.
