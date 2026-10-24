---
id: zerops-platform
kind: technology
title: Zerops through the Fabrika provider
slot: platform
provides: [platform, private-services, managed-deploy]
requires: [bun, postgres]
recommends: []
conflicts: [cloudflare]
npm: ["@fabrika/provider-zerops@0.9.0-dev.0", "@fabrika/app@0.9.0-dev.0", "@fabrika/cli@0.9.0-dev.0"]
status: wip
sources:
  - where: "examples/zerops-app/fabrika.config.ts + zerops.yaml in fabrika-platform"
    read: "Current defineApp shape with `target.contract`, the private runtime and the locked repository-root descriptor."
  - where: "packages/provider-zerops/src/execution.ts + CLAUDE.md in fabrika-platform"
    read: "The generated build, init commands, start script, readiness check and crontab of a contract application."
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

## Deploy configuration

- Declare services through `target.services(ctx)`. Select the runtime explicitly
  with `target.deployService` when declaring multiple services. Set
  `target.zeropsSetup` to the matching setup in repository-root `zerops.yaml`.
- A contract application hands `target.contract` (the compiled
  `fabrika.contract.ts`) and `target.proxy: { upstream, ...contractProxyTable(artifact) }`
  with the private runtime address (port 3000). Set runtime
  `enableSubdomainAccess: false`; only the namespace proxy has public routing. A
  custom domain belongs on the proxy, never the app service.
- Leave project placement to Control's environment/namespace registry. Keep
  provider tokens and concrete project coordinates out of application source.
- The platform owns the setup of a contract application (ADR-0043). The authored
  `zerops.yaml` keeps only `setup`, `build.base`, `build.os` and the SPA's
  `build.buildCommands`; every other key is refused. The platform generates the
  rest: a frozen install, the application's `bun test`, a reinstall, the
  generated entrypoint, `tsc` (with `web/`), `fabrika-check`, the deploy gate on the contract's
  health path, and the `run` section. Its init commands run `fabrika db migrate`,
  `fabrika db codegen --verify` and `fabrika db test-isolation`, then its
  start script runs `fabrika/entry.generated.ts`; each `c.cron` job becomes a crontab entry
  `fabrika job run <name>`. The build has no database, so the database tests skip
  there; only the generated isolation tests run again, at container start. Run
  the rest against a test database before you push.
- Commit the Bun lockfile at the app repository root, and commit what
  `fabrika db codegen` and `fabrika db test-scaffold` write. Never edit a
  generated file (`fabrika/entry.generated.ts`, `src/db/schema.generated.ts`, the
  generated tests) by hand; regenerate it with its command.

## Data and configuration

The default public config declares an app-owned PostgreSQL service. A cheap
namespace can instead supply the typed shared PostgreSQL binding: consult
`examples/zerops-app/fabrika.cheap.config.ts` before selecting that variant.
Preserve the administrator's namespace assignment. A contract application has
one PostgreSQL database: the platform writes `FABRIKA_APP_DATABASE_URL` (the
service superuser's reference, which only the platform's launcher holds) and `FABRIKA_APP_ID`, and
the application's tables live in the schema `app_<id>`. The application names no
connection string; `@fabrika/app/bun` opens the data layer for it.

Service names must satisfy `^[a-z0-9]{1,25}$` and references may address only
owned services and declared namespace resources.

The provider owns isolation fields. Secret values live at service level in Zerops,
not in config, YAML or project-level environment variables. `pipeline.secrets`
names requirements; it does not add a deploy-time secret synchronization step.
Control supplies the reserved `FABRIKA_*` variables (`FABRIKA_IAM_ISSUER`,
`FABRIKA_IAM_APP_ID`, `FABRIKA_OPERATIONS_DSN`, `FABRIKA_RELEASE`,
`FABRIKA_CONTRACT_DIGEST`, `FABRIKA_PROXY_SECRET`, …); do not redeclare them. The
framework takes every `FABRIKA_*` name out of the process before the application
loads; handlers get their own variables through `deps`.

A `c.files` collection needs one `object-storage` service in `fabrika.config.ts`;
the provider writes `FABRIKA_APP_STORAGE_*` from it as references Zerops resolves,
and refuses a second bucket.

An endpoint with `creates`, `ctx.members` or `ctx.links` reaches IAM through the
membership transport: the platform writes `FABRIKA_IAM_RPC_URL` and the
environment's own `FABRIKA_IAM_RPC_KEY`, and refuses an app config that sets them.
