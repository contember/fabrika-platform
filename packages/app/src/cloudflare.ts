// ─── Cloudflare Workers adapter ──────────────────────────────────────

import { parseJwks } from '@fabrika/jwks'
import type { FabrikaApp, RequestExecutionContext } from './app.js'
import { boot, type ContractApp, type IamKeySource } from './implement/boot.js'
import type { SpaAssets } from './implement/dispatch.js'
import type { ContractImplementation } from './implement/implement.js'

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

/** Adapt a runtime-neutral Fabrika application to a Workers module export. */
export function createCloudflareWorker<Env>(
	app: FabrikaApp<Env>,
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

/** The framework's bindings: IAM's application entrypoint and the Workers Assets of the SPA. No handler sees them. */
const FRAMEWORK_BINDINGS: ReadonlySet<string> = new Set(['IAM', 'ASSETS'])

function method(target: unknown, name: string): ((...args: unknown[]) => unknown) | null {
	if (typeof target !== 'object' || target === null || !(name in target)) {
		return null
	}
	const found: unknown = Reflect.get(target, name)
	return typeof found === 'function' ? (...args) => Reflect.apply(found, target, args) : null
}

function bindingKeySource(binding: unknown): IamKeySource {
	const getJwks = method(binding, 'getJwks')
	if (getJwks === null) {
		throw new Error('the IAM binding is missing (env.IAM); the platform binds it to every application Worker')
	}
	return {
		async getJwks() {
			const jwks = parseJwks(await getJwks())
			if (jwks === null) {
				throw new Error('IAM returned no usable key set')
			}
			return jwks
		},
	}
}

function bindingAssets(binding: unknown): SpaAssets | undefined {
	const fetchAsset = method(binding, 'fetch')
	if (fetchAsset === null) {
		return undefined
	}
	return {
		async serve(_mount, request) {
			const response: unknown = await fetchAsset(request)
			if (!(response instanceof Response)) {
				throw new Error('the ASSETS binding answered something that is not a Response')
			}
			return response
		},
	}
}

/**
 * A Worker module for a contract application, called only by the generated entrypoint. A Worker receives its
 * environment with the first request, so `boot` runs then, once per environment object.
 */
export function createContractWorker(app: ContractImplementation): {
	fetch(request: Request, env: Readonly<Record<string, unknown>>, exec: CloudflareExecutionContext): Promise<Response>
} {
	const booted = new WeakMap<object, ContractApp>()
	const bootFor = (env: Readonly<Record<string, unknown>>): ContractApp => {
		const existing = booted.get(env)
		if (existing !== undefined) {
			return existing
		}
		const variables = Object.fromEntries(Object.entries(env).filter(([name]) => !FRAMEWORK_BINDINGS.has(name)))
		const contractApp = boot(app, { env: variables, iam: bindingKeySource(env['IAM']), assets: bindingAssets(env['ASSETS']) })
		booted.set(env, contractApp)
		return contractApp
	}
	return { fetch: (request, env) => bootFor(env).fetch(request) }
}
