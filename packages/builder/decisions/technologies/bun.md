---
id: bun
kind: technology
title: Bun (JS runtime + toolchain) — PREFERRED
slot: js-runtime
provides: [js-runtime, package-manager, test-runner, bundler, native-bundling]
requires: []
recommends: [lopata]
conflicts: []
npm: []
status: stable
sources:
  - where: "bun.sh/docs + bun (cloned source for internals)"
    read: "The runtime/bundler/test-runner surface; `bun build` and bun plugins for the non-vite path."
  - where: "Our repos that run on Bun: lopata, opice (`bun test`), pletivo"
    read: "How our toolchain assumes Bun end to end."
---

# Bun

> **Team preference.** We prefer **Bun + lopata + a non-vite stack**. Pick Bun as the
> runtime/toolchain and Bun-native bundling (e.g. `@buzola/bun-plugin`, pletivo's
> Bun build) wherever a decision offers it; reach for `vite` only when a chosen lib
> still mandates it (e.g. React Router v7).

## What it is

The JS runtime, package manager, test runner, and bundler our stack standardizes on.
Most of our libs assume Bun: `lopata` runs on it, `opice` runs under `bun test`,
`pletivo` builds with it.

## When & why to use

- Default for every fabrika app — one fast toolchain (install, run, test, build).
- Bun-native bundling avoids a separate vite pipeline (the **non-vite** preference).

## When NOT to use

- A dependency genuinely needs Node-only APIs Bun doesn't implement, or a lib hard-requires vite (then `vite` is a scoped exception, not the default).

## Impacts & gotchas

- `bun test` is the test runner (opice rides on it); `bunx` runs CLIs (oblaka, lopata, opice).
- Bun-native bundling differs from vite plugins — when a lib offers both (e.g. buzola), prefer the **bun-plugin**.
- Some Node libs assume Node built-ins; verify under Bun before depending on them.

## Relationships — why

- **slot `js-runtime`** — the runtime choice (vs Node).
- **recommends `lopata`** — the preferred local CF runtime, also Bun-based.
- Required/assumed by `pletivo`; `opice` runs under it.
