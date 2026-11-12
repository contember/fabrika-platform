---
id: cf-fabrika-contract
kind: technology
title: Fabrika IAM with contract enforcement at the proxy Worker on Cloudflare
slot: authz
provides: [authentication, authorization, proxy-enforcement]
requires: [cloudflare]
recommends: []
conflicts: [fabrika-iam, cloudflare-access, auth-password-kv, zerops-fabrika-auth]
npm: ["@fabrika/app@0.9.0-dev.13", "@fabrika/db@0.9.0-dev.13", "@fabrika/ui@0.9.0-dev.13", "@fabrika/provider-cloudflare@0.9.0-dev.13", "@fabrika/check@0.9.0-dev.13", "@fabrika/cli@0.9.0-dev.13", "zod@^3.25.76"]
status: wip
sources:
  - where: "packages/app/skill/SKILL.md in fabrika-platform (the `fabrika-app` skill)"
    read: "The application rules: contract first, access forms, table policies, what the checker refuses, what is not built."
  - where: "examples/app/README.md + fabrika.contract.ts + fabrika.config.ts + src/access/endpoints.ts in fabrika-platform"
    read: "A worked Cloudflare contract application: the mounts, the access forms, and the deploy surface `defineApp` owns."
  - where: "docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md + 0048-bind-cloudflare-delivery-to-the-recorded-commit.md in fabrika-platform"
    read: "One evaluator at the proxy; the deployer builds the proxy Worker from the contract of the recorded commit."
---

# Fabrika IAM with contract enforcement at the proxy Worker

The application declares its whole access surface in `fabrika.contract.ts`, as on
Zerops: a vocabulary, procedures under mounts (`c.rpc`), each with its callers and
access form, the SPA (`c.spa`) and `c.health`. There are no other routes,
middleware or custom server.

`fabrika.config.ts` is `defineApp({ id, pipeline })` from
`@fabrika/provider-cloudflare`, with at most the `worker` settings the app skill
allows (`app-setup.md`); it declares no resources, schema or platform bindings. The deployer reads the contract
from the checkout with the static reader Control uses, builds the proxy Worker
from `contractProxyTable(artifact)`, binds the application Worker to it, and
writes the framework variables, the proxy secret, the object binding and the
files bucket itself. Declaring any of them in the config is refused. Control
writes the IAM schema from the approved contract; the config declares none.

The proxy Worker alone selects the endpoint, handles login and injects
`X-Fabrika-Token` and `X-Fabrika-Endpoint`. The application Worker has no route
and no public URL. Never implement a second enforcement decision in the app or
the SPA. Per-object authorization is the access form (`on`, `over`, `in`), and
handlers reach rows only through the stores of `src/db/tables.ts`.

Choose this over `fabrika-iam`, the older native-login decision, for a new
application: `fabrika-iam` has the application hold D1 tables and call IAM
itself, which the contract replaces.
