---
id: cf-app
title: "Contract application on Cloudflare — one Durable Object per environment + Fabrika IAM"
goal: "Build and verify a React/Buzola contract application on a local lopata run behind the proxy Worker and real IAM, ready for the installed Fabrika Control on Cloudflare to deploy."
support: supported
decisions:
  - cloudflare
  - cf-fabrika-contract
  - cf-contract-app
  - durable-objects
  - lopata
  - oblaka
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
  SPA and the local lopata run.
- `durable-objects`, `lopata`, `oblaka`, `bun`, `react`, `buzola` and `opice` are
  reused as they are.

The selection is requires-closed and occupies each exclusive slot once. It
selects no D1, KV, `fabrika-iam` or `fabrika-control`: the contract replaces the
application's own IAM tables, and the installation's Control plane is not part of
the application.

## Seeds

No seed decision covers a Durable Object's SQLite yet. Create a scenario's data
through the application's own endpoints, as a signed-in person, in the
scenario's setup. Never write to the object's storage directly.

## Local verification

1. Install with Bun and typecheck. After a contract or table change, run
   `fabrika db codegen`, `fabrika db test-scaffold` and `fabrika app build`.
2. Run the application's tests (`testKit` on `@fabrika/db/testing-sqlite`,
   denials included) and `fabrika-check .`.
3. Build the SPA, start the local lopata run, open the proxy's address, sign in,
   and run the targeted opice scenario against it.
4. Publish that address with `fabrika builder preview --url=…` and report the checks.

## Deployment

The builder's `connect` and `deploy` work with a Zerops installation only. An
application on this preset is deployed by the installed Fabrika Control on
Cloudflare from a pushed commit, started from that installation's console. Ask
the human to commit and push; never deploy from the local machine.
