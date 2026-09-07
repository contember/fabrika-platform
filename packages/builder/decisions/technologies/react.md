---
id: react
kind: technology
title: React (UI framework)
slot: ui-framework
provides: [ui-framework, components]
requires: []
recommends: [react-router, tailwind]
conflicts: [preact]
npm: ["react@^19", "react-dom@^19"]
status: stable
sources:
  - where: "react.dev + installed react/react-dom types"
    read: "Current React 19 APIs; for SSR-on-Workers note the server.browser render entry (see react-router)."
---

# React

## What it is

The UI framework for fabrika's generated apps (React 19). Paired with a router:
`react-router` renders SSR on the Worker, while `buzola` builds a client SPA that
the Worker can serve as static assets.

## When & why to use

- Default UI layer — the routers, opice selector conventions, and design-token mockups all assume React.

## Impacts & gotchas

- SSR on Workers renders via **`renderToReadableStream` from `react-dom/server.browser`** (NOT `react-dom/server`) — the Web Streams path. (Detail lives on `react-router`.)
- Build accessible markup: every interactive element needs an accessible name (`<label>`/text/`aria-label`) so opice has stable selectors (see `opice`).

## Relationships — why

- **recommends `react-router`** (default SSR-on-Workers router; `buzola` is the SPA alternative, both require react) **+ `tailwind`** (styling).
- **conflicts `preact`** — same `ui-framework` slot; `preact` is the smaller alternative (pletivo's islands run on it).
