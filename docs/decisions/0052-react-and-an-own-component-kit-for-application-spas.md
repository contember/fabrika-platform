---
id: 0052
title: Build application SPAs with React, hooks over the typed client, and an own component kit
status: accepted
date: 2026-10-14
---

# 0052 — Build application SPAs with React, hooks over the typed client, and an own component kit

## Context

The framework prescribed no UI stack. The skill said only that `web/` calls `createClient(contract, 'api')`. An
application built on the paved road therefore wrote its own DOM element builder, a router, a page state and a
component set: the CRM example's `web/` held a hand-written `el()` helper, and another application built on the road
held a kit of several hundred lines that repeated the same pieces (a shell with a sidebar, page headers, tabs with
counts, filter bars, fields, buttons, a selectable table, status pills, label/value lists, dialogs, toasts, a
timeline, empty and error states). An agent invented each of them again for each application, and each one looked
different.

Three constraints shape the answer:

- The SPA is built by `Bun.build` from `web/` through `@fabrika/check/bun-plugin`, which loads the contract without its
  handlers. No Vite, no second build tool, no codegen step the checker would have to accept.
- The proxy's CSP is same-origin for scripts, and for styles and fonts unless the contract names more origins
  (`packages/proxy-core/src/headers.ts`). A kit that needed a stylesheet or font from a service would make every
  application declare one.
- The caller document (`<prefix>/__fabrika-me.json`) tells the page what the token grants. It is information for the
  page; the proxy is the only enforcement point (ADR-0022).

## Decision

1. **React is the SPA stack of the paved road.** `react` and `react-dom` are the application's dependencies; the
   skill makes the SPA a React tree and says to build screens from the kit instead of writing DOM helpers.
