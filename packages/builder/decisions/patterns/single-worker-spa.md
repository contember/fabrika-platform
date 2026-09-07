---
id: single-worker-spa
kind: pattern
title: Single-Worker SPA in production, split frontend/backend in development
slot: app-delivery-shape
provides: [spa-hosting, worker-api, local-dev-split, single-deployable]
requires: [cloudflare, vite, buzola]
recommends: [lopata, vozka]
conflicts: []
status: stable
sources:
  - where: "Cloudflare Workers Static Assets docs"
    read: "API-first Worker routing, the ASSETS binding, SPA fallback, and run_worker_first behavior."
  - where: "Cloudflare Workers Static Assets docs"
    read: "The current assets binding, run_worker_first and not_found_handling semantics."
---

# Single-Worker SPA, two-process local dev

## What it is

A Buzola SPA and a Worker API are separate processes during development but one
deployable Worker in production:

- **development:** Vite serves the SPA with HMR (normally `:5173`), lopata serves
  the Worker and local bindings (normally `:8787`), and Vite proxies only the API
  namespaces to lopata;
- **production:** Vite builds static assets, the Worker's `ASSETS` binding serves
  them, and the same Worker handles API routes before falling back to the SPA.

## When & why to use

- Internal dashboards/admin apps where SSR has no product value.
- You want fast frontend HMR and local CF bindings without deploying two services.
- Client routes need deep-link fallback while API paths remain real 404s.

## Integration contract

1. Vite emits the SPA to the directory declared by the Worker's assets binding.
2. `vite.config.ts` proxies explicit namespaces such as `/rpc`, `/api` and
   `/internal` to the local lopata Worker.
3. Static assets use `not_found_handling: 'single-page-application'`.
4. Prefer selective `run_worker_first` patterns for `/rpc`, `/api/*` and
   `/internal/*`, so non-API assets/navigation skip the Worker entirely.
5. The Worker handles the matched API routes; an unhandled path _inside an API
   namespace_ returns 404 and never falls through to `index.html`.
6. If whole-page middleware truly requires `run_worker_first: true`, the Worker
   must explicitly forward every non-API request with `env.ASSETS.fetch(request)`.

## Load-bearing gotchas

- **Do not proxy `/` in development.** Vite owns page/navigation requests; only
  API namespaces go to lopata.
- **Do not let unknown API paths render the SPA shell.** Keep an explicit API
  prefix guard before the assets fallback.
- New scaffolds should prefer
  the supported route-array form unless they need middleware on every page/asset
  request. It avoids unnecessary billed Worker invocations.
- `ASSETS` may be absent locally. Type it as optional and return a real 404 after
  API handling in the two-process dev flow.
- Browser requests need cookies on same-origin production calls. In development,
  use Vite's proxy so the SPA still calls relative URLs and auth behavior does not
  fork by environment.
- Buzola is client-only; there is no Worker SSR entry in this pattern.
- Verify selective routing against the installed Wrangler schema (route arrays
  require a sufficiently recent Wrangler); never guess glob support.

## Relationships — why

- **requires `buzola` + `vite`** — this is specifically a client-rendered Buzola
  bundle served by Vite locally and built as Worker assets.
- **requires `cloudflare`** — production delivery uses a Worker assets binding.
- **recommends `lopata`** for the local Worker and **`vozka`** for the single
  production deployable.
