// ─── Cloudflare Workers adapter ──────────────────────────────────────

import { FABRIKA_PROXY_SECRET, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import {
	APPLICATION_OBJECT_NAME,
	type ContractWorkerOptions,
	type ImplementationLoader,
	registerApplication,
	TICK_HEADER,
} from './cloudflare/application.js'
import { method } from './cloudflare/bindings.js'
import { CLOUDFLARE_APPLICATION_BINDING } from './cloudflare/names.js'
import type { FetchService, RequestExecutionContext } from './fetch.js'

export { markProductionProcess } from '@fabrika/db/production'
export {
	type ApplicationMigration,
	type ApplicationState,
	type ApplicationStorage,
	type ContractWorkerOptions,
	FabrikaApplication,
	type ImplementationLoader,
} from './cloudflare/application.js'

/** Minimal structural view of a Workers `ExecutionContext`. */
export interface CloudflareExecutionContext extends RequestExecutionContext {
	passThroughOnException(): void
}

/** Minimal structural view of a Workers cron `ScheduledController`. */
export interface CloudflareScheduledController {
	readonly scheduledTime: number
	readonly cron: string
	noRetry(): void
}

/** Minimal structural view of a Workers queue `MessageBatch`. */
export interface CloudflareMessageBatch {
	readonly queue: string
	readonly messages: ReadonlyArray<unknown>
}

export interface CloudflareWorkerOptions<Env> {
	scheduled?: (controller: CloudflareScheduledController, env: Env, exec: CloudflareExecutionContext) => Promise<void>
	queue?: (batch: CloudflareMessageBatch, env: Env, exec: CloudflareExecutionContext) => Promise<void>
}

export interface CloudflareWorker<Env> {
	fetch(request: Request, env: Env, exec: CloudflareExecutionContext): Promise<Response>
	scheduled?(controller: CloudflareScheduledController, env: Env, exec: CloudflareExecutionContext): Promise<void>
	queue?(batch: CloudflareMessageBatch, env: Env, exec: CloudflareExecutionContext): Promise<void>
}

/** Adapt a runtime-neutral `{ fetch }` service to a Workers module export. */
export function createCloudflareWorker<Env>(
	app: FetchService<Env>,
	options: CloudflareWorkerOptions<Env> = {},
): CloudflareWorker<Env> {
	const scheduled = options.scheduled
	const queue = options.queue
	return {
		fetch: (request, env, exec) => app.fetch(request, env, exec),
		...(scheduled ? { scheduled } : {}),
		...(queue ? { queue } : {}),
	}
}

// ─── Contract applications ───────────────────────────────────────────

/** The environment's proxy secret, which every request the Worker forwards to its object carries. */
function proxySecretOf(env: Readonly<Record<string, unknown>>): string {
	const secret = env[FABRIKA_PROXY_SECRET]
	if (typeof secret !== 'string' || secret === '') {
		throw new Error(`${FABRIKA_PROXY_SECRET} is not set; the application's Worker forwards nothing to its object without it`)
	}
	return secret
}

/** The environment's one object (`FABRIKA_APPLICATION`), as a fetch. */
function applicationObject(env: Readonly<Record<string, unknown>>): (request: Request) => Promise<Response> {
	const namespace = env[CLOUDFLARE_APPLICATION_BINDING]
	const idFromName = method(namespace, 'idFromName')
	const get = method(namespace, 'get')
	if (idFromName === null || get === null) {
		throw new Error(`the ${CLOUDFLARE_APPLICATION_BINDING} binding is missing; the provider binds the application's Durable Object to its Worker`)
	}
	const stub: unknown = get(idFromName(APPLICATION_OBJECT_NAME))
	// Read, not tested with `in`: a stub answers `fetch` without owning the property.
	const fetchObject: unknown = typeof stub === 'object' && stub !== null ? Reflect.get(stub, 'fetch') : undefined
	if (typeof fetchObject !== 'function') {
		throw new Error(`the ${CLOUDFLARE_APPLICATION_BINDING} binding answered no object`)
	}
	return async (request) => {
		const response: unknown = await Reflect.apply(fetchObject, stub, [request])
		if (!(response instanceof Response)) {
			throw new Error("the application's object answered something that is not a Response")
		}
		return response
	}
}

export interface ContractWorker {
	fetch(request: Request, env: Readonly<Record<string, unknown>>, exec: CloudflareExecutionContext): Promise<Response>
	scheduled(controller: CloudflareScheduledController, env: Readonly<Record<string, unknown>>, exec: CloudflareExecutionContext): Promise<void>
}

/**
 * The Worker module of a contract application, called only by the generated entrypoint, which also exports
 * `FabrikaApplication`. The application runs in the environment's one Durable Object (ADR-0065): `fetch` forwards
 * every request to it with the proxy secret, the proxy's own headers unchanged, and `scheduled` forwards the minute
 * tick. The object captures the environment, imports the application and boots it.
 */
export function createContractWorker(load: ImplementationLoader, options: ContractWorkerOptions = {}): ContractWorker {
	registerApplication(load, options)
	return {
		async fetch(request, env) {
			const headers = new Headers(request.headers)
			headers.delete(TICK_HEADER)
			headers.set(PROXY_SECRET_HEADER, proxySecretOf(env))
			return await applicationObject(env)(new Request(request, { headers }))
		},
		async scheduled(controller, env) {
			const tick = new Request('https://application.invalid/', {
				method: 'POST',
				headers: { [PROXY_SECRET_HEADER]: proxySecretOf(env), [TICK_HEADER]: String(controller.scheduledTime) },
			})
			const response = await applicationObject(env)(tick)
			if (!response.ok) {
				throw new Error(`the application's object answered the minute tick with ${response.status}`)
			}
		},
	}
}