2. **`@fabrika/app/react` holds the data layer**, a subpath of `@fabrika/app`, with React as an optional peer
   dependency. It is a subpath and not a package because it reads the client's own node registry (`clientNodeOf`):
   which mount, path, type and input schema a client procedure is. A separate package would need that registry as a
   public export.
   - `FabrikaProvider({ clients, spa, fetch })` holds the clients `createClient` made, one cache, and the caller
     document. A hook takes a client procedure (`api.deals.get`) as the typed name of the call and runs it on the
     provider's client of that mount, so a test hands the provider a client over the test kit while the page keeps its
     module-level client.
   - `useQuery(procedure, input | skip, { keepPrevious })` (`keepPrevious` keeps the previous input's answer while the
     next loads: the `{ items, total }` offset lists), `useInfiniteQuery(procedure, input, { pages })` for the
     `{ items, next }` cursor lists, `useMutation(procedure, { invalidates })`, `useInvalidate()`, `useDownload(procedure)`
     for an attachment procedure on the provider's client, and `useAction(fn)` for a call that is no client procedure. The cache is keyed by procedure and input; one view or many share one request; a mutation
     refetches its own group by default (`api.deals` after `api.deals.create`) or what `invalidates` names; an
     invalidation refetches what a view shows and forgets the rest.
   - Answers come back through the procedure's output schema (`procedure.output`, which the client now exposes), so
     every type is the contract's and nothing is cast. A mutation checks its input with the procedure's input schema
     first; a refused input is a `validation` error with field paths, and nothing is sent.
   - Every refusal is one union, `FabrikaError`: `unauthenticated` (with the proxy's `loginUrl`), `forbidden`,
     `conflict` (a stale `expectVersion`), `validation` (field path → message), `not-found`, `other` (with the status).
     A contract declares no per-procedure errors, so the union is the same for every procedure.
   - `useCaller()` answers `{ label, email, can(action, scope?) }` from the caller document, and `<Can action scope>`
     renders by it. Both are information for the page only: they decide nothing, and the skill says so.
3. **The cache is our own, about 200 lines, and no TanStack Query.** An internal admin needs keyed queries, shared
   requests, invalidation by group and cursor pages. TanStack Query brings retries, focus refetch, garbage collection
   timers and its own key model, which a page would have to configure against the contract; owning the small part we
   use keeps the hooks typed from the contract without adapters and adds no runtime dependency.
4. **`@fabrika/ui` is an own React component kit**, a public package with no runtime dependency (React is a peer), and
   it depends on no `@fabrika/*` package: the form helpers read the hooks' errors structurally (`FormErrorLike`).
   Components are styled only through CSS custom properties defined in one theme stylesheet (`@fabrika/ui/styles.css`,
   tokens in `theme.css`) that the application imports and overrides; dark mode is a second token set under
   `data-theme="dark"`. The CSS is plain `.css` shipped with the package: no CSS-in-JS runtime, no Tailwind. An
   application changes the look through tokens and the components' props (variants), never through the kit's class
   names, which are no contract; a design the tokens and props cannot reach becomes a token or a variant of the kit.
5. **Routing is a minimal typed history router in `@fabrika/ui`** (`createRouter(routes, { base })`), not
   `@buzola/router`. Buzola types its routes from file-based codegen that imports every route module at build time
   (outside the shell-slice plugin), so it adds a generated file to the application, a second build plugin and a build
   step the checker would have to accept; it also relies on the Navigation API and `URLPattern`. An application needs a
   handful of typed patterns, which `createRouter` covers with the History API. The SPA mount's asset server answers
   `index.html` for a path that names no file, so deep links work; the build points the page's assets at the prefix
   so they resolve from any path (Bun's own `publicPath` fails to resolve in a process that already built once).
6. **The kit loads nothing from another origin.** The theme's font token is a system stack, and the components'
   styles ship with the package, so the kit runs under the default same-origin `style-src` and `font-src`. An
   application that wants a typeface self-hosts its files in the SPA bundle, or names the font service's origins in
   the contract's `csp` (`styleSrc`, `fontSrc`), which the approval shows like any other origin.
7. **The checker admits the stack.** `spa-server-import` allows `@fabrika/app/react` and `@fabrika/ui` beside
   `@fabrika/app/client`; React itself is no `@fabrika/*` module and no builtin, so it was always admitted.

## Consequences

- An application's `package.json` gains `react`, `react-dom` and `@fabrika/ui`, its `tsconfig.json` `"jsx":
  "react-jsx"`, and its `web/` is `.tsx`. The template (`examples/zerops-app`) and the CRM example are built this way.
- A screen is composed of kit components and hooks; a new pattern goes into `@fabrika/ui` once, not into each
  application.
- The client's procedures expose their output schema (`procedure.output`). Its type is part of `ProcedureCall`.
- A file collection's calls on the client (`api.files.<name>.upload`, `list`, `download`) are functions, not
  procedures: a page runs them through `useAction`, which gives them the same state and error union.
- A screen test installs its DOM with `installDom` of `@fabrika/app/react/testing` (happy-dom over Bun's own web
  platform, navigation off) and types with its `type(label, value)`; the checker keeps that module to test files.
- The hooks have no retry, no refetch on window focus and no time-based expiry. A page refetches by invalidation or
  `refetch()`.
- The router has no nested layouts, loaders or search-parameter state; a screen keeps its filters in React state.

## Alternatives considered

- **No prescribed stack** (as before): every application keeps paying for its own kit, and agents invent one per
  application.
- **shadcn/ui with Tailwind**: copies components into each application (the same per-application drift, in more
  files) and needs a Tailwind build step beside `Bun.build`.
- **A third-party runtime kit** (MUI, Mantine, Chakra): large runtime dependencies, CSS-in-JS runtimes or their own
  theming systems, and fonts or styles that a same-origin CSP admits only with work in each application.
- **TanStack Query** for the cache: see decision 3.
- **`@buzola/router`**: see decision 5. It stays the console's router (`packages/dashboard`), which is built with Vite.
- **A new package `@fabrika/react`** for the hooks: it would need the client's node registry as a public export, and a
  second package whose version must match `@fabrika/app` exactly.
