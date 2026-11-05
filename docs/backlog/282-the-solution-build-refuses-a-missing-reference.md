---
id: 282
title: The solution build refuses a missing reference
blocked-by: []
---

# 282 — The solution build refuses a missing reference

**Summary.** An import of another package without a `references` entry passes `bun run typecheck` silently; a check
should fail on it. Small.

## Problem

The root `tsconfig.json` checks every project once only while each cross-package import has a reference. A package
imported through its `node_modules` workspace link without one is checked again from source inside the importer: no
diagnostic, only a slower build and a second check of that package under the importer's options. TypeScript reports
TS6307 for a relative import only.

## Approach / acceptance

Run `tsc -p <config> --listFilesOnly` for every project the root `tsconfig.json` lists and fail when a program holds a
`.ts` or `.tsx` file of another project. Keep the known overlaps as named exceptions: canvas-share and the review
widget read files of `packages/agent-canvas/daemon`. Run it beside the typecheck in CI's Quality job, in parallel: a
serial run takes about 48 s on two cores. Witness: removing one `references` entry fails the check, naming the
importer and the file.

## Touch points

`scripts/`, `.github/workflows/ci.yml`, `scripts/check-ci.ts`.

<!-- Origin: review round 1 of the TypeScript 7 solution build. -->
