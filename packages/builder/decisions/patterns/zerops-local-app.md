---
id: zerops-local-app
kind: pattern
title: Local Bun SPA and API behind real Fabrika IAM and proxy
slot: app-delivery-shape
provides: [spa, local-development, proxy-preview]
requires: [zerops-platform, zerops-fabrika-auth, bun, postgres, react, buzola]
recommends: [tailwind, opice]
conflicts: [single-worker-spa]
status: wip
sources:
  - where: "examples/zerops-app/src/server.ts + src/app.ts + README.md in fabrika-platform"
    read: "Bun backend composition and the limits of the example's local run instructions."
  - where: "docs/reference/local-development.md + packages/local-stack/CLAUDE.md in fabrika-platform"
    read: "Real IAM/proxy/Postgres topology, local endpoints and IAM-owned login bypass."
  - where: "packages/local-stack/src/app-registration.ts in fabrika-platform"
    read: "Local schema and return-origin registration using the same IAM contract as deployment."
---

# Local Bun SPA and API

Apply this to a client-rendered React/Buzola app served with its API by a Bun
process. Use Bun-native asset bundling and Buzola codegen. API namespaces must
return their own errors and 404s; only UI routes receive SPA fallback.

## Local composition to scaffold

The development loop needs PostgreSQL, real IAM, a proxy with this application's
gates and a private Bun upstream. Register the application's schema and exact
local proxy return origin with local IAM. The app's configured issuer and audience
must match the tokens IAM mints. Keep the local database and credentials separate
from the installed production platform.

Use the existing Fabrika local-stack composition as the reference. From the
**fabrika-platform repository root**, `bun run local:up` starts its documented
services, and `bun run local:status` reports them. It pre-registers the fixture
apps, not every new builder project. The public notes fixture is available at
`http://notes.fabrika.localhost:18081` through its proxy.

A new app needs its own documented local service wiring and registration; the
example's bare server command does not provide those. Establish that wiring as
the app's foundation work and verify it before reporting a working preview.
If the local runtime cannot reach IAM, or a required registration cannot be made,
report the missing prerequisite rather than adding fake auth or bypassing the
proxy.

## Preview and acceptance

Use the **proxy origin** as the browser preview and opice target, including its
actual port. Do not assume `localhost:5173` or use the private upstream as the
authenticated preview. Run the real login/callback flow and an authorization
denial, in addition to the product's success scenario. The local IAM login bypass
is a bootstrap-admin convenience; role-specific tests use real restricted grants.

Keep the coding agent, source, dev runtime and browser test loop local. The local
Zerops emulator can witness Control orchestration; it cannot prove real Zerops
builds, routing or infrastructure behavior.
