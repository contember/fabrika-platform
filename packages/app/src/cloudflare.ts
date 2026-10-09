// ─── Cloudflare Workers adapter ──────────────────────────────────────

import { DecodedIamMembership } from '@fabrika/auth'
import type { IamMembershipRpc } from '@fabrika/auth-core'
import { parseJwks } from '@fabrika/jwks'
import type { FabrikaApp, RequestExecutionContext } from './app.js'
import { boot, type ContractApp, type IamKeySource } from './implement/boot.js'
import { CONNECT_BINDING_PREFIX, type ConnectFetch } from './implement/connect.js'
import type { SpaAssets } from './implement/dispatch.js'
import { captureEnvironment } from './implement/environment.js'
import type { ContractImplementation } from './implement/implement.js'

export { markProductionProcess } from '@fabrika/db/production'

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

/**
 * IAM's membership operations on the `IAM` binding (`PropustkaApplication`), every answer decoded like the HTTP
 * transport's. A binding without them is no membership transport, and `boot` refuses a contract that needs one.
 */
function bindingMembership(binding: unknown): IamMembershipRpc | undefined {
	const methods = ['requestDelegation', 'createScope', 'assignMember', 'revokeMember', 'listMembers', 'issueLink', 'revokeLink'] as const
	if (!methods.every((name) => method(binding, name) !== null)) {
		return undefined
	}
	return new DecodedIamMembership(async (name, input) => {
		const call = method(binding, name)
		if (call === null) {
			throw new Error(`the IAM binding has no ${name}`)
		}
		return await call(input)
	})
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
 * The service bindings to owners' proxy Workers (`FABRIKA_CONNECT_<IMPORT>`), which `captureEnvironment` keeps from
 * the application because no `FABRIKA_*` value reaches it. A binding routes by itself: the URL it is called with
 * carries the owner's host, which the proxy Worker selects the application by.
 */
function connectBindings(env: Readonly<Record<string, unknown>>): Record<string, ConnectFetch> {
	const bindings: Record<string, ConnectFetch> = {}
	for (const [name, binding] of Object.entries(env)) {
		// Read, not tested with `in`: a binding stub may answer `fetch` without owning the property (Lopata's does not).
		const fetchOwner: unknown = name.startsWith(CONNECT_BINDING_PREFIX) && typeof binding === 'object' && binding !== null
			? Reflect.get(binding, 'fetch')
			: undefined
		if (typeof fetchOwner === 'function') {
			bindings[name] = async (request) => {
				const response: unknown = await Reflect.apply(fetchOwner, binding, [request])
				if (!(response instanceof Response)) {
					throw new Error(`the ${name} binding answered something that is not a Response`)
				}
				return response
			}
		}
	}
	return bindings
}

/** The application module, imported only after the environment was captured: the generated entrypoint's `import()`. */
export type ImplementationLoader = () => Promise<{ readonly default: ContractImplementation }>

/**
 * A Worker module for a contract application, called only by the generated entrypoint. A Worker receives its
 * environment with the first request, so the framework captures it, scrubs the process environment and only then
 * imports the application and boots it, once per environment object.
 */
export function createContractWorker(load: ImplementationLoader): {
	fetch(request: Request, env: Readonly<Record<string, unknown>>, exec: CloudflareExecutionContext): Promise<Response>
} {
	const booted = new WeakMap<object, Promise<ContractApp>>()
	const bootFor = async (env: Readonly<Record<string, unknown>>): Promise<ContractApp> => {
		const variables = Object.fromEntries(Object.entries(env).filter(([name]) => !FRAMEWORK_BINDINGS.has(name)))
		const environment = captureEnvironment(variables)
		const { default: app } = await load()
		return boot(app, {
			environment,
			iam: bindingKeySource(env['IAM']),
			assets: bindingAssets(env['ASSETS']),
			membership: bindingMembership(env['IAM']),
			connectBindings: connectBindings(env),
		})
	}
	return {
		async fetch(request, env) {
			let contractApp = booted.get(env)
			if (contractApp === undefined) {
				contractApp = bootFor(env)
				booted.set(env, contractApp)
				// A failed boot is not cached: the next request boots again and fails with the same problems.
				contractApp.catch(() => booted.delete(env))
			}
			return (await contractApp).fetch(request)
		},
	}
}
