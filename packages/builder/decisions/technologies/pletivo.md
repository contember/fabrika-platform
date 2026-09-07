---
id: pletivo
kind: technology
title: pletivo — Bun-native SSG (Astro-compatible) — fits the bun/non-vite preference
slot: site-framework
provides: [ssg, astro-compat, jsx-pages, content-collections, islands, file-routing]
requires: [bun]
recommends: [preact, tailwind]
conflicts: [nuasite]
npm: ["pletivo@^0.1", "@pletivo/astro-jsx-pages@^0.0.1"]
status: experimental
sources:
  - where: "pletivo/README.md + CLAUDE.md"
    read: "Compatibility matrix, project structure, and the critical invariants (island registry reset, JSON-serializable island props)."
  - where: "pletivo/packages/pletivo/src/{index.ts,config.ts,build.ts}"
    read: "Public exports (defineCollection/getCollection, PletivoConfig), the render loop, and page emission."
  - where: "pletivo/packages/pletivo/src/runtime/{island.ts,hydration.ts}"
    read: "Island registration/reset + client hydration strategies (load/idle/visible/media)."
---

# pletivo

## What it is

A **Bun-powered static site generator**, ~2× faster than Astro and a near drop-in for
it: compiles `.astro` pages + JSX/TSX to static HTML at build, file-based routing
(`src/pages/`), content collections (Zod), and **Preact islands** with multiple
hydration strategies. Runs on **Bun** (not Node) — a natural fit for our bun /
non-vite preference (builds with Bun's pipeline, no separate vite app server).

## When & why to use

- A **content-focused static site** (blog, docs, marketing) where Astro builds are too slow.
- You want Astro compatibility (`.astro`, content collections) + lightweight Preact islands, on Bun.

## When NOT to use

- You need **SSR / per-request dynamic routes** → use a Workers SSR app (`react-router`) instead; pletivo is SSG-only (pre-declare dynamic routes via `getStaticPaths`).
- A visual-CMS content site → `nuasite`.
- Very large sites (>5k pages) or Node-only deps.

## Impacts & gotchas

- **Bun-locked** build/dev; CI needs Bun.
- **Islands must be JSON-serializable props** (embedded in `data-props`); functions/Dates/circular refs break.
- **Island registry must reset between pages** (`resetIslandRegistry()`) — the build does it; custom render paths must too, or island metadata bleeds across pages.
- Client is **Preact**, not React (no React-only island libs).

## Relationships — why

- **requires `bun`** — it's a Bun CLI/runtime (no Node SSR).
- **recommends `preact`** (islands) + **`tailwind`** (styling).
- **conflicts `nuasite`** — same `site-framework` slot; pletivo = fast minimal SSG, nuasite = Astro + visual CMS. Pick one site approach.
