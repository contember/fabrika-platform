---
id: cf-internal-app
title: "Full internal Cloudflare app — Buzola SPA + Propustka + Vozka"
goal: "From empty to a full internal app: Buzola SPA + Worker API, D1/R2/Queue/Cron/Workers AI, local Vite+lopata, native Propustka login, Vozka-managed production deploy, and green opice tests."
decisions:
  - cloudflare
  - lopata
  - oblaka
  - vozka
  - wrangler
  - vite
  - react
  - buzola
  - tailwind
  - d1
  - r2
  - queue
  - cron-triggers
  - workers-ai
  - propustka
  - bun
  - named-seeds
  - single-worker-spa
  - typed-worker-rpc
  - vozka-app-deploy
  - opice
build: "see §build recipe below"
---

# Stack: cf-internal-app

The production-grade **internal-app shape**: an internal, client-rendered Buzola/React
SPA backed by a Cloudflare Worker. It runs as a Vite SPA plus a lopata Worker
locally, ships as one Worker with static assets in production, logs people in
through native Propustka, and delegates the whole production lifecycle to Vozka.

Use `cf-lightweight` when an app only needs SPA + D1 and does not belong to the
Vozka/Propustka ecosystem. This preset deliberately includes the operational
primitives available to the stack: R2, Queue, Cron and Workers AI. Drop any of those at the
tech gate when the product has no corresponding workload.

## Composition

Frontend: `react` + `buzola` + `vite` + `tailwind`. Runtime/data: `cloudflare` +
`d1` + `r2` + `queue` + `cron-triggers` + `workers-ai`. Local development:
`lopata` + `oblaka` + `bun`. Authentication/authorization: native `propustka`.
Deployment: `vozka` + `wrangler` through the `vozka-app-deploy` pattern. Delivery:
`single-worker-spa` + `typed-worker-rpc`. Acceptance: `named-seeds` + `opice`.

requires-closure holds:

- `vozka` → {`cloudflare`, `oblaka`, `wrangler`, `propustka`};
- `propustka` → {`cloudflare`, `d1`};
- `single-worker-spa` → {`cloudflare`, `vite`, `buzola`};
- `typed-worker-rpc` → {`cloudflare`, `buzola`};
- `vozka-app-deploy` → {`vozka`, `propustka`, `oblaka`, `wrangler`};
- `buzola` → `react`; all CF resources → `cloudflare`; `named-seeds` → `d1`.

One per exclusive slot: platform, deploy-control-plane, app-delivery-shape,
client-worker-api, cf-dev-runtime, bundler, ui-framework, router, styling,
relational-db, ai-runtime, authz, js-runtime, seed-strategy and e2e-tests. There
is **no Cloudflare Access**
and no app-owned password auth; native Propustka owns both login and permission
resolution.

**Maturity:** Vozka, Propustka, Buzola, lopata and opice are 0.x/WIP. This is a
curated internal production stack, not the generic default. Pin the working
versions, read installed sources/types before scaffolding, and typecheck the
actual resource/auth config.

## Required application shape

### Local vs production delivery

- `bun run dev` starts the Vite/Buzola SPA (normally `:5173`).
- `bunx lopata dev` starts the Worker and local bindings (normally `:8787`).
- Vite proxies `/rpc`, `/api` and `/internal` to the Worker.
- Production builds the SPA to `dist/`; a Worker `ASSETS` binding with SPA
  fallback serves non-API paths. Selective `run_worker_first` patterns send only
  API namespaces through Worker code; those paths return their own 404s and
  never fall through to `index.html`.

### Native Propustka login

- Define one app id and one action/scope vocabulary shared by runtime auth and
  the schema in `vozka.config.ts`.
- Off-local, bind `IAM` to `propustka-worker` and inject `PROPUSTKA_URL` as the
  token issuer/login origin.
- Pass ordered `AppGates` to `PropustkaAuth`: normally a `service` rule followed
  by a `human` rule for each protected API path. Unmatched paths fail closed.
- Return `loginUrl` to the SPA on a human auth miss, redirect the browser to it,
  and attach every returned `setCookie` to the response.
- Local/opice runs synthesize a deterministic operator `AuthContext`; current
  `FakeIamClient` is for management methods, not request authentication.

### Typed Worker API

- Compose a validated method map behind one `/rpc` endpoint and export its
  inferred contract to the SPA through a type-only import.
- Authenticate once at the dispatcher, then require each feature handler to
  enforce its concrete `auth.can(...)` capability.
- Preserve Propustka's `loginUrl`/`setCookie` across the RPC response seam.

### Vozka deploy

- `vozka.config.ts` is the production source of truth: stable `id`, exported
  resource builder, schema and pipeline.
- `ctx.domain` owns the custom domain; `pipeline.secrets` lists required runtime
  secrets. Do not recreate deployment in `.github/workflows/deploy.yml`.
- A thin `oblaka.ts` reuses the resource builder only for the local lopata loop.
- The account operator registers repo/env/domain/trigger/secrets in Vozka. That
  is a deployment prerequisite, not a scaffold-time Cloudflare mutation.

## Build recipe (per-issue verify stage)

1. install with Bun; generate local `wrangler.jsonc` from the shared resource
   graph and apply D1 migrations + the issue's named seeds through lopata.
2. keep the lopata Worker and Vite SPA running as two background processes.
3. run the targeted opice scenario against the Vite URL; auth is the deterministic
   dev operator and external AI/providers use deterministic fakes.
4. run unit tests + `bun run typecheck` + the SPA production build. Validate
   `vozka.config.ts`/`oblaka.ts` through their real config-generation command when
   their raw-source type graph is intentionally excluded from `tsc`.
5. collapse the result. Production deployment remains Vozka's responsibility;
   do not deploy from an issue implementation loop.
