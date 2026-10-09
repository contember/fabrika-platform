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
  - where: "examples/zerops-app/fabrika.contract.ts + src/app.ts + README.md in fabrika-platform"
    read: "The contract's mounts, `implement` over the data layer, and the limits of the example's local run instructions."
  - where: "docs/reference/application-runtime.md (Serving a contract, Testing a contract application) in fabrika-platform"
    read: "The generated entrypoint, the framework variables `boot` needs, `testKit` and the generated tests."
  - where: "docs/reference/local-development.md + packages/local-stack/CLAUDE.md in fabrika-platform"
    read: "Real IAM/proxy/Postgres topology, local endpoints and IAM-owned login bypass."
  - where: "packages/local-stack/src/app-registration.ts in fabrika-platform"
    read: "Local schema and return-origin registration using the same IAM contract as deployment."
---

# Local Bun SPA and API

Apply this to a client-rendered React/Buzola app served with its API by the
generated Bun entrypoint of a contract application. The contract declares both:
the SPA as `c.spa(prefix, { dir, access })`, served from the built asset
directory for signed-in people, and the API as a `c.rpc` mount. An unknown
procedure under an RPC prefix is 404, never the SPA. Use Bun-native asset bundling
and Buzola codegen; the SPA's build commands are the only commands the authored
`zerops.yaml` may add. The SPA reads no `import.meta.env` other than
`FABRIKA_PUBLIC_*` and calls the API through `createClient(contract, 'api')` of
`@fabrika/app/client`.

## Local composition to scaffold

The development loop needs PostgreSQL, real IAM, a proxy with this application's
endpoint table (`contractProxyTable` of the compiled contract) and a private Bun
upstream started the way the platform starts it: `fabrika db migrate`, then
`fabrika/entry.generated.ts` (`fabrika app build` writes it) with the framework
variables `boot` refuses to start without: `FABRIKA_APP_ID`,
`FABRIKA_APP_DATABASE_URL`, `FABRIKA_IAM_ISSUER`, `FABRIKA_IAM_APP_ID`,
`FABRIKA_CONTRACT_DIGEST`, a `FABRIKA_PROXY_SECRET` of at least 32 characters that
the proxy sends, and, for a `c.files` collection, `FABRIKA_APP_STORAGE_*`.
Register the application's `schemaFromContract` schema and exact local proxy
return origin with local IAM. Keep the local database and credentials separate
from the installed production platform.

Use the existing Fabrika local-stack composition as the reference. From the
**fabrika-platform repository root**, `bun run local:up` starts its documented
services, and `bun run local:status` reports them. It pre-registers the fixture
apps, not every new builder project. The public notes fixture is available at
`http://notes.fabrika.localhost:18081` through its proxy.

A new app needs its own documented local service wiring and registration. Establish
that wiring as the app's foundation work and verify it before reporting a working
preview. If the local runtime cannot reach IAM, or a required registration cannot
be made, report the missing prerequisite rather than adding fake auth or bypassing
the proxy.

Before the browser loop, run the application's own checks: `bun test` with
`FABRIKA_TEST_POSTGRES_URL` set (a database test that skips proves nothing),
`fabrika db test-scaffold` after every contract or table change, and
`fabrika-check`.

## Preview and acceptance

Use the **proxy origin** as the browser preview and opice target, including its
actual port. Do not assume `localhost:5173` or use the private upstream as the
authenticated preview. Run the real login/callback flow and an authorization
denial, in addition to the product's success scenario. The local IAM login bypass
is a bootstrap-admin convenience; role-specific tests use real restricted grants.

Keep the coding agent, source, dev runtime and browser test loop local. The local
Zerops emulator can witness Control orchestration; it cannot prove real Zerops
builds, routing or infrastructure behavior.
