---
id: vozka-app-deploy
kind: pattern
title: App deploy — Vozka-managed Cloudflare lifecycle
slot: null
provides: [ci-deploy, cf-deploy, infra-provisioning, schema-reconciliation, secret-sync]
requires: [vozka, propustka, oblaka, wrangler]
recommends: []
conflicts: [app-deploy]
status: wip
sources:
  - where: "vozka — MIGRATION.md + packages/core/src/{plan,deploy}.ts"
    read: "Registry fields, trigger routing, deploy locks, step order, state continuity and migration/cut-over rules."
  - where: "vozka examples"
    read: "A native-Propustka app shape with one resource graph plus its schema, build, and secrets pipeline."
---

# Vozka-managed app deploy

## What it is

The application repository declares its complete deploy surface in
`vozka.config.ts`; the account's Vozka control plane owns GitHub triggers/manual
runs, deploy credentials, per-app/per-env locking, logs and execution. The app no
longer maintains a workflow that manually sequences oblaka, wrangler, Propustka
and secrets.

## Scaffold contract

- Commit `vozka.config.ts` with a stable app `id`, environment-neutral
  `resources(ctx)`, optional Propustka `schema`, and `pipeline`.
- Export the resource builder for the local `oblaka.ts` shim so the graph does
  not drift between lopata and production.
- Read the production hostname from `ctx.domain`.
- Bind `IAM: ServiceReference('propustka-worker')` only off-local; set a single
  explicit local-dev flag for the app's deterministic auth context.
- Declare third-party runtime secrets in `pipeline.secrets`. Vozka platform
  Cloudflare credentials and the Propustka provisioning key are not app secrets.
- Register repository, environment, domain, trigger ref and secret values in
  the target account's Vozka. That external registration is an operator step,
  not committed application config.

## Deploy order (owned by Vozka)

1. run `pipeline.build`,
2. provision/materialize the oblaka resource graph into `wrangler.jsonc`,
3. apply every declared D1 migration remotely,
4. run `wrangler deploy`,
5. reconcile the Propustka authz schema,
6. sync declared Worker secrets.

The exact plan comes from the installed Vozka engine. Do not reproduce this
sequence in a parallel GitHub Actions workflow.

## Migration/cut-over gotchas

- Preserve `<app-id>-state`; dry-run and verify that the first Vozka deploy sees
  existing resources instead of creating replacements.
- The first schema reconcile should be a no-op. Diff committed actions/scopes/
  roles against live Propustka before cut-over.
- A multi-account app is registered in multiple independent Vozka instances;
  branch/ref routing decides which account acts on a push.
- During migration, only one deploy path may own a target. Delete the old
  workflow after a real Vozka deploy is green, not before.
- Vozka is 0.x: verify current dry-run credential/network requirements instead
  of assuming a dry-run is offline.

## Relationships — why

- **requires `vozka`**, which orchestrates **`oblaka` + `wrangler`**.
- **requires `propustka`** because schema reconciliation and the ecosystem's
  control-plane authentication are part of this lifecycle.
- **conflicts `app-deploy`** — that pattern is the direct per-repo workflow
  alternative. One target must not deploy through both.
