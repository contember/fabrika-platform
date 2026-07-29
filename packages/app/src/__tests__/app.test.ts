import type { AuthContext } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineApp } from '../app.js'
import { NotFoundError } from '../errors.js'
import type { Middleware } from '../middleware.js'
import { route } from '../router.js'
import type { Route } from '../router.js'
import { initRpc } from '../rpc/builder.js'
import { fakeAuth, fakeExec, getRequest, jsonRequest, raise, record } from './helpers.js'

type Env = Record<string, never>

interface Ctx {
	auth?: AuthContext
}

const env: Env = {}

describe('defineApp — middleware', () => {
	test('runs middleware in declared order around the handler', async () => {
		const events: string[] = []
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			middleware: () => [
				async (_req, _ctx, next) => {
					events.push('A:before')
					const res = await next()
					events.push('A:after')
					return res
				},
				async (_req, _ctx, next) => {
					events.push('B:before')
					const res = await next()
					events.push('B:after')
					return res
				},
			],
			routes: [
				route.get('/x', () => {
					events.push('handler')
					return new Response('ok')
				}),
			],
		})
		await app.fetch(getRequest('https://x/x'), env, fakeExec())
		expect(events).toEqual(['A:before', 'B:before', 'handler', 'B:after', 'A:after'])
	})

	test('middleware can wrap next() and append a Set-Cookie', async () => {
		const cookieMw: Middleware<Ctx> = async (_req, _ctx, next) => {
			const res = await next()
			const out = new Response(res.body, res)
			out.headers.append('set-cookie', 'sid=abc')
			return out
		}
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			middleware: () => [cookieMw],
			routes: [route.get('/c', () => new Response('hi'))],
		})
		const res = await app.fetch(getRequest('https://x/c'), env, fakeExec())
		expect(res.headers.get('set-cookie')).toBe('sid=abc')
		expect(await res.text()).toBe('hi')
	})

	test('middleware can short-circuit without calling next()', async () => {
		let handlerRan = false
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			middleware: () => [async () => new Response('blocked', { status: 401 })],
			routes: [
				route.get('/x', () => {
					handlerRan = true
					return new Response('ok')
				}),
			],
		})
		const res = await app.fetch(getRequest('https://x/x'), env, fakeExec())
		expect(res.status).toBe(401)
		expect(handlerRan).toBe(false)
	})
})

describe('defineApp — ctx.auth from middleware + rpc require', () => {
	const rpc = initRpc<{ auth: AuthContext }>()
	const apiRouter = rpc.router({
		secret: rpc.procedure.input(z.object({})).require('read:secret').handler(() => ({ ok: true })),
	})

	function appWithAuth(allowed: ReadonlyArray<string>) {
		const authMw: Middleware<Ctx> = async (_req, ctx, next) => {
			ctx.auth = fakeAuth(allowed)
			return next()
		}
		return defineApp<Env, Ctx>({
			context: () => ({}),
			middleware: () => [authMw],
			routes: [route.rpc('/api/rpc', apiRouter)],
		})
	}

	test('auth set by middleware is visible to .require (allow)', async () => {
		const res = await appWithAuth(['read:secret']).fetch(
			jsonRequest('https://x/api/rpc', { method: 'secret', input: {} }),
			env,
			fakeExec(),
		)
		expect(res.status).toBe(200)
		expect(record(record(await res.json())['result'])['ok']).toBe(true)
	})

	test('auth set by middleware is visible to .require (deny → 403)', async () => {
		const res = await appWithAuth([]).fetch(
			jsonRequest('https://x/api/rpc', { method: 'secret', input: {} }),
			env,
			fakeExec(),
		)
		expect(res.status).toBe(403)
		expect(record(record(await res.json())['error'])['type']).toBe('forbidden')
	})
})

