---
id: cf-contract-app
kind: pattern
title: A contract application in one Durable Object per environment, previewed locally with `fabrika app dev`
slot: app-delivery-shape
provides: [spa, worker-api, local-development, seed-strategy]
requires: [cloudflare, cf-fabrika-contract, bun, react, buzola]
recommends: [opice]
conflicts: [single-worker-spa, zerops-local-app, named-seeds, zerops-postgres-seeds]
status: wip
sources:
  - where: "examples/app/README.md + src/app.ts + src/db/tables.ts + db/migrations/ + build-web.ts in fabrika-platform"
    read: "`serve` over the scoped data layer, the SQLite migrations and the SPA build."
  - where: "docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md in fabrika-platform"
    read: "Why the application runs in one Durable Object per environment, and what that object owns."
  - where: "docs/reference/cloudflare-platform.md (A Durable Object's SQLite) in fabrika-platform"
    read: "Transactions, savepoints and what blocks the object while one is open."
  - where: "packages/app/skill/references/dev.md in fabrika-platform"
    read: "`fabrika app dev`: the in-memory SQLite on Cloudflare, the stand-in IAM, `dev/seed.ts` and the persona picker."
  - where: "packages/app/skill/references/spa.md + app-setup.md in fabrika-platform"
    read: "The SPA on `@fabrika/ui` and `@fabrika/app/react`, theming through `--fui-*` tokens, and which generated files are ignored."
---

# A contract application on Cloudflare

Apply this to a client-rendered React/Buzola application and its API on
Cloudflare Workers, in the layout of `examples/app`. It replaces the
`durable-objects`, `d1`, `kv`, `lopata`, `oblaka` and `wrangler` decisions for
this shape; do not add them.

- **One Durable Object per environment** holds the application's SQLite
  (ADR-0065). The deployer declares and binds it; the application declares no
  object, database or migration of its own. Migrations are `db/migrations/*.sql`
  (STRICT tables, timestamps as UTC ISO text), applied by the object.
  `src/db/tables.ts` declares the table policies over the schema
  `fabrika db codegen` writes, and `src/app.ts` is
  `serve(contract, { database: scoped(tables) })`.
- **The Worker entrypoint is generated** by `fabrika app build --provider=cloudflare`
  (`fabrika/entry.generated.ts`, `fabrika/migrations.generated.ts`). Never edit
  either. Which generated files are committed and which are ignored is the app
  skill's list (`app-setup.md`, "Ignored files").
- **The SPA** is built with Bun (`build-web.ts`) into the directory its `c.spa`
  mount names, and the config's `pipeline.build` runs that build. Build it on the
  paved-road kit, `@fabrika/ui` and `@fabrika/app/react`, themed through `--fui-*`
  overrides in its own stylesheet. The example's page is deliberately bare and
  uses neither.
- **Locally**, `bun run build:web && bunx fabrika app dev` serves the application
  through the proxy decision and a stand-in IAM, on an in-memory SQLite. Pick the
  caller at `/__fabrika/dev`. The example's lopata run (`oblaka.ts`,
  `lopata.config.ts`) does not serve yet, and it reads this repository's packages;
  do not copy it.
- **Seeds** are `dev/seed.ts`, a `DevSeed` that writes through the application's
  endpoints and names the personas a scenario signs in as. A skeleton's
  `seeds: ['x']` names data that seed creates; there are no `seeds/*.sql` files.
- **After a contract or table change**, run `fabrika db codegen`,
  `fabrika db test-scaffold` and `fabrika app build`. Run `fabrika-check .`
  yourself: the Cloudflare build does not run it yet.
