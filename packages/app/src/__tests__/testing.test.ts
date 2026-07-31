import { describe, expect, test } from 'bun:test'
import { defineApp } from '../app.js'
import { route } from '../router.js'
import { assertAppRuntimeConformance, normalizeAppResponse, runAppRuntimeConformance } from '../testing.js'

describe('application runtime conformance', () => {
	test('normalizes status, headers, and body', async () => {
		const normalized = await normalizeAppResponse(
			new Response('created', {
				status: 201,
				headers: { 'X-Second': 'two', 'X-First': 'one' },
			}),
		)

		expect(normalized).toEqual({
			status: 201,
			headers: [
				['x-first', 'one'],
				['x-second', 'two'],
			],
			body: 'created',
		})
	})

	test('executes fresh state and requests through all adapters', async () => {
		let environments = 0
		let requests = 0
		let completedTasks = 0
		const app = defineApp<{ prefix: string }, { request: Request; prefix: string; exec: { waitUntil(promise: Promise<unknown>): void } }>({
			context: (env, request, exec) => ({ request, prefix: env.prefix, exec }),
			routes: [route.post('/echo', async (ctx) => {
				ctx.exec.waitUntil(Promise.resolve().then(() => completedTasks++))
				return new Response(`${ctx.prefix}:${await ctx.request.text()}`, {
					status: 202,
					headers: { 'X-Adapter-Neutral': 'yes' },
				})
			})],
		})

		const responses = await runAppRuntimeConformance({
			app,
			createEnv: () => {
				environments++
				return { prefix: 'same' }
			},
			createRequest: () => {
				requests++
				return new Request('https://app.test/echo', { method: 'POST', body: 'body' })
			},
		})

		expect(responses.bun).toEqual(responses.direct)
		expect(responses.cloudflare).toEqual(responses.direct)
		expect(responses.direct).toMatchObject({ status: 202, body: 'same:body' })
		expect({ environments, requests, completedTasks }).toEqual({ environments: 3, requests: 3, completedTasks: 3 })
	})

	test('returns the common response when all adapters conform', async () => {
		const app = defineApp<Record<string, never>, Record<string, never>>({
			context: () => ({}),
			routes: [route.get('/healthz', () => Response.json({ status: 'ok' }))],
		})

		const response = await assertAppRuntimeConformance({
			app,
			createEnv: () => ({}),
			createRequest: () => new Request('https://app.test/healthz'),
		})

		expect(response.status).toBe(200)
		expect(response.body).toBe('{"status":"ok"}')
	})
})
