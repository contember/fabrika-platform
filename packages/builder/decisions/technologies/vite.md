---
id: vite
kind: technology
title: Vite (bundler / dev server)
slot: bundler
provides: [bundler, dev-server, hmr]
requires: []
recommends: [react]
conflicts: []
npm: ["vite@^7"]
status: stable
sources:
  - where: "vitejs.dev + installed vite types"
    read: "Plugin API + the environments API (the SSR environment used for the Workers path)."
---

# Vite

> **Team preference: bun / non-vite.** We prefer Bun-native bundling where a decision
> offers it (e.g. `@buzola/bun-plugin`, pletivo's Bun build). Use vite when a chosen
> lib still mandates it — React Router v7 SSR (`react-router`) and the
> `@cloudflare/vite-plugin` dev path require it.

## What it is

The bundler + dev server for fabrika apps. Plugins wire the framework
(`@react-router/dev`) or a client router (`@buzola/vite-plugin`). In an SSR stack
it can also host the CF runtime plugin. In a client-only Buzola stack, Vite serves
only the browser bundle and proxies API requests to a separate lopata Worker.

## When & why to use

- React SSR stacks that need Vite's environment/plugin integration.
- Client-rendered Buzola SPAs that choose `@buzola/vite-plugin` for route codegen
  and fast HMR, especially the two-process SPA/Worker development shape.

## Impacts & gotchas

- In an SSR app, the Worker dev server is composed of framework + CF-runtime
  plugins; configure the SSR environment and verify moving plugin options.
- In a Buzola SPA, do **not** add an SSR environment merely because the backend is
  a Worker. Use `buzolaPlugin()`, build static assets, and proxy explicit API
  namespaces to the separate local Worker.

## Relationships — why

- **recommends `react`** — the default UI framework these plugins target (also pairs with `react-router`).
