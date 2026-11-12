---
id: cf-contract-app
kind: pattern
title: A contract application in one Durable Object per environment, run locally on lopata
slot: app-delivery-shape
provides: [spa, worker-api, local-development, proxy-preview]
requires: [cloudflare, cf-fabrika-contract, durable-objects, lopata, oblaka, bun, react, buzola]
recommends: [opice]
conflicts: [single-worker-spa, zerops-local-app]
status: wip
sources:
  - where: "examples/app/README.md + src/app.ts + src/db/tables.ts + db/migrations/ + build-web.ts + lopata.config.ts + oblaka.ts in fabrika-platform"
    read: "`serve` over the scoped data layer, the SQLite migrations, the SPA build, and the local run of proxy, application and IAM."
  - where: "docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md in fabrika-platform"
    read: "Why the application runs in one Durable Object per environment, and what that object owns."
  - where: "docs/reference/cloudflare-platform.md (A Durable Object's SQLite) in fabrika-platform"
    read: "Transactions, savepoints and what blocks the object while one is open."
  - where: "packages/app/skill/references/spa.md in fabrika-platform"
    read: "The SPA on `@fabrika/ui` and `@fabrika/app/react`, and theming through `--fui-*` tokens."
---

# A contract application on Cloudflare

Apply this to a client-rendered React/Buzola application and its API on
Cloudflare Workers, in the layout of `examples/app`.

- **One Durable Object per environment** holds the application's SQLite
  (ADR-0065). Migrations are `db/migrations/*.sql` (STRICT tables, timestamps as
  UTC ISO text), applied by the object. `src/db/tables.ts` declares the table
  policies over the schema `fabrika db codegen` writes, and `src/app.ts` is
  `serve(contract, { database: scoped(tables) })`. Do not add D1, KV or a second
  database: the object is the application's whole state, beside the files bucket
  the deployer binds.
- **The Worker entrypoint is generated** by `fabrika app build --provider=cloudflare`
  (`fabrika/entry.generated.ts`, `fabrika/migrations.generated.ts`). Never edit it.
- **The SPA** is built with Bun (`build-web.ts`) into the directory its `c.spa`
  mount names, and the config's `pipeline.build` runs that build. It uses the
  paved-road kit, `@fabrika/ui` and `@fabrika/app/react`, themed through `--fui-*`
  overrides in its own stylesheet.
- **Locally**, lopata runs the proxy Worker, the application Worker with its
  object and bucket, and IAM over service bindings (`oblaka.ts`,
  `lopata.config.ts`). Open the proxy's address, never the application Worker's.
- **After a contract or table change**, run `fabrika db codegen`,
  `fabrika db test-scaffold` and `fabrika app build`, and commit what they write.
  Run `fabrika-check .` yourself: the Cloudflare build does not run it yet.
