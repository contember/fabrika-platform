---
id: nuasite
kind: technology
title: Nua Site — Astro meta-package + visual CMS
slot: site-framework
provides: [astro-site, visual-cms, markdown, seo-checks, sitemap]
requires: []
recommends: [tailwind, cloudflare]
conflicts: [pletivo]
npm: ["@nuasite/nua@^0.43", "@nuasite/cms@^0.43", "@nuasite/cli@^0.43", "@nuasite/components@^0.43", "@nuasite/checks@^0.43"]
status: stable
sources:
  - where: "nuasite/README.md + packages/nua/README.md"
    read: "The meta-package (pins Astro 6 + Tailwind 4 + MDX + sitemap) and how to configure it."
  - where: "nuasite/packages/cms/README.md"
    read: "The visual editor: how it injects data-cms-id markers and writes edits back to .astro source via HMR."
---

# Nua Site

## What it is

A published set of **Astro meta-packages** for building **content sites with a visual
CMS**. `@nuasite/nua` pins the toolchain (Astro 6, Tailwind 4, MDX, sitemap);
`@nuasite/cms` is an Astro integration that serves a visual editor in dev and writes
edits straight back to `.astro` source files; `@nuasite/checks` validates SEO/a11y/perf
at build. It mirrors the hosted Nua Site service so local builds match production.

## When & why to use

- A **marketing/docs/blog site** that needs **in-place visual editing** with edits flowing back to Git-tracked source.
- You want a validated Astro toolchain + LLM-friendly content export (`.md` endpoints, `AGENTS.md`).

## When NOT to use

- A dynamic **app** (SPA/SSR) → `react-router` / `buzola`.
- You want the fastest minimal SSG with no CMS → `pletivo`.
- **Note vs our bun/non-vite preference:** Astro is vite-based, so nuasite leans on vite under the hood — fine for content sites, but it's not the bun-native path.

## Impacts & gotchas

- Pages must be **`.astro`** for CMS editing (React/TSX components are islands, not CMS-marked).
- **Locked dependency versions** (the meta-package pins Astro/Tailwind) — you upgrade when Nua Site releases.
- The CMS editor parses **Tailwind `class="…"`** (style via utilities, not inline) and has **no built-in auth** — front it with `cloudflare-access` if edits must be gated.
- (Optional) `@pletivo/astro-jsx-pages` / `astro-jsx-pages` lets you author pages in `.tsx` instead of `.astro` — pre-release; not for the CMS-editing workflow.

## Relationships — why

- **conflicts `pletivo`** — same `site-framework` slot.
- **recommends `tailwind`** (the CMS depends on utility classes) + **`cloudflare`** (a common deploy target).
