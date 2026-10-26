---
id: fabrika-control
kind: technology
title: Fabrika Control — Cloudflare deploy control plane
slot: deploy-control-plane
provides: [deploy-control-plane, deployment, resource-provisioning, schema-reconciliation, secret-sync]
requires: [cloudflare, oblaka, wrangler, fabrika-iam]
recommends: []
conflicts: []
npm: ["@fabrika/provider-cloudflare"]
status: wip
sources:
  - where: "the predecessor control-plane repository — README.md, MIGRATION.md, packages/config/src/, packages/core/src/{deploy,plan}.ts"
    read: "The current defineApp contract, deploy plan order, per-app state namespace, single-account topology, registry and cut-over procedure."
  - where: "@fabrika/provider-cloudflare (installed source/types)"
    read: "The exact AppConfig/ResourceContext/AppPipeline fields and re-exported oblaka primitives; this is 0.x, so do not infer fields from memory."
  - where: "the predecessor control-plane examples"
    read: "A full app config with a stable app id, ResourceContext, Fabrika IAM schema, Worker resources, and pipeline secrets."
---

# Fabrika Control

## What it is

The deploy control plane for the Cloudflare + Fabrika IAM ecosystem. An app owns one
`fabrika.config.ts` with `defineApp({ id, resources, schema?, pipeline? })`. Fabrika Control
clones the repository and executes the complete deployment in order: build,
resource provisioning through oblaka, D1 migrations, `wrangler deploy`, Fabrika IAM
schema reconciliation and Worker secret sync.

The app imports its deploy authoring surface from **`@fabrika/provider-cloudflare` only**. That
package re-exports oblaka's `Worker`, `D1Database`, `R2Bucket`, `Queue`,
`ServiceReference`, etc., plus the Fabrika IAM schema types.

## When & why to use

- A production Cloudflare app in an account already managed by Fabrika Control + Fabrika IAM.
- You want repo config to declare resources, domain, authz vocabulary, build and
  secrets while the control plane owns credentials, deploy locking and execution.
- You are replacing per-app GitHub Actions that separately run oblaka, migrations,
  wrangler, Fabrika IAM provisioning and secret installation.

## When NOT to use

- The app is not deployed to Cloudflare.
- The target account has no Fabrika Control plane. Bootstrapping Fabrika Control/Fabrika IAM for
  an account is platform work, not an app scaffold step.
- A tiny experimental Worker intentionally deploys directly from a laptop or its
  own workflow; use the direct `app-deploy` pattern instead.

## App contract

```ts
import type { AppSchema, ResourceContext } from '@fabrika/provider-cloudflare'
import {
	D1Database,
	defineApp,
	ServiceReference,
	Worker,
} from '@fabrika/provider-cloudflare'

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

- **`id` is durable infrastructure identity.** Fabrika Control derives the default oblaka
  state namespace as `<id>-state`. Never rename it casually. During migration it
  must match the old namespace prefix or the first deploy can re-provision resources.
- **Use `ctx.domain`, not an app-specific hostname env var**, for the Worker custom
  domain. The registry owns the domain per app environment.
- **One Fabrika Control per Cloudflare account.** A multi-account app is registered in each
  account's independent Fabrika Control; the committed config remains account-neutral.
- **`schema` is deploy-time authz vocabulary; gates are not.** Native Fabrika IAM
  `AppGates` live in Worker runtime code and are passed to `PropustkaAuth`.
  Cloudflare Access declarations do not belong in a native-auth config.
- **Declare every required secret in `pipeline.secrets`.** Fabrika Control resolves it from
  the per-app/per-env vault and installs it. Do not add an independent
  `wrangler secret put` workflow.
- **Verify installed `@fabrika/provider-cloudflare` types.** It is a 0.x package; fields such as
  `pipeline.vars` may differ between the published package and repository head.
- **Do not hand-edit `wrangler.jsonc`.** Fabrika Control/oblaka materializes it before the
  migration and deploy steps.

## Local development seam

Fabrika Control owns production deployment, not the local feedback loop. Export the resource
builder and reuse it from a thin `oblaka.ts` local shim where the installed APIs
permit it. Generate `wrangler.jsonc`, run the Worker with lopata, and run the SPA
with Vite. This keeps local binding definitions and production resources derived
from one graph instead of maintaining two copies.

## Relationships — why

- **requires `oblaka` + `wrangler`** — Fabrika Control provisions the resource graph with
  oblaka, then invokes wrangler for D1 migrations, Worker deploy and secrets.
- **requires `fabrika-iam`** — the control plane is authenticated by Fabrika IAM and
  reconciles an app's declared schema into it.
- **requires `cloudflare`** — Fabrika Control is a Cloudflare-specific deployment system.
