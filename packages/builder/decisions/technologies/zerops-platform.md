---
id: zerops-platform
kind: technology
title: Zerops through the Fabrika provider
slot: platform
provides: [platform, private-services, managed-deploy]
requires: [bun, postgres]
recommends: []
conflicts: [cloudflare]
npm: ["@fabrika/provider-zerops@^0.0.4", "@fabrika/app@^0.0.4"]
status: wip
sources:
  - where: "examples/zerops-app/fabrika.config.ts + zerops.yaml in fabrika-platform"
    read: "Current defineApp shape, private runtime, database references and repository-root build descriptor."
  - where: "packages/provider-zerops/src/types.ts + src/index.ts in fabrika-platform"
    read: "Provider-owned authoring contract and exports; verify installed versions before use."
  - where: "docs/reference/zerops-platform.md in fabrika-platform"
    read: "Live-verified routing, PostgreSQL TLS, sizing and probe constraints."
---

# Zerops through the Fabrika provider

Use this for applications deployed by an existing Fabrika installation. Import
`defineApp`, `ZeropsResourceContext` and `ZeropsServiceSpec` from
`@fabrika/provider-zerops`. Keep `fabrika.config.ts` as the app's deploy source of
truth: stable `id`, `schema`, `pipeline` and `target` with `platform: 'zerops'`.

## Application contract

- Declare services through `target.services(ctx)`. Select the runtime explicitly
  with `target.deployService` when declaring multiple services. Set
  `target.zeropsSetup` to the matching setup in repository-root `zerops.yaml`.
- Declare `target.proxy: { upstream, gates }` with the private runtime address.
  Set runtime `enableSubdomainAccess: false`; only the namespace proxy has public
  routing. A custom domain belongs on the proxy, never the app service.
- Leave project placement to Control's environment/namespace registry. Keep
  provider tokens and concrete project coordinates out of application source.
- Use the public example's Bun adapter (`@fabrika/app/bun`) for the long-running
  Fetch application. Serve built SPA assets from the private application; preserve
  API errors instead of falling through to `index.html`.
- Commit `zerops.yaml` and the Bun lockfile at the app repository root. Zerops
  performs its build; the descriptor declares build/deploy files, start command,
  ports and probes. Probe durations are Go duration strings bounded to 10s–1h.
- Run repeatable, concurrency-safe PostgreSQL migrations in `run.initCommands`,
  which runs on every container start. A readiness check gates deployment;
  `run.healthCheck` is the separate runtime liveness mechanism.

## Data and configuration

The default public config declares an app-owned PostgreSQL service. A cheap
namespace can instead supply the typed shared PostgreSQL binding: consult
`examples/zerops-app/fabrika.cheap.config.ts` and its matching descriptor before
selecting that variant. Preserve the administrator's namespace assignment.

Use the provider's PostgreSQL TLS reference including the database name and
`sslmode=require`; do not infer a connection string from a hostname. Service names
must satisfy `^[a-z0-9]{1,25}$` and references may address only owned services and
declared namespace resources.

The provider owns isolation fields. Secret values live at service level in Zerops,
not in config, YAML or project-level environment variables. `pipeline.secrets`
names requirements; it does not add a deploy-time secret synchronization step.
Control supplies reserved managed variables such as `FABRIKA_IAM_ISSUER`,
`FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE`; do not redeclare them.
