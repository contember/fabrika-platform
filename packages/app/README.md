# `@fabrika/app`

The server framework for Fabrika applications: the contract, the runtime that
serves it, typed RPC, structural errors, and a typed browser client.

An application declares its whole access surface in `fabrika.contract.ts` and
serves it through `implement`. The platform builds the proxy's endpoint table from
the same contract, and the proxy is the only enforcement point. The application
receives a verified Fabrika token and checks application-owned objects through the
access form of each endpoint.

## Installation

```bash
bun add @fabrika/app
```

## Entrypoints

| Entrypoint                | What it is                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `@fabrika/app`            | Typed RPC (`initRpc`, `createRpcClient`), structural errors, `FetchService` type.   |
| `@fabrika/app/contract`   | `defineContract` and the `c.*` kit; browser-safe.                                   |
| `@fabrika/app/implement`  | `implement`: the handlers of a contract.                                            |
| `@fabrika/app/client`     | `createClient`: the typed browser client of a contract mount.                       |
| `@fabrika/app/build`      | The generated entrypoint `fabrika app build` writes.                                |
| `@fabrika/app/bun`        | `createBunHandler`, `serveContract`.                                                |
| `@fabrika/app/cloudflare` | `createCloudflareWorker`, `createContractWorker`.                                   |
| `@fabrika/app/service`    | The installation's own services only: `defineServiceContract`, `serveService`.      |
| `@fabrika/app/testing`    | `testKit`: the application behind the production proxy decision and a stand-in IAM. |

## A contract application

```ts
// fabrika.contract.ts
import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const NoteList = z.strictObject({
	items: z.array(z.strictObject({ id: z.uuid(), title: z.string() })),
})

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: {} },
	actions: { 'notes.read': 'Read notes' },
	roles: { reader: { grants: ['notes.read'] } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human', 'machine'] }, {
		notes: {
			list: c.query({
				output: NoteList,
				access: { action: 'notes.read', over: 'workspace' },
			}),
		},
	}),
	health: c.health('/healthz'),
}))
```

```ts
// src/app.ts
import { implement } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'
import { database } from './db/database'
import { notes } from './db/stores/notes'

export default implement(contract, {
	database,
	deps: () => ({}),
	handlers: () => ({
		api: {
			notes: {
				list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
			},
		},
	}),
})
```

An application has no middleware, no raw routes and no custom server.
`fabrika app build` writes the generated entrypoint, which boots the
implementation with `serveContract` on Bun or `createContractWorker` on Cloudflare.
See `examples/zerops-app` and the `fabrika-app` agent skill (`skill/SKILL.md`).

## Portable RPC contracts

The RPC library serves the `{ method, input }` wire protocol. Put only DTOs and
type-only procedure declarations in a browser-safe contract package. The browser
does not need to import the server router, its validators, or its context:

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

Input and output validators may use any Standard Schema implementation. A row
handler of an installation service serves such a router with `dispatchRpcRequest`
from `@fabrika/app/service`.

## Runtime adapters

Both adapters serve a `FetchService<Env>`: an object with
`fetch(request, env, exec)`. `serveService` returns one for a service contract.

A Cloudflare Worker module imports `@fabrika/app/cloudflare`:

```ts
import { createCloudflareWorker } from '@fabrika/app/cloudflare'
import { service } from './app'

export default createCloudflareWorker(service)
```

A long-running Bun process wraps the service with `createBunHandler()`:

```ts
import { createBunHandler } from '@fabrika/app/bun'
import { service } from './app'

const handler = createBunHandler(service, env, {
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
