---
id: preact
kind: technology
title: Preact (small React-compatible UI framework)
slot: ui-framework
provides: [ui-framework, components]
requires: []
recommends: [tailwind]
conflicts: [react]
npm: ["preact@^10"]
status: stable
sources:
  - where: "preactjs.com + installed preact types"
    read: "The Preact 10 API, `preact/hooks`, and the differences from React (events, `jsxImportSource: preact`)."
  - where: "pletivo islands + preactjs.com"
    read: "Where Preact shows up in our stack: pletivo's islands run on Preact."
---

# Preact

## What it is

A ~4 KB React-compatible UI framework. Largely JSX/hooks-compatible with React but
smaller, with subtle differences. In our stack, `pletivo`'s islands run on Preact.

## When & why to use

- You want a tiny client runtime (islands, embeddable widgets) — e.g. `pletivo` islands.
- Bundle size on the client matters more than the React ecosystem's breadth.

## When NOT to use

- You need the full React ecosystem (`react-router`, `buzola`, `bindx`, Contember admin all assume React) → use `react`.

## Impacts & gotchas

- `jsxImportSource: preact` in tsconfig; `preact/hooks` for hooks. **Don't mix React and Preact in one bundle.**
- **DOM-standard event names** (`onchange`, not React's `onChange`) — an easy bug when porting React code.
- React-only libs (Suspense-dependent, `bindx`, RRv7) won't run on Preact.

## Relationships — why

- **conflicts `react`** — same `ui-framework` slot; one per app.
- **recommends `tailwind`** for styling; used by `pletivo`'s islands (no hard requirer — it's the Preact option for island-style UIs).
