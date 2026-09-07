---
id: monorepo
kind: pattern
title: Monorepo (Bun workspaces + flat catalog + project references)
slot: null
provides: [monorepo, workspaces, shared-packages]
requires: [bun]
recommends: [deptective]
conflicts: []
status: stable
sources:
  - where: "Bun workspaces documentation"
    read: "Workspace manifests, dependency ranges, and filtered scripts."
  - where: "roj — root package.json + packages/* (the same Bun-workspaces shape for @roj-ai/*)"
    read: "A second real Bun-workspaces monorepo to cross-check conventions."
---

# Monorepo

## What it is

A **Bun workspaces** monorepo: `packages/*`, scoped `@app/<kebab>` package names,
cross-package deps via **`workspace:*`** (resolved to symlinks at install), a **single
flat `catalog`** in the root `package.json` as the one source of truth for transitive
versions, and **`tsc --build` project references** for type-checking. One linter +
one formatter across the tree (e.g. oxlint + dprint).

## When & why to use

- A backend + multiple frontends (web/mobile/worker) that **share domain types + logic** (a `shared` package of Zod schemas, a `lib` of cross-cutting utilities).
- You want one lock file, cross-package tests, and no npm round-trip during dev.

## When NOT to use

- Packages need **independent release schedules** → separate repos + npm.
- Fundamentally different build systems per package.

## Gotchas

- **`workspace:*` = symlinks, not copies** — import from the package root (`import '@app/lib'`), never reach into `node_modules`.
- The **root `workspaces` list is the source of truth** — add a package dir _and_ run `bun install` or it isn't discovered.
- **One flat `catalog`**, no `catalogs.*` groups; bump versions in one place.
- **`tsc --build` needs `composite: true`** per package + a `references` list in the root tsconfig, or the build breaks.

## Relationships — why

- **requires `bun`** — Bun workspaces + the catalog are the mechanism. **recommends `deptective`** — keep cross-package deps honest (missing/unused, project-reference drift).
