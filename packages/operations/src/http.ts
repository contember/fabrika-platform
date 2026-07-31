import { operationsApp, type OperationsAppEnv } from './app.js'

export type OperationsHttpEnv = OperationsAppEnv

/**
 * Compatibility adapter for callers that own no runtime execution context. Production entrypoints
 * pass their native context to `operationsApp` directly.
 */
export function createOperationsFetchHandler(env: OperationsHttpEnv): (request: Request) => Promise<Response> {
	return (request) =>
		operationsApp.fetch(request, env, {
			waitUntil(promise) {
				void promise.catch(() => console.error('operations background task failed'))
			},
		})
}
