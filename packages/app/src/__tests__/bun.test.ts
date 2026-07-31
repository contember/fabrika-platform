import { describe, expect, test } from 'bun:test'
import { defineApp, type RequestExecutionContext } from '../app.js'
import { createBunHandler } from '../bun.js'
import { route } from '../router.js'
import { initRpc } from '../rpc/builder.js'
import type { StandardSchemaV1 } from '../standard-schema.js'
import { record } from './helpers.js'

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => {
		throw new Error('deferred promise was not initialized')
	}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('createBunHandler', () => {
	test('dispatches through the runtime-neutral app pipeline', async () => {
		const app = defineApp<{ value: string }, { value: string }>({
			context: (env) => ({ value: env.value }),
			routes: [route.get('/value', (ctx) => new Response(ctx.value))],
		})
		const handler = createBunHandler(app, { value: 'from-env' }, { onBackgroundError() {} })

		const response = await handler.fetch(new Request('https://app.test/value'))
		expect(await response.text()).toBe('from-env')
	})

	test('can use a process-owned execution context', async () => {
		let registered = false
		const app = defineApp<Record<string, never>, { exec: RequestExecutionContext }>({
			context: (_env, _request, exec) => ({ exec }),
			routes: [
				route.get('/work', (ctx) => {
					ctx.exec.waitUntil(Promise.resolve())
					return new Response('accepted')
				}),
			],
		})
		const handler = createBunHandler(app, {}, {
			executionContext: {
				waitUntil() {
					registered = true
				},
			},
		})

		await handler.fetch(new Request('https://app.test/work'))
		expect(registered).toBe(true)
		await expect(handler.drain()).resolves.toBeUndefined()
	})

	test('uses the same RPC wire protocol as the Worker adapter', async () => {
		const rpc = initRpc<{ prefix: string }>()
		const inputSchema: StandardSchemaV1<unknown, { name: string }> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: (input) =>
					typeof input === 'object' && input !== null && 'name' in input && typeof input.name === 'string'
						? { value: { name: input.name } }
						: { issues: [{ message: 'name is required' }] },
			},
		}
		const router = rpc.router({
			greet: rpc.procedure.input(inputSchema).query(({ ctx, input }) => `${ctx.prefix} ${input.name}`),
		})
		const app = defineApp<{ prefix: string }, { prefix: string }>({
			context: (env) => env,
			routes: [route.rpc('/rpc', router)],
		})
		const handler = createBunHandler(app, { prefix: 'Hello' }, { onBackgroundError() {} })
		const response = await handler.fetch(
			new Request('https://app.test/rpc', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: 'greet', input: { name: 'Ada' } }),
			}),
		)

		expect(response.status).toBe(200)
		expect(record(await response.json())['result']).toBe('Hello Ada')
	})

	test('drain waits for work registered through waitUntil', async () => {
		const background = deferred()
		const events: string[] = []
		const app = defineApp<Record<string, never>, { waitUntil(promise: Promise<unknown>): void }>({
			context: (_env, _request, exec) => exec,
			routes: [
				route.get('/work', (ctx) => {
					ctx.waitUntil(background.promise.then(() => events.push('background')))
					return new Response('accepted', { status: 202 })
				}),
			],
		})
		const handler = createBunHandler(app, {}, { onBackgroundError() {} })

		const response = await handler.fetch(new Request('https://app.test/work'))
		expect(response.status).toBe(202)
		let drained = false
		const draining = handler.drain().then(() => {
			drained = true
		})
		await Promise.resolve()
		expect(drained).toBe(false)

		background.resolve()
		await draining
		expect(events).toEqual(['background'])
		expect(drained).toBe(true)
	})

	test('reports a rejected background task and still drains', async () => {
		const errors: unknown[] = []
		const failure = new Error('background failed')
		const app = defineApp<Record<string, never>, { waitUntil(promise: Promise<unknown>): void }>({
			context: (_env, _request, exec) => exec,
			routes: [
				route.get('/work', (ctx) => {
					ctx.waitUntil(Promise.reject(failure))
					return new Response('accepted')
				}),
			],
		})
		const handler = createBunHandler(app, {}, { onBackgroundError: (error) => errors.push(error) })

		await handler.fetch(new Request('https://app.test/work'))
		await handler.drain()
		expect(errors).toEqual([failure])
	})

	test('a failing error hook cannot prevent draining', async () => {
		const app = defineApp<Record<string, never>, { waitUntil(promise: Promise<unknown>): void }>({
			context: (_env, _request, exec) => exec,
			routes: [
				route.get('/work', (ctx) => {
					ctx.waitUntil(Promise.reject(new Error('background failed')))
					return new Response('accepted')
				}),
			],
		})
		const handler = createBunHandler(app, {}, {
			onBackgroundError() {
				throw new Error('reporting failed')
			},
		})

		await handler.fetch(new Request('https://app.test/work'))
		await expect(handler.drain()).resolves.toBeUndefined()
	})
})
