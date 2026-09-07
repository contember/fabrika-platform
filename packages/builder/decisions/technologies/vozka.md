---
id: vozka
kind: technology
title: Vozka — Cloudflare deploy control plane
slot: deploy-control-plane
provides: [deploy-control-plane, deployment, resource-provisioning, schema-reconciliation, secret-sync]
requires: [cloudflare, oblaka, wrangler, propustka]
recommends: []
conflicts: []
npm: ["vozka-config@^0.0.1"]
status: wip
sources:
  - where: "vozka — README.md, MIGRATION.md, packages/config/src/, packages/core/src/{deploy,plan}.ts"
    read: "The current defineApp contract, deploy plan order, per-app state namespace, single-account topology, registry and cut-over procedure."
  - where: "vozka-config (installed source/types)"
    read: "The exact AppConfig/ResourceContext/AppPipeline fields and re-exported oblaka primitives; this is 0.x, so do not infer fields from memory."
  - where: "vozka examples"
    read: "A full app config with a stable app id, ResourceContext, Propustka schema, Worker resources, and pipeline secrets."
---

# Vozka

## What it is

The deploy control plane for the Cloudflare + Propustka ecosystem. An app owns one
`vozka.config.ts` with `defineApp({ id, resources, schema?, pipeline? })`. Vozka
clones the repository and executes the complete deployment in order: build,
resource provisioning through oblaka, D1 migrations, `wrangler deploy`, Propustka
schema reconciliation and Worker secret sync.

The app imports its deploy authoring surface from **`vozka-config` only**. That
package re-exports oblaka's `Worker`, `D1Database`, `R2Bucket`, `Queue`,
`ServiceReference`, etc., plus the Propustka schema types.

## When & why to use

- A production Cloudflare app in an account already managed by Vozka + Propustka.
- You want repo config to declare resources, domain, authz vocabulary, build and
  secrets while the control plane owns credentials, deploy locking and execution.
- You are replacing per-app GitHub Actions that separately run oblaka, migrations,
  wrangler, Propustka provisioning and secret installation.

## When NOT to use

- The app is not deployed to Cloudflare.
- The target account has no Vozka control plane. Bootstrapping Vozka/Propustka for
  an account is platform work, not an app scaffold step.
- A tiny experimental Worker intentionally deploys directly from a laptop or its
  own workflow; use the direct `app-deploy` pattern instead.

## App contract

```ts
import type { AppSchema, ResourceContext } from 'vozka-config'
import { D1Database, defineApp, ServiceReference, Worker } from 'vozka-config'

const APP_ID = 'example'

export const buildWorker = ({ env, domain }: ResourceContext) => {
	const local = env === 'local'
	return new Worker({
		dir: '.',
		name: APP_ID,
		main: './worker/index.ts',
		compatibility_date: '2026-07-10', // verify/update when scaffolding
		routes: domain ? [{ pattern: domain, custom_domain: true }] : [],
		bindings: {
			DB: new D1Database({ name: APP_ID, migrationsDir: 'migrations' }),
			...(local ? {} : { IAM: new ServiceReference('propustka-worker') }),
		},
		vars: {
			DEV: local,
			...(local ? {} : { PROPUSTKA_URL: process.env['PROPUSTKA_URL'] ?? '' }),
		},
	})
}

const schema: AppSchema = { scopes: [], actions: [], roles: {} }

export default defineApp({
	id: APP_ID,
	resources: buildWorker,
	schema,
	pipeline: { workerDir: '.', build: 'bun run build', secrets: [] },
})
```

## Load-bearing gotchas

- **`id` is durable infrastructure identity.** Vozka derives the default oblaka
  state namespace as `<id>-state`. Never rename it casually. During migration it
  must match the old namespace prefix or the first deploy can re-provision resources.
- **Use `ctx.domain`, not an app-specific hostname env var**, for the Worker custom
  domain. The registry owns the domain per app environment.
- **One Vozka per Cloudflare account.** A multi-account app is registered in each
  account's independent Vozka; the committed config remains account-neutral.
- **`schema` is deploy-time authz vocabulary; gates are not.** Native Propustka
  `AppGates` live in Worker runtime code and are passed to `PropustkaAuth`.
  Cloudflare Access declarations do not belong in a native-auth config.
- **Declare every required secret in `pipeline.secrets`.** Vozka resolves it from
  the per-app/per-env vault and installs it. Do not add an independent
  `wrangler secret put` workflow.
- **Verify installed `vozka-config` types.** It is a 0.x package; fields such as
  `pipeline.vars` may differ between the published package and repository head.
- **Do not hand-edit `wrangler.jsonc`.** Vozka/oblaka materializes it before the
  migration and deploy steps.

## Local development seam

Vozka owns production deployment, not the local feedback loop. Export the resource
builder and reuse it from a thin `oblaka.ts` local shim where the installed APIs
permit it. Generate `wrangler.jsonc`, run the Worker with lopata, and run the SPA
with Vite. This keeps local binding definitions and production resources derived
from one graph instead of maintaining two copies.

## Relationships — why

- **requires `oblaka` + `wrangler`** — Vozka provisions the resource graph with
  oblaka, then invokes wrangler for D1 migrations, Worker deploy and secrets.
- **requires `propustka`** — the control plane is authenticated by Propustka and
  reconciles an app's declared schema into it.
- **requires `cloudflare`** — Vozka is a Cloudflare-specific deployment system.