describe('defineApp — route-scoped middleware (opts.use)', () => {
	test('route.use runs after the global chain, around the handler', async () => {
		const events: string[] = []
		const global: Middleware<Ctx> = async (_req, _ctx, next) => {
			events.push('global:before')
			const res = await next()
			events.push('global:after')
			return res
		}
		const scoped: Middleware<Ctx> = async (_req, _ctx, next) => {
			events.push('scoped:before')
			const res = await next()
			events.push('scoped:after')
			return res
		}
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			middleware: () => [global],
			routes: [
				route.get('/x', () => {
					events.push('handler')
					return new Response('ok')
				}, { use: [scoped] }),
			],
		})
		await app.fetch(getRequest('https://x/x'), env, fakeExec())
		expect(events).toEqual(['global:before', 'scoped:before', 'handler', 'scoped:after', 'global:after'])
	})

	test('route.use can short-circuit, and only affects its own route', async () => {
		const gate: Middleware<Ctx> = async () => new Response('nope', { status: 404 })
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			routes: [
				route.get('/gated', () => new Response('secret'), { use: [gate] }),
				route.get('/open', () => new Response('public')),
			],
		})
		const gated = await app.fetch(getRequest('https://x/gated'), env, fakeExec())
		expect(gated.status).toBe(404)
		expect(await gated.text()).toBe('nope')
		const open = await app.fetch(getRequest('https://x/open'), env, fakeExec())
		expect(open.status).toBe(200)
		expect(await open.text()).toBe('public')
	})

	test('route.use can set ctx.auth visible to an rpc .require on that route', async () => {
		const rpc = initRpc<{ auth: AuthContext }>()
		const shareRouter = rpc.router({
			read: rpc.procedure.input(z.object({})).require('report.read').handler(() => ({ ok: true })),
		})
		const capMw: Middleware<Ctx> = async (_req, ctx, next) => {
			ctx.auth = fakeAuth(['report.read'])
			return next()
		}
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			routes: [route.rpc('/s/rpc', shareRouter, { use: [capMw] })],
		})
		const res = await app.fetch(jsonRequest('https://x/s/rpc', { method: 'read', input: {} }), env, fakeExec())
		expect(res.status).toBe(200)
		expect(record(record(await res.json())['result'])['ok']).toBe(true)
	})
})

describe('defineApp — routing fallbacks', () => {
	function createTestApp(routes: Route<Ctx>[], withAssets: boolean) {
		return defineApp<Env, Ctx>({
			context: () => ({}),
			routes,
			...(withAssets ? { assets: () => ({ fetch: async () => new Response('asset-content', { status: 200 }) }) } : {}),
		})
	}

	test('unmatched GET falls through to assets', async () => {
		const res = await createTestApp([], true).fetch(getRequest('https://x/app/page'), env, fakeExec())
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('asset-content')
	})

	test('unmatched request without assets → 404 JSON', async () => {
		const res = await createTestApp([], false).fetch(getRequest('https://x/missing'), env, fakeExec())
		expect(res.status).toBe(404)
		expect(record(record(await res.json())['error'])['type']).toBe('not_found')
	})

	test('unmatched non-GET never hits assets → 404 JSON', async () => {
		const res = await createTestApp([], true).fetch(new Request('https://x/missing', { method: 'POST' }), env, fakeExec())
		expect(res.status).toBe(404)
	})
})

describe('defineApp — error mapping', () => {
	test('thrown HttpError maps to its status + structural body', async () => {
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			routes: [
				route.get('/boom', () => {
					throw new NotFoundError('no such thing')
				}),
			],
		})
		const res = await app.fetch(getRequest('https://x/boom'), env, fakeExec())
		expect(res.status).toBe(404)
		const error = record(record(await res.json())['error'])
		expect(error['type']).toBe('not_found')
		expect(error['message']).toBe('no such thing')
	})

	test('thrown structural plain object maps via httpStatus/type', async () => {
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			routes: [
				route.get('/teapot', () => raise({ httpStatus: 418, type: 'teapot', message: 'short and stout' })),
			],
		})
		const res = await app.fetch(getRequest('https://x/teapot'), env, fakeExec())
		expect(res.status).toBe(418)
		const error = record(record(await res.json())['error'])
		expect(error['type']).toBe('teapot')
		expect(error['message']).toBe('short and stout')
	})

	test('a custom onError is used when provided', async () => {
		const app = defineApp<Env, Ctx>({
			context: () => ({}),
			onError: () => new Response('custom', { status: 503 }),
			routes: [
				route.get('/boom', () => {
					throw new Error('kaboom')
				}),
			],
		})
		const res = await app.fetch(getRequest('https://x/boom'), env, fakeExec())
		expect(res.status).toBe(503)
		expect(await res.text()).toBe('custom')
	})
})
