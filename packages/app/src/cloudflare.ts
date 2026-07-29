// ─── Cloudflare Workers adapter ──────────────────────────────────────

import type { FabrikaApp, RequestExecutionContext } from './app.js'

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
