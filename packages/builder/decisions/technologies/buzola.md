---
id: buzola
kind: technology
title: Buzola — type-safe SPA router for React (Navigation API)
slot: router
provides: [router, spa, file-based-routing, type-safe-routes, loaders]
requires: [react]
recommends: [bun]
conflicts: [react-router]
npm: ["@buzola/router@^0.0.12", "@buzola/vite-plugin@^0.0.12", "@buzola/bun-plugin@^0.0.12", "@buzola/codegen@^0.0.12"]
status: wip
sources:
  - where: "buzola/packages/buzola/src/define/create-page.tsx + src/react/{hooks.ts,link.tsx}"
    read: "The createPage() builder + the React surface (useNavigate/useParams/useRoute, Link, Outlet, BuzolaProvider)."
  - where: "buzola/packages/{vite-plugin,bun-plugin,codegen}/src/"
    read: "How codegen emits src/buzola.gen.ts + the virtual:buzola/routes module, wired via EITHER the vite-plugin OR the bun-plugin (the non-vite path)."
  - where: "propustka/packages/admin-ui/src/{buzola.gen.ts,routes/principals/detail.tsx,routes/_layout.tsx}"
    read: "A real app: codegen output, chained loaders + error boundary + type-safe Link, layout nesting."
---

# Buzola

## What it is

A **type-safe SPA router for React** built over the browser **Navigation API**, with
**file-based routing** and **type codegen**. Routes are defined with a `createPage()`
builder; codegen emits `src/buzola.gen.ts` + a `virtual:buzola/routes` module and
augments a `BuzolaPageMap` so `navigate(pageId, params)` and `<Link to params>` are
fully typechecked. It is suitable for Contember-style admin SPAs, including Propustka's public admin UI.
Ships **both** a `@buzola/vite-plugin` and a **`@buzola/bun-plugin`** — the bun-plugin
is the **non-vite path** that fits our bun preference.

## When & why to use

- A client-rendered **SPA / admin panel** (auth-gated dashboards) where SSR isn't needed.
- You want **type-safe page ids + params** with zero manual route registration.
- Our **bun / non-vite** preference: drive codegen with `@buzola/bun-plugin` when
  the app has no other reason for Vite. Use the Vite plugin for a client-rendered
  two-process SPA/Worker stack.

## When NOT to use

- You need **SSR / data in loaders on the Worker** → `react-router`.
- You must support **Safari/Firefox or old browsers** — buzola **requires the Navigation API** (Chrome/Edge/Opera only); it throws at `BuzolaProvider` mount otherwise.

## Routing API (real shape)

```ts
export default createPage()
	.params({ id: 'string' }) // typed params (or a Standard Schema)
	.loader(async ({ params, redirect }) => { // chainable; results merge, first redirect wins
		const user = await fetchUser(params.id)
		if (!user) return redirect('login', {})
		return { user }
	})
	.route('/principals/:id') // URL pattern — comes ONLY from .route(), not the filename
	.render(({ params, data, invalidate, isLoading }) => (
		<Detail user={data.user} />
	))
```

Routes live in `src/routes/` (`_layout.tsx`, `_404.tsx`, `index.tsx`, `(group)/` are
special); the **page id** is the file path (`principals/detail.tsx` → `'principals/detail'`).

## Load-bearing gotchas (anti-staleness)

- **URL comes only from `.route()`**, never the filename — agents assuming Next-style file routing will get 404s. Check `buzola.gen.ts`.
- **`.render()` is required** — without it `createPage()` is incomplete and codegen drops the page.
- **Navigation API is mandatory** — no SSR, no old browsers; polyfill or use a memory adapter in tests.
- **Codegen needs a real module loader** — the vite-plugin/bun-plugin passes one (`ssrLoadModule` under vite); a bare Node `import()` silently loses routes.
- **Single `<Outlet/>` per layout** — no React-Router-style parallel/named outlets.

## Best practices (testability)

- Semantic markup + accessible names (`<Link>Dashboard</Link>`, `<label htmlFor>`, `role="alert"`) so opice selects by role/text, not brittle classes.

## Relationships — why

- **requires `react`** (it's a React router). Bundle via `@buzola/bun-plugin` (preferred, non-vite) or `@buzola/vite-plugin`; hence **recommends `bun`** rather than hard-requiring `vite`.
- **conflicts `react-router`** — same `router` slot; SPA (buzola) vs SSR (RRv7). One per app.
