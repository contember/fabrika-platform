import type { FabrikaApp, RequestExecutionContext } from './app.js'
import { createBunHandler } from './bun.js'
import { type CloudflareExecutionContext, createCloudflareWorker } from './cloudflare.js'

export type AppTestRuntime = 'direct' | 'bun' | 'cloudflare'

export interface NormalizedAppResponse {
	readonly status: number
	readonly headers: ReadonlyArray<readonly [name: string, value: string]>
	readonly body: string
}

export interface AppRuntimeResponses {
	readonly direct: NormalizedAppResponse
	readonly bun: NormalizedAppResponse
	readonly cloudflare: NormalizedAppResponse
}

export interface AppRuntimeConformanceOptions<Env> {
	readonly app: FabrikaApp<Env>
	/** Create isolated runtime state so one execution cannot affect the next. */
	readonly createEnv: () => Env | Promise<Env>
	/** Create an equivalent fresh request for each runtime. */
	readonly createRequest: () => Request
	/** Optional sink for rejected background work. */
	readonly onBackgroundError?: (runtime: AppTestRuntime, error: unknown) => void
}

interface TrackedExecution {
	readonly context: RequestExecutionContext
	drain(): Promise<void>
}

function trackedExecution(onBackgroundError: (error: unknown) => void): TrackedExecution {
	const pending = new Set<Promise<void>>()
	const waitUntil = (promise: Promise<unknown>): void => {
		const tracked = promise.then(
			() => undefined,
			(error) => {
				try {
					onBackgroundError(error)
				} catch {
					// Reporting failures must not prevent the conformance run from draining.
				}
			},
		)
		pending.add(tracked)
		void tracked.then(() => pending.delete(tracked))
	}
	return {
		context: { waitUntil },
		async drain() {
			while (pending.size > 0) {
				await Promise.all(pending)
			}
		},
	}
}

/** Convert a Fetch response into a deterministic value suitable for equality checks. */
export async function normalizeAppResponse(response: Response): Promise<NormalizedAppResponse> {
	const headers: Array<readonly [name: string, value: string]> = []
	response.headers.forEach((value, name) => headers.push([name, value]))
	headers.sort(([left], [right]) => left.localeCompare(right))
	return {
		status: response.status,
		headers,
		body: await response.text(),
	}
}

async function runDirect<Env>(options: AppRuntimeConformanceOptions<Env>): Promise<NormalizedAppResponse> {
	const execution = trackedExecution((error) => options.onBackgroundError?.('direct', error))
	const env = await options.createEnv()
	const request = options.createRequest()
	const response = await options.app.fetch(request, env, execution.context)
	await execution.drain()
	return normalizeAppResponse(response)
}

async function runBun<Env>(options: AppRuntimeConformanceOptions<Env>): Promise<NormalizedAppResponse> {
	const handler = createBunHandler(options.app, await options.createEnv(), {
		onBackgroundError: (error) => options.onBackgroundError?.('bun', error),
	})
	const response = await handler.fetch(options.createRequest())
	await handler.drain()
	return normalizeAppResponse(response)
}

async function runCloudflare<Env>(options: AppRuntimeConformanceOptions<Env>): Promise<NormalizedAppResponse> {
	const execution = trackedExecution((error) => options.onBackgroundError?.('cloudflare', error))
	const context: CloudflareExecutionContext = {
		waitUntil: execution.context.waitUntil,
		passThroughOnException() {},
	}
	const env = await options.createEnv()
	const request = options.createRequest()
	const response = await createCloudflareWorker(options.app).fetch(request, env, context)
	await execution.drain()
	return normalizeAppResponse(response)
}

/** Execute one request through every supported HTTP adapter. */
export async function runAppRuntimeConformance<Env>(options: AppRuntimeConformanceOptions<Env>): Promise<AppRuntimeResponses> {
	const direct = await runDirect(options)
	const bun = await runBun(options)
	const cloudflare = await runCloudflare(options)
	return { direct, bun, cloudflare }
}

/** Assert adapter parity without coupling application packages to a specific test runner. */
export async function assertAppRuntimeConformance<Env>(options: AppRuntimeConformanceOptions<Env>): Promise<NormalizedAppResponse> {
	const responses = await runAppRuntimeConformance(options)
	const direct = JSON.stringify(responses.direct)
	if (JSON.stringify(responses.bun) !== direct || JSON.stringify(responses.cloudflare) !== direct) {
		throw new Error(`application runtime responses differ: ${JSON.stringify(responses)}`)
	}
	return responses.direct
}
