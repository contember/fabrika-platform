# `@fabrika/app`

The server framework for Fabrika applications: Fetch-based HTTP routing,
middleware, typed RPC, object-level authorization, and a typed browser client.

Proxy gates remain the application's structural front door. The app receives a
verified Fabrika authorization context and uses `.require(action, scope)` for
checks that depend on application-owned objects.

## Installation

```bash
bun add @fabrika/app
```

## Example

```ts
import {
	type AuthContext,
	createRpcClient,
	defineApp,
	initRpc,
	type Middleware,
	route,
} from '@fabrika/app'
import { z } from 'zod'

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> }
}

interface Ctx {
	env: Env
	auth: AuthContext
}

const rpc = initRpc<Ctx>()

const appRouter = rpc.router({
	projects: rpc.router({
		rename: rpc.procedure
			.input(z.object({ id: z.string(), name: z.string() }))
			.require('project:write', (input) => ({
				type: 'project',
				value: input.id,
			}))
			.mutation(async ({ ctx, input }) => {
				await renameProject(ctx.env, input.id, input.name)
				return { ok: true }
			}),
	}),
})

export type AppRouter = typeof appRouter

const auth: Middleware<Ctx> = async (_request, ctx, next) => {
	ctx.auth = await readFabrikaAuth(ctx.env)
	return next()
}

export const app = defineApp<Env, Ctx>({
	context: (env) => ({ env, auth: anonymousAuth() }),
	middleware: () => [auth],
	routes: [
		route.get('/health', () => new Response('ok')),
		route.rpc('/api/rpc', appRouter),
	],
	assets: (env) => env.ASSETS,
})

export const api = createRpcClient<AppRouter>({ baseUrl: '/api/rpc' })
```

Input and output validators may use any Standard Schema implementation.

## Portable RPC contracts

Put only DTOs and type-only procedure declarations in a browser-safe contract
package. The browser does not need to import the server router, its validators,
or its context:

```ts
import type { RpcProcedureContract } from '@fabrika/app'

export interface AppRpcContract {
	projects: {
		list: RpcProcedureContract<
			{ ownerId: string },
			{ id: string; name: string }[]
		>
	}
}
```

The server verifies that its router implements the contract, while the browser
uses the same contract directly:

```ts
import type { AppRpcContract } from '@example/app-contract'
import { createRpcClient, initRpc, type RpcRouterFor } from '@fabrika/app'

const rpc = initRpc<Ctx>()

export const appRouter = rpc.router({
	projects: rpc.router({
		list: rpc.procedure.input(listInput).output(projectList).query(listProjects),
	}),
}) satisfies RpcRouterFor<Ctx, AppRpcContract>

export const api = createRpcClient<AppRpcContract>({ baseUrl: '/api/rpc' })
```

## Runtime adapters

`defineApp()` builds the runtime-neutral Fetch request pipeline. Runtime
entrypoints adapt that application explicitly.

A Cloudflare Worker module imports `@fabrika/app/cloudflare`:

```ts
import { createCloudflareWorker } from '@fabrika/app/cloudflare'
import { app } from './app'

export default createCloudflareWorker(app)
```

A long-running Bun process wraps the app with `createBunHandler()`:

```ts
import { defineApp, route } from '@fabrika/app'
import { createBunHandler } from '@fabrika/app/bun'

const app = defineApp<Deps, Ctx>({
	context: (deps, request, exec) => ({ deps, request, exec }),
	routes: [route.get('/healthz', () => Response.json({ status: 'ok' }))],
})

const handler = createBunHandler(app, deps, {
	onBackgroundError: () => console.error('background task failed'),
})

const server = Bun.serve({ fetch: handler.fetch })

const shutdown = async (): Promise<void> => {
	await server.stop(false)
	await handler.drain()
	await closeApplicationResources()
}
```

`drain()` waits for every task registered through the request execution context's
`waitUntil()`. Stop accepting requests before draining, then close databases and
other process resources.

## Runtime conformance

Use the test-runner-neutral `@fabrika/app/testing` entrypoint to prove that a
portable route behaves the same through direct Fetch dispatch and both runtime
adapters:

```ts
import { assertAppRuntimeConformance } from '@fabrika/app/testing'

const response = await assertAppRuntimeConformance({
	app,
	createEnv: () => createIsolatedTestEnv(),
	createRequest: () => new Request('https://app.test/healthz'),
})
```

The helper drains registered background work and compares normalized status,
headers, and text body. Do not use it for routes that exist in only one runtime
composition.
