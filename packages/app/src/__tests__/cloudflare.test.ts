import { describe, expect, test } from 'bun:test'
import { type CloudflareExecutionContext, createCloudflareWorker } from '../cloudflare.js'
import type { FetchService } from '../fetch.js'

type Env = Record<string, never>

const env: Env = {}
const exec: CloudflareExecutionContext = {
	waitUntil() {},
	passThroughOnException() {},
}

describe('createCloudflareWorker', () => {
	test('serves a runtime-neutral service', async () => {
		const app: FetchService<Env> = { fetch: async () => new Response('ok') }
		const worker = createCloudflareWorker(app)

		const response = await worker.fetch(new Request('https://app.test/healthz'), env, exec)

		expect(await response.text()).toBe('ok')
	})

	test('exposes scheduled when configured', async () => {
		let ran = false
		const app: FetchService<Env> = { fetch: async () => new Response('not found', { status: 404 }) }
		const worker = createCloudflareWorker(app, {
			scheduled: async () => {
				ran = true
			},
		})

		expect(typeof worker.scheduled).toBe('function')
		await worker.scheduled?.({ scheduledTime: 0, cron: '* * * * *', noRetry() {} }, env, exec)
		expect(ran).toBe(true)
	})

	test('exposes queue when configured', async () => {
		let ran = false
		const app: FetchService<Env> = { fetch: async () => new Response('not found', { status: 404 }) }
		const worker = createCloudflareWorker(app, {
			queue: async () => {
				ran = true
			},
		})

		expect(typeof worker.queue).toBe('function')
		await worker.queue?.({ queue: 'q', messages: [] }, env, exec)
		expect(ran).toBe(true)
	})

	test('omits lifecycle handlers when they are not configured', () => {
		const app: FetchService<Env> = { fetch: async () => new Response('not found', { status: 404 }) }
		const worker = createCloudflareWorker(app)

		expect(worker.scheduled).toBeUndefined()
		expect(worker.queue).toBeUndefined()
	})
})
