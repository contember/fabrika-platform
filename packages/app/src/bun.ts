// ─── Bun process adapter ─────────────────────────────────────────────
//
// A long-running Bun process needs only request dispatch and explicit draining.
// It does not emulate Worker cron, queues, or passThroughOnException().

import type { FabrikaApp, RequestExecutionContext } from './app.js'

export interface ManagedBunHandlerOptions {
	/** Required sink for rejected background tasks. Do not log raw errors or secret-bearing values. */
	onBackgroundError(error: unknown): void
	executionContext?: never
}

export interface ExternalBunHandlerOptions {
	/** Existing supervised process context. Its owner remains responsible for draining it. */
	executionContext: RequestExecutionContext
	onBackgroundError?: never
}

export type BunHandlerOptions = ManagedBunHandlerOptions | ExternalBunHandlerOptions

export interface BunHandler {
	fetch(request: Request): Promise<Response>
	/** Wait until every task registered through `waitUntil()` has settled. */
	drain(): Promise<void>
}

export function createBunHandler<Env>(app: FabrikaApp<Env>, env: Env, options: BunHandlerOptions): BunHandler {
	if (options.executionContext !== undefined) {
		return {
			fetch: (request) => app.fetch(request, env, options.executionContext),
			drain: () => Promise.resolve(),
		}
	}

	const pending = new Set<Promise<void>>()

	const exec: RequestExecutionContext = {
		waitUntil(promise) {
			const tracked = promise.then(
				() => undefined,
				(error) => {
					try {
						options.onBackgroundError(error)
					} catch {
						// Draining must remain reliable even if the reporting hook fails.
					}
				},
			)
			pending.add(tracked)
			void tracked.then(() => pending.delete(tracked))
		},
	}

	return {
		fetch: (request) => app.fetch(request, env, exec),
		async drain() {
			while (pending.size > 0) {
				await Promise.all(pending)
			}
		},
	}
}
