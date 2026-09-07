---
id: content-site
title: "pletivo (Bun-native SSG) + Preact islands + Tailwind — static content site"
goal: "From empty to a statically-generated content site (file-based pages + content collections) with Preact islands and Tailwind, served locally, green opice smoke test."
decisions:
  - pletivo
  - preact
  - tailwind
  - bun
  - opice
build: "see §build recipe below"
---

# Stack: content-site

A **static content site** (marketing / docs / blog) built the Bun-native way —
`pletivo` (Astro-compatible SSG on Bun) with **Preact islands** for the bits that
need interactivity, **Tailwind** styling, tested by `opice`. Squarely on the team's
**bun / non-vite** preference: no app server, no vite pipeline, just a Bun build.

## Composition

`pletivo` (site-framework) · `preact` (islands — `ui-framework`) · `tailwind`
(styling) · `bun` (runtime/build) · `opice` (tests).

requires-closure holds: `pletivo`→bun; `pletivo` recommends `preact`+`tailwind`
(both present). One per slot (site-framework, ui-framework, styling, js-runtime,
e2e-tests). **No `react`** — pletivo's islands are Preact (and `preact` conflicts
`react`). **No SSR** — it's static; pre-declare dynamic routes via `getStaticPaths`.

Read first: **`pletivo`** (island registry reset, JSON-serializable island props,
`getStaticPaths` for dynamic routes), **`preact`** (DOM-standard event names).

**Maturity:** `pletivo` is `experimental` (0.1.x) — fine for a static site you control,
but pin the version; it's the bun-native bet, not a settled default.

## Build recipe (per-issue verify stage)

1. `bun install`; author `.astro`/`.tsx` pages under `src/pages/` + islands under `src/islands/`.
2. run the pletivo dev server (Bun) and/or `pletivo build` → static HTML.
3. serve the output locally; `bun test` the targeted opice scenarios against it.
4. between iterations: keep the dev server up; content is file-based (no DB to seed).

Hosting is flexible (any static host / Cloudflare Pages); add `cloudflare` only if the
site grows into needing Workers/bindings — at which point reconsider a Workers SSR stack.
