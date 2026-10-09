---
id: zerops-fabrika-auth
kind: technology
title: Fabrika IAM with contract enforcement at the proxy on Zerops
slot: authz
provides: [authentication, authorization, proxy-enforcement]
requires: [zerops-platform]
recommends: []
conflicts: [propustka, cloudflare-access, auth-password-kv]
npm: ["@fabrika/app@^0.0.4", "@fabrika/db@^0.0.4", "zod@^3.25.76"]
status: wip
sources:
  - where: "packages/app/skill/SKILL.md in fabrika-platform (the `fabrika-app` skill)"
    read: "The application rules: contract first, access forms, table policies, what the checker refuses, what is not built."
  - where: "examples/zerops-app/fabrika.contract.ts + src/db/tables.ts + src/app.ts in fabrika-platform"
    read: "A worked contract: the vocabulary, the `/api` mount, the access forms and the handlers behind them."
  - where: "docs/reference/application-runtime.md (Contracts, Serving a contract) in fabrika-platform"
    read: "What the proxy and `boot` check per request, in order, and what `boot` refuses to start with."
  - where: "docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md + 0023-one-session-per-host.md in fabrika-platform"
    read: "One evaluator at the proxy, the endpoint table, per-host session handoff."
---

# Fabrika IAM with contract enforcement at the proxy

The application declares its whole access surface in `fabrika.contract.ts`:
`defineContract(vocabulary, (c) => surface)` from `@fabrika/app/contract`. The
vocabulary is its dimensions (e.g. `workspace` → `note`), exact action names and
roles that list actions (no `*`). Every endpoint is a procedure under a mount
(`c.rpc('/api', { callers: ['human', 'machine'] }, …)`) with an access form, plus
`c.health('/healthz')`, which Zerops requires. There are no other routes,
middleware, `authenticate` or custom server.

`fabrika.config.ts` compiles it with `compileContract(contract, tables)` and hands
the provider the artifact (`target.contract`), the endpoint table
(`target.proxy: { upstream, ...contractProxyTable(artifact) }`) and the IAM
schema (`schema: schemaFromContract(artifact)`). A contract application has no
gates; the provider refuses one whose proxy carries gates. Control reads the
contract from the deployed commit, and a widening on a protected environment
(`prod` by default) waits for a person to approve it in the console.

The proxy alone selects the endpoint, handles login and the reserved
`/__fabrika/auth/callback` route, checks the caller kind and the requirement, and
injects `X-Fabrika-Token` and `X-Fabrika-Endpoint`. App services stay private.
Never implement another gate evaluator in the app, the frontend or a Caddy route.

The framework, not application code, verifies the injected token (signature,
issuer, audience `<app>@<env>`, expiry), checks the proxy secret and the endpoint
header, then the caller kind, the requirement, admission and the strict input.
Per-object authorization is the access form: `on` (one object, 404 when missing
or not the caller's), `over` (a list, `ctx.within`), `in` (creation inside a
scope, 403 when not held). Handlers reach rows only through the stores of
`src/db/tables.ts` with the `Ref` or `Within` they are handed; they never take an
owner, user or tenant id from the input and never read `process.env`.

Not built on Zerops yet: the IAM membership transport, so an endpoint with
`creates`, `ctx.members` or `ctx.links` does not boot there.

## Local authentication is the same model

Run real IAM and the proxy locally. IAM's own `LOCAL_DEV_LOGIN` mechanism can
create a real local session; it is not an application dev flag. Restricted-role
tests need real IAM principals and grants, not the bootstrap admin for every
scenario. In unit tests, use `testKit` of `@fabrika/app/testing`, which runs the
production proxy decision and `boot` with a stand-in IAM; never synthesize a
caller in application code. When a request answers 401 or 403, report the missing
action or role; never loosen the contract, a role or a table policy to make it
pass. Credentials and raw request headers must not enter logs or committed
fixtures.
