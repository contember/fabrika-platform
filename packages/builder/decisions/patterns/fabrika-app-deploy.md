---
id: fabrika-app-deploy
kind: pattern
title: App deploy — Fabrika-managed Cloudflare lifecycle
slot: null
provides: [ci-deploy, cf-deploy, infra-provisioning, schema-reconciliation, secret-sync]
requires: [fabrika-control, fabrika-iam, oblaka, wrangler]
recommends: []
conflicts: [app-deploy]
status: wip
sources:
  - where: "the predecessor control-plane repository — MIGRATION.md + packages/core/src/{plan,deploy}.ts"
    read: "Registry fields, trigger routing, deploy locks, step order, state continuity and migration/cut-over rules."
  - where: "the predecessor control-plane examples"
    read: "A native-IAM app shape with one resource graph plus its schema, build, and secrets pipeline."
---

# Fabrika-managed app deploy

## What it is

The application repository declares its complete deploy surface in
`fabrika.config.ts`; the account's Fabrika Control plane owns GitHub triggers/manual
runs, deploy credentials, per-app/per-env locking, logs and execution. The app no
longer maintains a workflow that manually sequences oblaka, wrangler, Fabrika IAM
and secrets.

## Scaffold contract

- Commit `fabrika.config.ts` with a stable app `id`, environment-neutral
  `resources(ctx)`, optional Fabrika IAM `schema`, and `pipeline`.
- Export the resource builder for the local `oblaka.ts` shim so the graph does
  not drift between lopata and production.
- Read the production hostname from `ctx.domain`.
- Bind `IAM: ServiceReference('propustka-worker')` only off-local; set a single
  explicit local-dev flag for the app's deterministic auth context.
- Declare third-party runtime secrets in `pipeline.secrets`. Fabrika Control platform
  Cloudflare credentials and the Fabrika IAM provisioning key are not app secrets.
- Register repository, environment, domain, trigger ref and secret values in
  the target account's Fabrika Control. That external registration is an operator step,
  not committed application config.

## Deploy order (owned by Fabrika Control)

1. run `pipeline.build`,
2. provision/materialize the oblaka resource graph into `wrangler.jsonc`,
3. apply every declared D1 migration remotely,
4. run `wrangler deploy`,
5. reconcile the Fabrika IAM authz schema,
6. sync declared Worker secrets.

The exact plan comes from the installed Fabrika Control engine. Do not reproduce this
sequence in a parallel GitHub Actions workflow.

## Migration/cut-over gotchas

- Preserve `<app-id>-state`; dry-run and verify that the first Fabrika Control deploy sees
  existing resources instead of creating replacements.
- The first schema reconcile should be a no-op. Diff committed actions/scopes/
  roles against live Fabrika IAM before cut-over.
- A multi-account app is registered in multiple independent Fabrika Control instances;
  branch/ref routing decides which account acts on a push.
- During migration, only one deploy path may own a target. Delete the old
  workflow after a real Fabrika Control deploy is green, not before.
- Fabrika Control is 0.x: verify current dry-run credential/network requirements instead
  of assuming a dry-run is offline.

## Relationships — why

- **requires `fabrika-control`**, which orchestrates **`oblaka` + `wrangler`**.
- **requires `fabrika-iam`** because schema reconciliation and the ecosystem's
  control-plane authentication are part of this lifecycle.
- **conflicts `app-deploy`** — that pattern is the direct per-repo workflow
  alternative. One target must not deploy through both.
