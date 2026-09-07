---
id: react-router
kind: technology
title: React Router v7 (SSR on Workers)
slot: router
provides: [router, ssr, loader-action-data]
requires: [react, vite]
recommends: [d1]
conflicts: [buzola]
npm: ["react-router@^7.13", "@react-router/dev@^7.13", "@react-router/node@^7.13", "isbot@^5"]
status: stable
sources:
  - where: "reactrouter.com (RRv7 SSR/loader/action) + installed package types"
    read: "Current SSR/loader/action API and the EXACT import paths — they move between minors. Verify against the installed version."
  - where: "lopata/examples/react-router/ — the canonical RRv7-SSR-on-Workers example"
    read: "Worker entry, entry.server, route table wired against CF bindings. The #1 ground truth for this decision."
---

# React Router v7 (SSR on Workers)

## What it is

Full-stack React Router v7 doing **server-side rendering on the Worker**:
`app/routes/*.tsx` with a server `loader`/`action` over CF bindings + a default
component. Self-contained, no RPC/Contember layer — lopata's own example path.

## When & why to use

- Server-rendered app reading data directly in loaders from `context.env.DB` etc.
- fabrika's default app architecture when SSR and route loaders fit better than a client-rendered SPA.

## When NOT to use

- A pure client SPA (no SSR), especially a Contember-style admin → `buzola`.

## Impacts & gotchas — the load-bearing ones (anti-staleness)

- **Worker entry** (`workers/app.ts`): `createRequestHandler` from **`react-router`** (NOT `@react-router/dev/server`) over `virtual:react-router/server-build`; `fetch` passes `{ env, ctx }` as the load context so loaders read `context.env.DB`. **This is the #1 thing stale memory gets wrong** — check the lopata example.
- **SSR renderer** (`app/entry.server.tsx`): `renderToReadableStream` from **`react-dom/server.browser`** (NOT `react-dom/server`) + `<ServerRouter>`.
- **Route table** (`app/routes.ts`): from `@react-router/dev/routes` — `export default [ index('routes/home.tsx'), route('cart','routes/cart.tsx'), … ]`. **Each route URL must match the opice skeleton `url` (contract).**
- `react-router.config.ts`: `{ ssr: true }`. tsconfig: RRv7 typegen via `rootDirs` (`.react-router/types`).

## Relationships — why

- **requires `react` + `vite`** (it's a React framework with a vite plugin).
- **recommends `d1`** — loaders/actions read/write D1 directly.
- **conflicts `buzola`** — same `router` slot. RRv7 = SSR; buzola = SPA. One router per stack.
