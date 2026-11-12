---
id: cf-app
title: "Contract application on Cloudflare — one Durable Object per environment + Fabrika IAM"
goal: "Build and verify a React/Buzola contract application previewed with `fabrika app dev` behind the proxy decision, ready for the installed Fabrika Control on Cloudflare to deploy."
support: supported
decisions:
  - cloudflare
  - cf-fabrika-contract
  - cf-contract-app
  - bun
  - react
  - buzola
  - opice
build: "see §Local verification below"
---

# Stack: cf-app

The paved road on Cloudflare: the same contract, proxy, `@fabrika/ui`,
`@fabrika/db` and `fabrika-check` as `zerops-app`, with the application in one
Durable Object per environment instead of a Bun service with PostgreSQL. Use it
when the installation the application will run on is on Cloudflare.

**Maturity:** Fabrika, Buzola and opice are evolving 0.x components. The worked
reference is `examples/app` in the fabrika-platform repository; read it, and the
installed contracts, before scaffolding.

## Composition

- `cf-fabrika-contract` supplies the contract and the proxy Worker that enforces it.
- `cf-contract-app` composes the Durable Object, the generated entrypoint, the
  SPA, the local `fabrika app dev` preview and the seeds.
- `cloudflare`, `bun`, `react`, `buzola` and `opice` are reused. Of
  `cloudflare`'s recommendations (D1, KV, R2, Queue, oblaka, wrangler), none
  applies: the deployer owns every resource the application has.

The selection is requires-closed and occupies each exclusive slot once. It
selects no `fabrika-iam` or `fabrika-control`: the contract replaces the
application's own IAM tables, and the installation's Control plane is not part
of the application.

## Local verification

1. Install with Bun and typecheck. After a contract or table change, run
   `fabrika db codegen`, `fabrika db test-scaffold` and `fabrika app build`.
2. Run the application's tests (`testKit` on `@fabrika/db/testing-sqlite`,
   denials included) and `fabrika-check .`.
3. Build the SPA and start `fabrika app dev` with the `dev/seed.ts` the scenarios
   need. Run the targeted opice scenario against its address, picking the
   scenario's persona at `/__fabrika/dev`.
4. Publish that address with `fabrika builder preview --url=…` and report the checks.

`fabrika app dev` previews the application; it never replaces its tests.

## Deployment

The builder's `connect` and `deploy` work with a Zerops installation only. An
application on this preset is deployed by the installed Fabrika Control on
Cloudflare, from a pushed commit. Ask the human to commit and push; never deploy
from the local machine.
