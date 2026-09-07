---
id: contember-app
title: "Contember (Postgres GraphQL CMS) + buzola/React admin SPA + bindx + Tailwind"
goal: "From empty to a Contember backend (Postgres) with a typed schema + ACL, and a buzola/React admin SPA bound to it via bindx, green opice tests against the running SPA."
decisions:
  - contember
  - postgres
  - bindx
  - react
  - buzola
  - tailwind
  - bun
  - opice
build: "see §build recipe below"
---

# Stack: contember-app

A **data-driven admin app**: a Contember backend (GraphQL CMS + ACL + tenancy on
**Postgres**) with a **buzola/React SPA** front end bound to it through **bindx**
(typed data binding + form state). The opposite deployment shape to the cf-* stacks
— a **Node backend + Postgres** plus a **static SPA**, not Workers + D1.

## Composition

Backend: `contember` (backend slot) → `postgres` (relational-db). Frontend:
`react` + `buzola` (SPA router, bundled via `@buzola/bun-plugin` — the non-vite path)

- `bindx` (data-binding over Contember's GraphQL) + `tailwind` (styling). Toolchain:
  `bun`. Tests: `opice`.

requires-closure holds: `contember`→postgres, `bindx`→{contember,react},
`buzola`→react — all present. One per slot (backend, relational-db, router,
ui-framework, data-binding, styling). **No `cloudflare`/`d1`** — Contember is a Node
service on Postgres; `d1` would collide with `postgres` on `relational-db`.

Read first: **`contember`** (schema-as-code DSL, predicate ACL, Postgres + migrations),
**`bindx`** (the codegen step + implicit selection over-fetch gotcha), **`buzola`**
(`.route()` is the URL, Navigation-API-only, bun-plugin).

**Maturity:** `bindx` and `buzola` are `wip` (0.x) — the binding/router pieces still
churn; pin versions. The Contember backend itself is stable.

## Build recipe (per-issue verify stage)

1. start Postgres + the Contember engine (`docker-compose`); apply Contember migrations.
2. `generate:schema` (bindx generator: Contember model → typed entities) — commit the output.
3. start the buzola SPA dev server (`@buzola/bun-plugin`) → it queries the Contember GraphQL API.
4. `bun test` the targeted opice scenarios against the running SPA.
5. between iterations: backend + SPA stay up; reseed Contember data idempotently.

Scaffold: declare the Contember schema + ACL → bring up Postgres/engine → migrate →
`generate:schema` → wire `ContemberBindxProvider` + buzola routes → opice green.
