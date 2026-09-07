---
id: cf-lightweight
title: "buzola SPA + lopata + D1 on Cloudflare — lightweight, no SSR (preferred default)"
goal: "From empty to a buzola SPA on a local lopata CF dev server with a D1 binding and a green opice test — no SSR, local-first."
decisions:
  - cloudflare
  - lopata
  - oblaka
  - vite
  - react
  - buzola
  - d1
  - bun
  - tailwind
  - named-seeds
  - opice
build: "see §build recipe below"
---

# Stack: cf-lightweight

The **preferred default**: a client-rendered **buzola SPA** (no SSR) on **lopata**
(local-first CF runtime, Bun) with a single **D1** database, styled with Tailwind,
tested by opice. Lighter than `cf-fat` — no SSR machinery, no workerd, the bun/lopata
path. Replaces the old `cf-local` (which was RRv7 SSR); the SPA-no-SSR shape is the
lightweight one.

## Composition

`cloudflare` (platform) · `lopata` (cf-dev-runtime, local-first) · `oblaka` (iac) ·
`buzola` (SPA router — **no SSR**) + `react` · `d1` (relational-db) · `tailwind`
(styling) · `bun` (toolchain) · `named-seeds` · `opice`.

requires-closure holds: `lopata`→{cloudflare,vite}, `buzola`→react, `d1`/`oblaka`→cloudflare,
`named-seeds`→d1 — all present. One per slot (cf-dev-runtime=lopata, router=buzola,
ui-framework=react, relational-db=d1, …). **No `react-router`** — buzola is the SPA router.

**Note on vite vs the non-vite preference:** `lopata` is a vite plugin, so this stack
_does_ run vite for the local CF dev server, and buzola integrates via `@buzola/vite-plugin`.
The Bun-native `@buzola/bun-plugin` (true non-vite) path is for setups that don't use
lopata's vite dev server — see `buzola` / `bun`.

Read first: **`buzola`** (`.route()` is the URL, Navigation-API-only, codegen), **`lopata`**
(local D1 + the dev server), **`d1`** (idempotent migrations).

## Build recipe (per-issue verify stage)

1. start the lopata dev server (Bun) → the buzola SPA at the local URL.
2. `bunx lopata d1 migrations apply` + apply the relevant `named-seeds` (idempotent).
3. `bun test` the targeted opice scenarios against the running SPA.
4. collapse the result (steps + invariants); between iterations the app stays up, reseed idempotently.

Scaffold: write artifacts from sources → `bun install` → `bunx oblaka oblaka.ts` (→ wrangler.jsonc
with the D1 binding) → migrate → seed → lopata dev → buzola SPA renders D1 data → `bun test` green.
